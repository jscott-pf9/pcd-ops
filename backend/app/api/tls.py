import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.appliance import tls
from app.services import db

router = APIRouter(prefix="/tls", tags=["tls"])


def _status(warnings: list[str] | None = None, served: bool | None = None) -> dict:
    pem = tls.current()
    return {
        "https_enabled": tls.https_enabled(),
        "redirect": tls.redirect(),
        "certificate": tls.describe(pem) if pem else None,
        "pending_csr": tls.pending(),
        "default_names": tls.default_names(),
        "warnings": warnings or [],
        # After a change: whether nginx was seen serving the new certificate (None: not checked)
        "served": served,
    }


async def _apply(chain: bytes, key: bytes, what: str, warnings: list[str]) -> dict:
    await asyncio.to_thread(tls.install, chain, key)
    info = tls.describe(chain)
    served = None
    if tls.https_enabled():
        served = await asyncio.to_thread(tls.wait_served, info["fingerprint_sha256"])
        if not served:
            warnings = [*warnings, "nginx isn't serving it yet: check /var/log/nginx/error.log "
                                   "(console → Advanced → Emergency Shell)"]
    db.event_log("tls", f"{what}: {info['subject']}", level="success",
                 detail=f"{', '.join(info['names'])}; valid until {info['not_after'][:10]}",
                 component="Settings")
    return _status(warnings, served)


@router.get("")
async def tls_status():
    """HTTPS on this appliance: whether nginx serves it (`https_enabled`; older appliances turn
    it on from the console), whether plain HTTP redirects to it, the certificate (subject,
    names, issuer, validity, fingerprint, chain length), a CSR waiting for its certificate, and
    the names a new self-signed certificate would cover."""
    return _status()


class SelfSigned(BaseModel):
    names: list[str] = Field(min_length=1, max_length=50)


@router.post("/self-signed")
async def regenerate(body: SelfSigned):
    """Make a new self-signed certificate for `names` (the first is its common name) and
    serve it."""
    try:
        chain, key = await asyncio.to_thread(tls.self_signed, body.names)
    except tls.CertError as e:
        raise HTTPException(422, detail=str(e)) from e
    return await _apply(chain, key, "New self-signed certificate",
                        ["It's self-signed: browsers warn until it's trusted on each computer"])


class Upload(BaseModel):
    certificate: str = Field(min_length=1, max_length=200_000)
    key: str | None = Field(default=None, max_length=50_000)


@router.post("/certificate")
async def upload(body: Upload):
    """Install a certificate (PEM; the certificate first, then its chain) and its key. Without
    a key, the pending CSR's key is used. 422 says what's wrong with them."""
    try:
        chain, key, warnings = await asyncio.to_thread(tls.prepare, body.certificate, body.key)
    except tls.CertError as e:
        raise HTTPException(422, detail=str(e)) from e
    return await _apply(chain, key, "Certificate installed", warnings)


@router.get("/certificate.pem")
async def download():
    """The certificate and its chain, to trust a self-signed one on a computer."""
    pem = tls.current()
    if not pem:
        raise HTTPException(404, detail="No certificate yet")
    return Response(pem, media_type="application/x-pem-file",
                    headers={"Content-Disposition": 'attachment; filename="pcd-ops.crt"'})


class CsrRequest(BaseModel):
    names: list[str] = Field(min_length=1, max_length=50)
    organization: str = Field(default="", max_length=64)


@router.post("/csr")
async def create_csr(body: CsrRequest):
    """Make a key and a certificate signing request for `names` (the first is its common name).
    The key stays on the appliance; upload the signed certificate without a key to use it."""
    try:
        await asyncio.to_thread(tls.make_csr, body.names, body.organization)
    except tls.CertError as e:
        raise HTTPException(422, detail=str(e)) from e
    db.event_log("tls", f"CSR created: {body.names[0]}", component="Settings")
    return _status()


@router.get("/csr.pem")
async def download_csr():
    path = tls.tls_dir() / "pending.csr"
    if not path.exists():
        raise HTTPException(404, detail="No pending CSR")
    return Response(path.read_bytes(), media_type="application/pkcs10",
                    headers={"Content-Disposition": 'attachment; filename="pcd-ops.csr"'})


@router.delete("/csr")
async def discard_csr():
    tls.discard_pending()
    return _status()


class Redirect(BaseModel):
    redirect: bool


@router.put("/redirect")
async def set_redirect(body: Redirect):
    """Plain HTTP redirects to HTTPS, or serves the app as well. /api/health stays on HTTP
    either way, for the catalog's health check."""
    if not tls.https_enabled():
        raise HTTPException(409, detail="HTTPS isn't enabled on this appliance yet")
    await asyncio.to_thread(tls.set_redirect, body.redirect)
    db.event_log("tls", "HTTP redirects to HTTPS" if body.redirect else "HTTP serves the app too",
                 component="Settings")
    return _status()
