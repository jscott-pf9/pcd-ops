import json
import os
from pathlib import Path

_path = Path(os.environ.get("SETTINGS_FILE", "settings.json"))


def load() -> dict:
    if _path.exists():
        return json.loads(_path.read_text())
    return {}


def save(data: dict) -> None:
    _path.write_text(json.dumps(data, indent=2))
