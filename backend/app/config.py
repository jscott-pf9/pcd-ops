from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        frozen=False,
        extra="ignore",
    )

    # OpenStack
    os_auth_url: str = ""
    os_username: str = ""
    os_password: str = ""
    os_project_name: str = ""
    os_user_domain_name: str = "Default"
    os_project_domain_name: str = "Default"
    os_region_name: str = ""

    # Grafana / Prometheus
    prometheus_url: str = "http://localhost:9090"
    grafana_url: str = ""
    grafana_token: str = ""

    # AI — variable names match .env (AI_BACKEND, AI_URL, AI_MODEL, AI_API_KEY)
    ai_backend: str = "ollama"
    ai_url: str = "http://localhost:11434"
    ai_model: str = "llama3.1:8b"
    ai_api_key: str = ""

    # Data retention (days; 0 = keep forever)
    job_run_retention_days:  int = 30
    report_retention_days:   int = 30

    # Hypervisor SSH (for log collection)
    hypervisor_ssh_user:     str = "root"
    hypervisor_ssh_key_path: str = ""   # path to private key; falls back to agent/default
    hypervisor_ssh_password: str = ""   # used only if no key

    # Alerts — SMTP email + webhook
    smtp_host:     str = ""
    smtp_port:     str = "587"
    smtp_user:     str = ""
    smtp_password: str = ""
    smtp_from:     str = ""
    alert_email_to: str = ""
    webhook_url:   str = ""


settings = Settings()

# Apply any overrides saved via the Settings page (settings.json)
# Import here to avoid circular imports at module level
from app.services import settings_store  # noqa: E402

for _k, _v in settings_store.load().items():
    if hasattr(settings, _k) and _v != "":
        setattr(settings, _k, _v)
