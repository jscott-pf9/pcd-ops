"""Settings saved on the Settings page: settings.json in the state dir (mode 0600; it holds the
Grafana token, API keys and passwords)."""
from app.appliance import state

SETTINGS_FILE = "settings.json"


def load() -> dict:
    return state.read_json(SETTINGS_FILE) or {}


def save(data: dict) -> None:
    state.write_json(SETTINGS_FILE, data)
