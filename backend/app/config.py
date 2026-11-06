from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        frozen=False,
        extra="ignore",
        # The PCD App Catalog's /etc/pcd-app/config.env writes blank install-form
        # fields as KEY='' — treat those as unset so the defaults below apply.
        env_ignore_empty=True,
    )

    # PCD (Keystone URL, region, install project) is not a setting: it comes from
    # /etc/pcd-app/config.env, see app/appliance/connection.py.

    # Grafana / Prometheus. Blank grafana_url: https://<PCD host>/grafana, from PCD_AUTH_URL.
    # Blank prometheus_url: the Prometheus data source found through Grafana
    # (services/prometheus.py).
    prometheus_url: str = ""
    grafana_url: str = ""
    grafana_token: str = ""

    # PCD Ops' own metrics store: VictoriaMetrics on the appliance scraping node-exporter and
    # libvirt-exporter on every hypervisor (services/local_metrics.py). Grafana above is then
    # used only for the openstack_* series and as a fallback.
    metrics_local_enabled:   bool = True
    metrics_scrape_interval: str = "60s"     # "30s" or "60s"
    metrics_retention_days:  int = 90        # 30, 90, 180, 365 or 730
    metrics_keep_all_series: bool = False    # keep every exporter series, not just the allowlist

    # AI — variable names match .env (AI_BACKEND, AI_URL, AI_MODEL, AI_API_KEY).
    # ai_backend "ollama" is Private AI: Ollama or any OpenAI-compatible server
    # (services/ai/private.py).
    ai_backend: str = "ollama"
    ai_url: str = "http://localhost:11434"
    ai_model: str = "llama3.1:8b"
    ai_api_key: str = ""            # Claude
    ai_private_api_key: str = ""    # Private AI, if the server wants a bearer token

    # AI feature toggles (controls which background/interactive features call the AI)
    ai_rightsizing_enabled: bool = True
    ai_anomaly_enabled:     bool = True
    ai_logs_enabled:        bool = True
    ai_capacity_enabled:    bool = True

    # AI analysis schedules — same format as Jobs ("hourly", "daily@02:00", "weekly@03:00")
    ai_rightsizing_schedule: str = "daily@02:00"
    ai_anomaly_schedule:     str = "hourly"

    # Reclamation: a running VM is idle when its 95th-percentile CPU, network and disk I/O over
    # the window are all under these (services/reclamation.py; Right-Sizing uses the same rule)
    reclamation_idle_days:     int = 14
    reclamation_idle_cpu_pct:  float = 5.0
    reclamation_idle_net_kbps: float = 10.0
    reclamation_idle_iops:     float = 1.0
    # What reclaiming saves: a monthly price per unit, in reclamation_currency (0 = not shown)
    reclamation_currency:        str = "$"
    reclamation_price_vcpu:      float = 0.0   # per vCPU
    reclamation_price_ram_gb:    float = 0.0
    reclamation_price_volume_gb: float = 0.0
    reclamation_price_image_gb:  float = 0.0
    reclamation_price_ip:        float = 0.0   # per IP address

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

    # GitHub feedback — token needs issues:write scope on the target repo
    github_token: str = ""
    github_repo:  str = ""  # e.g. "platform9/pcd-ops"


settings = Settings()

# Apply any overrides saved via the Settings page (settings.json in the state dir). Everything
# reads `settings` when it runs, so a saved change applies without a restart.
# Import here to avoid circular imports at module level
from app.services import settings_store  # noqa: E402

for _k, _v in settings_store.load().items():
    if _k in Settings.model_fields and (_v != "" or isinstance(_v, bool)):
        setattr(settings, _k, _v)
