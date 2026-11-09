"""HTTPS certificate (app/appliance/tls.py), its API and the expiry alert."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app.appliance import tls
from app.services import db
from tests.conftest import CSRF


def _ca(cn="Test CA"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return cert, key


def _signed(ca, public_key, names, days=90, start=-1):
    ca_cert, ca_key = ca
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
        .issuer_name(ca_cert.subject)
        .public_key(public_key)
        .serial_number(2)
        .not_valid_before(now + timedelta(days=start))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM)


def _pem(c):
    return c.public_bytes(serialization.Encoding.PEM)


@pytest.fixture
def nginx(tmp_path, monkeypatch):
    """An appliance with HTTPS set up; records reloads instead of running sudo."""
    conf = tmp_path / "pcd-ops.conf"
    conf.write_text("server { listen 443 ssl; }")
    monkeypatch.setattr(tls, "NGINX_CONF", conf)
    reloads = []
    monkeypatch.setattr(
        tls.subprocess,
        "run",
        lambda cmd, **kw: (reloads.append(cmd), type("R", (), {"returncode": 0})())[1],
    )
    monkeypatch.setattr(tls, "wait_served", lambda fp, seconds=4.0: True)
    return reloads


def test_self_signed_certificate():
    chain, key = tls.self_signed(["PCD-Ops.example", "10.0.0.5"])
    d = tls.describe(chain)
    assert d["subject"] == "pcd-ops.example" and d["self_signed"] and d["chain"] == 0
    assert d["names"] == ["pcd-ops.example", "10.0.0.5"] and d["key"] == "RSA 2048"
    assert 728 <= d["days_left"] <= 730 and not d["expired"]
    assert tls.prepare(chain.decode(), key.decode())[2] == [
        "It's self-signed: browsers warn until it's trusted on each computer"
    ]
    with pytest.raises(tls.CertError, match="isn't a DNS name"):
        tls.self_signed(["bad name!"])


def test_covers_names_and_wildcards():
    assert tls.covers(["ops.example.com", "10.0.0.5"], "10.0.0.5")
    assert tls.covers(["*.example.com"], "ops.example.com")
    assert not tls.covers(["*.example.com"], "a.b.example.com")
    assert not tls.covers(["ops.example.com"], "10.0.0.5")


def test_upload_checks():
    ca = _ca()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_pem = tls._key_pem(key).decode()
    leaf = _signed(ca, key.public_key(), ["ops.example.com"])
    chain, _, warnings = tls.prepare((leaf + _pem(ca[0])).decode(), key_pem)
    assert warnings == [] and tls.describe(chain)["chain"] == 1
    assert "No chain was included" in tls.prepare(leaf.decode(), key_pem)[2][0]
    # Chain in the wrong order: the "intermediate" didn't issue the leaf
    other = _ca("Other CA")
    assert "didn't issue" in tls.prepare((leaf + _pem(other[0])).decode(), key_pem)[2][0]
    with pytest.raises(tls.CertError, match="doesn't belong"):
        tls.prepare(leaf.decode(), tls._key_pem(other[1]).decode())
    with pytest.raises(tls.CertError, match="expired"):
        tls.prepare(
            _signed(ca, key.public_key(), ["x.example"], days=-1, start=-10).decode(), key_pem
        )
    with pytest.raises(tls.CertError, match="isn't a PEM certificate"):
        tls.prepare("hello", key_pem)
    locked = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.BestAvailableEncryption(b"pw"),
    ).decode()
    with pytest.raises(tls.CertError, match="passphrase"):
        tls.prepare(leaf.decode(), locked)
    with pytest.raises(tls.CertError, match="Upload the private key"):
        tls.prepare(leaf.decode(), None)


def test_csr_then_certificate_without_key(nginx):
    csr = x509.load_pem_x509_csr(tls.make_csr(["ops.example.com", "10.0.0.5"], "Acme"))
    assert tls.pending()["names"] == ["ops.example.com", "10.0.0.5"]
    ca = _ca()
    leaf = _signed(ca, csr.public_key(), ["ops.example.com"])
    chain, key, _ = tls.prepare(leaf.decode(), None)  # the pending key is used
    tls.install(chain, key)
    assert tls.pending() is None and nginx  # matched: pending cleared, reloaded
    # A certificate from some other key, without its key, says so
    tls.make_csr(["x.example"])
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(tls.CertError, match="wasn't made from the pending CSR"):
        tls.prepare(_signed(ca, stranger.public_key(), ["x.example"]).decode(), None)


def test_install_keeps_previous_and_reloads(nginx):
    tls.install(*tls.self_signed(["a.example"]))
    first = tls.current()
    tls.install(*tls.self_signed(["b.example"]))
    d = tls.tls_dir()
    assert (d / "cert.pem.prev").read_bytes() == first
    assert oct((d / "key.pem").stat().st_mode & 0o777) == "0o600"
    assert nginx == [["sudo", "-n", "/usr/sbin/nginx", "-s", "reload"]] * 2


def test_no_reload_without_https(monkeypatch, tmp_path):
    monkeypatch.setattr(tls, "NGINX_CONF", tmp_path / "missing.conf")
    called = []
    monkeypatch.setattr(tls.subprocess, "run", lambda *a, **k: called.append(a))
    assert tls.reload_nginx() is False and not called


def test_ensure_and_redirect(nginx):
    assert "self-signed" in tls.ensure()
    assert tls.ensure() == "certificate already in place"
    assert tls.redirect()
    tls.set_redirect(False)
    assert not tls.redirect() and "include" in (tls.tls_dir() / "http.conf").read_text()
    assert "Covers:" in tls.show()


def test_api(admin, nginx):
    s = admin.get("/api/tls").json()
    assert s["https_enabled"] and s["certificate"] is None and s["redirect"]
    assert (
        admin.post("/api/tls/self-signed", json={"names": ["no way"]}, headers=CSRF).status_code
        == 422
    )
    r = admin.post("/api/tls/self-signed", json={"names": ["ops.example.com"]}, headers=CSRF)
    assert r.status_code == 200 and r.json()["certificate"]["names"] == ["ops.example.com"]
    assert r.json()["served"] is True
    assert admin.get("/api/tls/certificate.pem").text.startswith("-----BEGIN CERTIFICATE-----")
    r = admin.post("/api/tls/certificate", json={"certificate": "junk"}, headers=CSRF)
    assert r.status_code == 422 and "PEM" in r.json()["detail"]
    r = admin.post(
        "/api/tls/csr", json={"names": ["ops.example.com"], "organization": "Acme"}, headers=CSRF
    )
    assert r.json()["pending_csr"]["subject"] == "ops.example.com"
    assert "CERTIFICATE REQUEST" in admin.get("/api/tls/csr.pem").text
    assert admin.delete("/api/tls/csr", headers=CSRF).json()["pending_csr"] is None
    assert (
        admin.put("/api/tls/redirect", json={"redirect": False}, headers=CSRF).json()["redirect"]
        is False
    )
    with db._connect() as conn:
        titles = [
            r[0] for r in conn.execute("SELECT title FROM app_events WHERE event_type = 'tls'")
        ]
    assert (
        "New self-signed certificate: ops.example.com" in titles
        and "CSR created: ops.example.com" in titles
    )


def test_redirect_needs_https(admin, monkeypatch, tmp_path):
    monkeypatch.setattr(tls, "NGINX_CONF", tmp_path / "missing.conf")
    assert admin.put("/api/tls/redirect", json={"redirect": True}, headers=CSRF).status_code == 409


def test_expiry_alert_once_per_level(nginx, monkeypatch):
    from app.agent import runner
    from app.services import alerts

    assert [runner.certificate_level(d, d < 0) for d in (60, 30, 7, -1)] == [
        None,
        "medium",
        "high",
        "critical",
    ]
    raised = []

    async def fake(a):
        raised.append(a)

    monkeypatch.setattr(alerts, "raise_alert", fake)
    tls.install(*tls.self_signed(["ops.example.com"], days=20))
    asyncio.run(runner.check_certificate())
    asyncio.run(runner.check_certificate())  # same level: not again
    assert [a.severity for a in raised] == ["medium"] and raised[0].link == "/settings?tab=https"
    tls.install(*tls.self_signed(["ops.example.com"], days=5))  # new certificate, worse
    asyncio.run(runner.check_certificate())
    assert [a.severity for a in raised] == ["medium", "high"]
    tls.install(*tls.self_signed(["ops.example.com"]))  # replaced: nothing
    asyncio.run(runner.check_certificate())
    assert len(raised) == 2
