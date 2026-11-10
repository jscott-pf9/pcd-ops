"""HTTPS certificate (APPLIANCE_STANDARD §7.9): nginx serves the app on 443 with the
certificate in <state dir>/tls, and port 80 either redirects to HTTPS or serves the app too.

Files in <state dir>/tls (0600, owned by pcd-ops; nginx's master process reads them as root):
  cert.pem       the certificate, then its chain
  key.pem        its private key, unencrypted
  http.conf      what port 80 does besides /api/health: redirect, or include the app
  pending.csr    a certificate signing request waiting for its certificate, and
  pending-key.pem  its key

At first boot `deploy/scripts/tls.sh ensure` (root, before nginx) makes a self-signed
certificate if there is none. Here, the Settings page shows the certificate, regenerates a
self-signed one, installs an uploaded one, makes a CSR, and sets the redirect; each change
reloads nginx (`sudo nginx -s reload`, allowed by /etc/sudoers.d/pcd-ops).
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import socket
import ssl
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from app.appliance import config_env, state

logger = logging.getLogger(__name__)

NGINX_CONF = Path("/etc/nginx/http.d/pcd-ops.conf")
APP_CONF = "/opt/pcd-ops/deploy/nginx/pcd-ops-app.conf"
SELF_SIGNED_DAYS = 730
HTTPS_PORT = 443

REDIRECT = """\
# Written by PCD Ops (Settings -> HTTPS): plain HTTP redirects to HTTPS.
location / {
    return 301 https://$host$request_uri;
}
"""
SERVE = f"""\
# Written by PCD Ops (Settings -> HTTPS): plain HTTP serves the app too.
include {APP_CONF};
"""

_LABEL = r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
_NAME = re.compile(rf"^(\*\.)?{_LABEL}(\.{_LABEL})*$", re.I)


class CertError(ValueError):
    """An uploaded certificate or key that can't be used, with why."""


def tls_dir() -> Path:
    d = state.state_dir() / "tls"
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


# ── What the appliance is called ────────────────────────────────────────────────

def valid_name(name: str) -> bool:
    """A DNS name (a leading *. allowed) or an IP address."""
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return len(name) <= 253 and bool(_NAME.match(name))


def default_names() -> list[str]:
    """The names a self-signed certificate covers: the host name, the instance name from
    config.env, and this machine's addresses (the one it reaches PCD from first)."""
    names = [socket.gethostname()]
    env = config_env.load()
    if env.get("PCD_INSTANCE_NAME"):
        names.append(env["PCD_INSTANCE_NAME"])
    names += _addresses(env.get("PCD_AUTH_URL", ""))
    out: list[str] = []
    for n in names:
        n = n.strip().lower()
        if n and valid_name(n) and n not in out and n != "localhost":
            out.append(n)
    return out


def _addresses(auth_url: str) -> list[str]:
    ips: list[str] = []
    # The source address towards PCD (a UDP "connect" sends nothing)
    host = re.sub(r"^\w+://|[:/].*$", "", auth_url) or "192.0.2.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((host, 443))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    return [ip for ip in ips if not ipaddress.ip_address(ip).is_loopback]


# ── Reading certificates ─────────────────────────────────────────────────────────

def _certs(pem: bytes | str) -> list[x509.Certificate]:
    data = pem.encode() if isinstance(pem, str) else pem
    try:
        certs = x509.load_pem_x509_certificates(data)
    except ValueError as e:
        raise CertError("That isn't a PEM certificate (-----BEGIN CERTIFICATE-----)") from e
    if not certs:
        raise CertError("No certificate found")
    return certs


def _key(pem: bytes | str):
    data = pem.encode() if isinstance(pem, str) else pem
    try:
        return serialization.load_pem_private_key(data, password=None)
    except TypeError as e:
        raise CertError("The key has a passphrase: upload it without one") from e
    except ValueError as e:
        raise CertError("That isn't a PEM private key (-----BEGIN PRIVATE KEY-----)") from e


def _pub(obj) -> bytes:
    key = obj.public_key()
    return key.public_bytes(serialization.Encoding.DER,
                            serialization.PublicFormat.SubjectPublicKeyInfo)


def _names(cert: x509.Certificate) -> list[str]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return []
    return ([str(n) for n in san.get_values_for_type(x509.DNSName)]
            + [str(n) for n in san.get_values_for_type(x509.IPAddress)])


def _cn(name: x509.Name) -> str:
    cns = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(cns[0].value) if cns else name.rfc4514_string()


def describe(cert_pem: bytes | str, now: datetime | None = None) -> dict:
    """What the Settings page shows about a certificate (the first in the PEM; the rest is its
    chain)."""
    certs = _certs(cert_pem)
    c, now = certs[0], now or datetime.now(timezone.utc)
    nb, na = c.not_valid_before_utc, c.not_valid_after_utc
    return {
        "subject": _cn(c.subject),
        "issuer": _cn(c.issuer),
        "names": _names(c),
        "self_signed": c.issuer == c.subject,
        "not_before": nb.isoformat(),
        "not_after": na.isoformat(),
        "days_left": (na - now).days,
        "expired": na <= now,
        "fingerprint_sha256": c.fingerprint(hashes.SHA256()).hex(":").upper(),
        "chain": len(certs) - 1,
        "key": _key_text(c.public_key()),
    }


