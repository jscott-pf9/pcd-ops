"""/etc/pcd-app/config.env, written by the PCD extension catalog at first boot (APPLIANCE_STANDARD §5)."""
from __future__ import annotations

import os
from pathlib import Path

CONFIG_ENV = Path(os.getenv("PCD_APP_CONFIG", "/etc/pcd-app/config.env"))


def _unquote(raw: str) -> str:
    """Decode one sh value: concatenated '...' / "..." / bare segments ('\\'' escapes work)."""
    out, i, n = [], 0, len(raw)
    while i < n:
        c = raw[i]
        if c == "'":
            end = raw.find("'", i + 1)
            if end < 0:
                raise ValueError("unterminated single quote")
            out.append(raw[i + 1:end])
            i = end + 1
        elif c == '"':
            i += 1
            while i < n and raw[i] != '"':
                if raw[i] == "\\" and i + 1 < n and raw[i + 1] in '"\\$`':
                    i += 1
                out.append(raw[i])
                i += 1
            if i >= n:
                raise ValueError("unterminated double quote")
            i += 1
        elif c == "\\" and i + 1 < n:
            out.append(raw[i + 1])
            i += 2
        elif c.isspace() or c == "#":
            break
        else:
            out.append(c)
            i += 1
    return "".join(out)


def parse(text: str) -> dict[str, str]:
    """KEY=value lines; comments, blanks and malformed lines are skipped."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, raw = line.partition("=")
        if not sep or not key.replace("_", "").isalnum() or key[0].isdigit():
            continue
        try:
            values[key] = _unquote(raw)
        except ValueError:
            continue
    return values


def load(path: Path | None = None) -> dict[str, str]:
    """Non-empty values only (empty means unset). A missing file is an empty config."""
    try:
        env = parse((path or CONFIG_ENV).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return {}
    return {k: v for k, v in env.items() if v.strip()}


def setting(key: str, saved: dict, env: dict, default: str | None = None) -> str | None:
    """App settings: a value saved in the app's UI wins over config.env, which wins over the default.
    PCD_* keys are not settings: read them from env directly and show them read-only."""
    if saved.get(key) not in (None, ""):
        return saved[key]
    return env.get(key, default)
