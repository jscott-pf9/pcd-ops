import asyncio
import os
from pathlib import Path

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, create_model

from app.appliance import connection as pcd
from app.appliance import state
from app.config import Settings, settings
from app.dependencies import make_ai_provider
from app.services import prometheus, settings_store

router = APIRouter()

# App settings only. PCD itself is reached with the logged-in user's token or the background
# application credential (app/api/access.py), never a stored account (APPLIANCE_STANDARD §7.8).
_SECRETS = ("grafana_token", "ai_api_key", "ai_private_api_key", "smtp_password",
            "hypervisor_ssh_password")
_MASK = "***"
# Everything the Settings page edits. The GitHub feedback token stays in .env.
EDITABLE = tuple(k for k in Settings.model_fields if not k.startswith("github_"))

# PUT takes any subset of the fields, so each Settings tab saves only its own.
SettingsPayload = create_model(
    "SettingsPayload",
    **{k: (Settings.model_fields[k].annotation | None, None) for k in EDITABLE},
)


def _secret(field: str, given: str | None) -> str:
    """A secret from a request, or the saved one when the field was left blank or masked."""
    return given if given and given != _MASK else getattr(settings, field)


@router.get("/settings")
async def get_settings():
    """Return the app settings; secrets are '***' when set. grafana_url_default is the Grafana
    URL used while grafana_url is blank."""
    body = {k: (_MASK if getattr(settings, k) else "") if k in _SECRETS else getattr(settings, k)
            for k in EDITABLE}
    body["grafana_url_default"] = prometheus.default_grafana_url()
    return body


@router.put("/settings")
async def update_settings(payload: SettingsPayload):
    """Save the fields sent. A secret sent as '***' or '' keeps the saved value."""
    stored = settings_store.load()
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is None or (key in _SECRETS and value in (_MASK, "")):
            continue
        if isinstance(value, str):
            value = value.strip()
        stored[key] = value
        setattr(settings, key, value)
    settings_store.save(stored)
    return {"status": "saved"}


# ── AI backend ────────────────────────────────────────────────────────────────

class AIRequest(BaseModel):
    """The values on the AI tab, saved or not. A blank or masked key means the saved one."""
    ai_backend: str = "ollama"
    ai_url: str = ""
    ai_model: str = ""
    api_key: str = ""


def _provider(body: AIRequest):
    key_field = "ai_api_key" if body.ai_backend == "claude" else "ai_private_api_key"
    if body.ai_backend == "claude" and not _secret(key_field, body.api_key):
        raise HTTPException(400, detail="Enter the Anthropic API key.")
    if body.ai_backend != "claude" and not body.ai_url.strip():
        raise HTTPException(400, detail="Enter the Private AI URL.")
    return make_ai_provider(body.ai_backend, body.ai_url, body.ai_model,
                            _secret(key_field, body.api_key))


@router.post("/settings/ai/models")
async def ai_models(body: AIRequest):
    """The models the backend offers, for the Model dropdown."""
    try:
        return {"models": await _provider(body).models()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=f"Couldn't list models: {e}") from None


@router.post("/settings/ai/test")
async def ai_test(body: AIRequest):
    """List the models, then ask the chosen model for a one-word reply."""
    provider = _provider(body)
    try:
        models = await provider.models()
    except Exception as e:
        return {"ok": False, "error": f"Couldn't reach the AI backend: {e}"}
    model = getattr(provider, "model", body.ai_model)
    if not model:
        return {"ok": False, "models": models, "error": "Choose a model."}
    try:
        reply = await asyncio.wait_for(
            provider.analyze("Reply with the single word OK.", {}), timeout=120)
    except Exception as e:
        return {"ok": False, "models": models, "model": model,
                "error": f"{model} didn't answer: {e or type(e).__name__}"}
    return {"ok": True, "models": models, "model": model, "reply": reply.strip()[:200]}


# ── Grafana / Prometheus ──────────────────────────────────────────────────────

class MetricsRequest(BaseModel):
    """The values on the Connection tab, saved or not. A blank or masked token means the saved
    one."""
    grafana_url: str = ""
    grafana_token: str = ""
    prometheus_url: str = ""


@router.post("/settings/metrics/test")
async def metrics_test(body: MetricsRequest):
    """Find the Prometheus data source through Grafana (unless a Prometheus URL is given) and
    run a query through it."""
    token = _secret("grafana_token", body.grafana_token)
    grafana = (body.grafana_url.strip() or prometheus.default_grafana_url()).rstrip("/")
    try:
        if body.prometheus_url.strip():
            ds = {"name": "", "url": body.prometheus_url.strip().rstrip("/")}
        else:
            ds = await prometheus.find_datasource(grafana, token)
        result = await prometheus.PrometheusClient(ds["url"], token).query("vector(1)")
        if not result:
            raise RuntimeError("the test query returned nothing")
    except Exception as e:
        return {"ok": False, "grafana_url": grafana, "error": str(e)}
    return {"ok": True, "grafana_url": grafana, "datasource": ds["name"],
            "prometheus_url": ds["url"]}


# ── Hypervisor SSH key ────────────────────────────────────────────────────────

SSH_KEY_FILE = "hypervisor_ssh_key"   # in the state dir; generated by POST /settings/ssh/key


def _public_key(path: str) -> str | None:
    """The authorized_keys line for the unencrypted private key at path; None if there isn't one."""
    try:
        data = Path(path).expanduser().read_bytes()
    except OSError:
        return None
    for load in (serialization.load_ssh_private_key, serialization.load_pem_private_key):
        try:
            key = load(data, None)
            break
        except (ValueError, TypeError, UnsupportedAlgorithm):
            continue
    else:
        return None
    line = key.public_key().public_bytes(serialization.Encoding.OpenSSH,
                                         serialization.PublicFormat.OpenSSH).decode()
    return f"{line} pcd-ops@{pcd.load().instance_name}"


@router.get("/settings/ssh/key")
async def ssh_key():
    """The public key of the configured hypervisor SSH key, to add to authorized_keys."""
    path = settings.hypervisor_ssh_key_path
    return {"path": path, "public_key": _public_key(path) if path else None,
            "generated": bool(path) and Path(path) == state.state_dir() / SSH_KEY_FILE}


class SSHKeyRequest(BaseModel):
    replace: bool = False


@router.post("/settings/ssh/key")
async def generate_ssh_key(body: SSHKeyRequest):
    """Generate an ed25519 key pair on the appliance and use it for the hypervisors. The private
    key never leaves the appliance. Replacing a working key needs replace=true."""
    if not body.replace and settings.hypervisor_ssh_key_path and _public_key(
            settings.hypervisor_ssh_key_path):
        raise HTTPException(409, detail="A key is already set up. Replace it to make a new one.")
    key = ed25519.Ed25519PrivateKey.generate()
    path = state.state_dir() / SSH_KEY_FILE
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                  serialization.NoEncryption()))
    os.replace(tmp, path)
    stored = settings_store.load()
    stored["hypervisor_ssh_key_path"] = settings.hypervisor_ssh_key_path = str(path)
    settings_store.save(stored)
    return await ssh_key()