def _key_text(pub) -> str:
    if isinstance(pub, rsa.RSAPublicKey):
        return f"RSA {pub.key_size}"
    if isinstance(pub, ec.EllipticCurvePublicKey):
        return f"EC {pub.curve.name}"
    return type(pub).__name__


def covers(names: list[str], host: str) -> bool:
    """Whether a certificate for `names` is valid for `host` (one-label wildcards)."""
    host = host.lower().strip("[]")
    for n in (x.lower() for x in names):
        if n == host or (n.startswith("*.") and "." in host and host.split(".", 1)[1] == n[2:]):
            return True
    return False


# ── Making and installing ─────────────────────────────────────────────────────────

def _san(names: list[str]) -> x509.SubjectAlternativeName:
    entries: list[x509.GeneralName] = []
    for n in names:
        try:
            entries.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            entries.append(x509.DNSName(n))
    return x509.SubjectAlternativeName(entries)


def _check_names(names: list[str]) -> list[str]:
    out = []
    for n in (x.strip().lower() for x in names):
        if not n or n in out:
            continue
        if not valid_name(n):
            raise CertError(f"{n} isn't a DNS name or IP address")
        out.append(n)
    if not out:
        raise CertError("The certificate needs at least one name or address")
    return out


def self_signed(names: list[str], days: int = SELF_SIGNED_DAYS) -> tuple[bytes, bytes]:
    """A self-signed server certificate for `names` (the first is its common name), and its
    key. RSA 2048 for the widest client support."""
    names = _check_names(names)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0][:64]),
                         x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PCD Ops")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject).issuer_name(subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=days))
        .add_extension(_san(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=True,
                                     content_commitment=False, data_encipherment=False,
                                     key_agreement=False, key_cert_sign=False, crl_sign=False,
                                     encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM), _key_pem(key)


def _key_pem(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def make_csr(names: list[str], organization: str = "") -> bytes:
    """A certificate signing request for `names`; its key waits in pending-key.pem for the
    signed certificate, replacing any earlier pending request."""
    names = _check_names(names)
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, names[0][:64])]
    if organization.strip():
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization.strip()[:64]))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (x509.CertificateSigningRequestBuilder().subject_name(x509.Name(attrs))
           .add_extension(_san(names), critical=False).sign(key, hashes.SHA256()))
    d = tls_dir()
    _write(d / "pending-key.pem", _key_pem(key))
    pem = csr.public_bytes(serialization.Encoding.PEM)
    _write(d / "pending.csr", pem)
    return pem


def pending() -> dict | None:
    """The CSR waiting for its certificate, if any."""
    path = tls_dir() / "pending.csr"
    if not path.exists():
        return None
    csr = x509.load_pem_x509_csr(path.read_bytes())
    try:
        names = _names(csr)  # type: ignore[arg-type]
    except Exception:
        names = []
    return {"subject": _cn(csr.subject), "names": names,
            "created": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()}


def discard_pending() -> None:
    d = tls_dir()
    for f in ("pending.csr", "pending-key.pem"):
        (d / f).unlink(missing_ok=True)


def prepare(cert_pem: str, key_pem: str | None) -> tuple[bytes, bytes, list[str]]:
    """Check an uploaded certificate (and chain) and key: the key must match the first
    certificate, which must be valid now. Without a key, the pending CSR's key is used.
    Returns (cert chain PEM, key PEM, warnings)."""
    certs = _certs(cert_pem)
    leaf, now = certs[0], datetime.now(timezone.utc)
    pending_key = tls_dir() / "pending-key.pem"
    if key_pem and key_pem.strip():
        key = _key(key_pem)
    elif pending_key.exists():
        key = _key(pending_key.read_bytes())
    else:
        raise CertError("Upload the private key too (there's no pending CSR whose key it "
                        "could use)")
    if _pub(key) != _pub(leaf):
        if not (key_pem and key_pem.strip()):
            raise CertError("This certificate wasn't made from the pending CSR: upload its key "
                            "too")
        raise CertError("The key doesn't belong to the certificate (the first one, if there are "
                        "several)")
    if leaf.not_valid_after_utc <= now:
        raise CertError(f"The certificate expired on {leaf.not_valid_after_utc:%Y-%m-%d}")
    if leaf.not_valid_before_utc > now:
        raise CertError(f"The certificate isn't valid until {leaf.not_valid_before_utc:%Y-%m-%d}")
    warnings = []
    for i, (c, nxt) in enumerate(zip(certs, certs[1:])):
        if c.issuer != nxt.subject:
            warnings.append(f"Chain certificate {i + 1} ({_cn(nxt.subject)}) didn't issue "
                            f"{_cn(c.subject)}: list the certificate first, then its issuers "
                            "in order")
    if not _names(leaf):
        warnings.append("It has no subject alternative names: browsers ignore the common name "
                        "and will reject it")
    if leaf.issuer == leaf.subject:
        warnings.append("It's self-signed: browsers warn until it's trusted on each computer")
    elif len(certs) == 1:
        warnings.append("No chain was included: browsers that don't already have the "
                        "intermediate certificate will warn")
    chain = b"".join(c.public_bytes(serialization.Encoding.PEM) for c in certs)
    return chain, _key_pem(key), warnings


def install(cert_chain: bytes, key: bytes) -> None:
    """Put a certificate and key in place (the old ones kept as *.prev) and reload nginx."""
    d = tls_dir()
    for f in ("cert.pem", "key.pem"):
        if (d / f).exists():
            _write(d / f"{f}.prev", (d / f).read_bytes())
    _write(d / "key.pem", key)
    _write(d / "cert.pem", cert_chain)
    if (d / "pending-key.pem").exists() and _pub(_key((d / "pending-key.pem").read_bytes())) \
            == _pub(_certs(cert_chain)[0]):
        discard_pending()
    reload_nginx()


def current() -> bytes | None:
    path = tls_dir() / "cert.pem"
    return path.read_bytes() if path.exists() else None


# ── nginx ───────────────────────────────────────────────────────────────────────

def https_enabled() -> bool:
    """Whether nginx on this appliance is set up for HTTPS (new images, or the console's
    Enable HTTPS on older ones)."""
    try:
        return "listen 443" in NGINX_CONF.read_text()
    except OSError:
        return False


def redirect() -> bool:
    """Whether plain HTTP redirects to HTTPS (the default)."""
    path = tls_dir() / "http.conf"
    return not path.exists() or "return 301" in path.read_text()


def set_redirect(on: bool) -> None:
    _write(tls_dir() / "http.conf", (REDIRECT if on else SERVE).encode())
    reload_nginx()


def reload_nginx() -> bool:
    """Ask nginx to reload its configuration and certificate. False where there is no nginx
    to reload (local development) or sudo refuses."""
    if not https_enabled():
        return False
    try:
        r = subprocess.run(["sudo", "-n", "/usr/sbin/nginx", "-s", "reload"],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.warning("nginx reload failed: %s", e)
        return False
    if r.returncode:
        logger.warning("nginx reload failed: %s", (r.stderr or r.stdout).strip())
    return r.returncode == 0


def served_fingerprint(timeout: float = 3.0) -> str | None:
    """The SHA-256 fingerprint of the certificate nginx is serving on 443 now, or None."""
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    try:
        with socket.create_connection(("127.0.0.1", HTTPS_PORT), timeout=timeout) as sock:
            with ctx.wrap_socket(sock) as tls:
                der = tls.getpeercert(binary_form=True)
    except OSError:
        return None
    return x509.load_der_x509_certificate(der).fingerprint(hashes.SHA256()).hex(":").upper()


def wait_served(fingerprint: str, seconds: float = 4.0) -> bool:
    """Whether nginx serves the certificate with `fingerprint` within a few seconds of a
    reload (it swaps workers gracefully)."""
    end = time.monotonic() + seconds
    while True:
        if served_fingerprint() == fingerprint:
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.5)


# ── Console and first boot (deploy/scripts/tls.sh runs these as pcd-ops) ───────────────

def ensure() -> str:
    """A self-signed certificate if there's none, and port 80's default (redirect). Doesn't
    reload nginx: at first boot it runs before nginx starts."""
    d, done = tls_dir(), []
    if not (d / "cert.pem").exists() or not (d / "key.pem").exists():
        chain, key = self_signed(default_names() or ["pcd-ops"])
        _write(d / "key.pem", key)
        _write(d / "cert.pem", chain)
        done.append("made a self-signed certificate")
    if not (d / "http.conf").exists():
        _write(d / "http.conf", REDIRECT.encode())
        done.append("HTTP redirects to HTTPS")
    return "; ".join(done) or "certificate already in place"


def regenerate() -> str:
    """A new self-signed certificate for this appliance's names (console). Doesn't reload."""
    chain, key = self_signed(default_names() or ["pcd-ops"])
    d = tls_dir()
    for f in ("cert.pem", "key.pem"):
        if (d / f).exists():
            _write(d / f"{f}.prev", (d / f).read_bytes())
    _write(d / "key.pem", key)
    _write(d / "cert.pem", chain)
    return "made a new self-signed certificate for " + ", ".join(describe(chain)["names"])


def show() -> str:
    pem = current()
    if not pem:
        return "No certificate yet."
    i = describe(pem)
    return "\n".join([
        f"Certificate:  {i['subject']}{' (self-signed)' if i['self_signed'] else ''}",
        f"Covers:       {', '.join(i['names']) or '-'}",
        f"Issuer:       {i['issuer']}",
        f"Valid until:  {i['not_after'][:10]} "
        f"({'EXPIRED' if i['expired'] else str(i['days_left']) + ' days left'})",
        f"HTTP:         {'redirects to HTTPS' if redirect() else 'serves the app too'}",
    ])


if __name__ == "__main__":
    import sys

    actions = {"ensure": ensure, "regenerate": regenerate, "show": show}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        sys.exit(f"usage: python -m app.appliance.tls {'|'.join(actions)}")
    print(actions[sys.argv[1]]())
