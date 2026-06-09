#!/usr/bin/env python3
"""
Generate docs/API.md from the FastAPI OpenAPI schema.

Usage (from repo root):
    cd backend && source .venv/bin/activate && python ../scripts/gen-api-docs.py

No server needed — imports the app directly and calls app.openapi().
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
OUT = ROOT / "docs" / "API.md"

sys.path.insert(0, str(BACKEND))

# Suppress logging noise during import
import logging
logging.disable(logging.CRITICAL)

from app.main import app  # noqa: E402

logging.disable(logging.NOTSET)

schema = app.openapi()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _resolve_ref(ref: str, components: dict) -> dict:
    """Resolve a $ref like '#/components/schemas/Foo' to its schema dict."""
    parts = ref.lstrip("#/").split("/")
    node = {"components": components}
    for part in parts:
        node = node.get(part, {})
    return node


def _schema_to_table(schema_obj: dict, components: dict, indent: int = 0) -> list[str]:
    """Return markdown table rows for a schema object's properties."""
    if "$ref" in schema_obj:
        schema_obj = _resolve_ref(schema_obj["$ref"], components)

    props = schema_obj.get("properties", {})
    required = set(schema_obj.get("required", []))
    rows = []
    for name, prop in props.items():
        if "$ref" in prop:
            prop = _resolve_ref(prop["$ref"], components)
        typ = prop.get("type", "object")
        if "anyOf" in prop:
            types = [p.get("type", "$ref") for p in prop["anyOf"] if p != {"type": "null"}]
            typ = " | ".join(types) or "any"
        default = prop.get("default")
        req_marker = "yes" if name in required else "no"
        desc = prop.get("description", prop.get("title", ""))
        default_str = f"`{json.dumps(default)}`" if default is not None else "—"
        rows.append(f"| `{name}` | {typ} | {req_marker} | {default_str} | {desc} |")
    return rows


def _params_table(parameters: list) -> list[str]:
    """Render query/path parameters as a markdown table."""
    rows = []
    for p in parameters:
        loc = p.get("in", "")
        name = p.get("name", "")
        req = "yes" if p.get("required") else "no"
        schema_p = p.get("schema", {})
        typ = schema_p.get("type", "string")
        default = schema_p.get("default")
        default_str = f"`{json.dumps(default)}`" if default is not None else "—"
        desc = p.get("description", "")
        rows.append(f"| `{name}` | {loc} | {typ} | {req} | {default_str} | {desc} |")
    return rows


def _method_badge(method: str) -> str:
    return f"**{method.upper()}**"


# ── Group paths by tag ─────────────────────────────────────────────────────────

components = schema.get("components", {})
paths = schema.get("paths", {})
tags_order = [t["name"] for t in schema.get("tags", [])]

# Build tag → [(method, path, operation)] map
tag_ops: dict[str, list] = {}
for path, path_item in paths.items():
    for method, op in path_item.items():
        if method not in ("get", "post", "put", "delete", "patch"):
            continue
        for tag in op.get("tags", ["misc"]):
            tag_ops.setdefault(tag, []).append((method, path, op))

# Sort tags — use declared order where possible, then alphabetical
all_tags = list(tag_ops.keys())
ordered_tags = [t for t in tags_order if t in all_tags]
ordered_tags += sorted(t for t in all_tags if t not in ordered_tags)


# ── Build output ───────────────────────────────────────────────────────────────

lines: list[str] = []

# Header
info = schema.get("info", {})
lines += [
    f"# {info.get('title', 'API Reference')}",
    "",
    info.get("description", ""),
    "",
    f"**Version:** {info.get('version', '—')}  ",
    "**Base URL:** `/api`  ",
    "**Auth:** None (internal service — restrict at the network layer)",
    "",
    "---",
    "",
    "## Common Patterns",
    "",
    "### Cache-backed reads",
    "",
    "Most `GET` endpoints serve data from an in-memory cache populated by a background",
    "collector. If the cache is empty (first boot or collector not yet run), the endpoint",
    "returns **503** with body `{\"code\": \"no_data\", \"key\": \"<cache-key>\"}`.",
    "Trigger a manual collection with `POST /api/agent/trigger` to populate it.",
    "",
    "### Streaming endpoints (Server-Sent Events)",
    "",
    "Terraform operations (`POST /api/generate/deploy`, `POST /api/deployments/{id}/redeploy`,",
    "`POST /api/deployments/{id}/destroy`) return `text/event-stream`. Each event is a JSON",
    "object on a `data:` line:",
    "",
    "| `type` | Fields | Meaning |",
    "|--------|--------|---------|",
    "| `started` | `deployment_id` | Deployment record created |",
    "| `log` | `line` | Terraform output line |",
    "| `done` | `outputs` | Operation succeeded; outputs is a key→value map |",
    "| `error` | `message` | Operation failed |",
    "",
    "### Error responses",
    "",
    "| Status | Meaning |",
    "|--------|---------|",
    "| 400 | Bad request (invalid parameters or unparseable input) |",
    "| 404 | Resource not found |",
    "| 409 | Conflict (operation in progress or invalid state transition) |",
    "| 422 | Validation error (FastAPI request model mismatch) |",
    "| 503 | Cache miss — collector not yet run, or AI feature disabled |",
    "",
    "---",
    "",
    "## Table of Contents",
    "",
]

for tag in ordered_tags:
    anchor = tag.lower().replace(" ", "-").replace("_", "-")
    lines.append(f"- [{tag.title()}](#{anchor})")

lines += ["", "---", ""]

# One section per tag
for tag in ordered_tags:
    ops = tag_ops[tag]
    lines += [f"## {tag.title()}", ""]

    for method, path, op in ops:
        full_desc = op.get("description", "").strip()
        desc_lines = full_desc.split("\n") if full_desc else []
        # Prefer the docstring's first line over FastAPI's function-name-derived summary
        effective_summary = desc_lines[0].strip() if desc_lines else (op.get("summary") or path)
        extra_desc = "\n".join(desc_lines[1:]).strip() if len(desc_lines) > 1 else ""

        lines += [
            f"### {_method_badge(method)} `{path}`",
            "",
            effective_summary,
            "",
        ]

        if extra_desc:
            lines += [extra_desc, ""]

        # Parameters
        params = op.get("parameters", [])
        if params:
            lines += [
                "**Parameters**",
                "",
                "| Name | In | Type | Required | Default | Description |",
                "|------|----|------|----------|---------|-------------|",
            ]
            lines += _params_table(params)
            lines.append("")

        # Request body
        req_body = op.get("requestBody", {})
        if req_body:
            content = req_body.get("content", {})
            json_schema = content.get("application/json", {}).get("schema", {})
            if json_schema:
                if "$ref" in json_schema:
                    json_schema = _resolve_ref(json_schema["$ref"], components)
                rows = _schema_to_table(json_schema, components)
                if rows:
                    lines += [
                        "**Request body** (`application/json`)",
                        "",
                        "| Field | Type | Required | Default | Description |",
                        "|-------|------|----------|---------|-------------|",
                    ]
                    lines += rows
                    lines.append("")

        # Response
        responses = op.get("responses", {})
        success_code = next((c for c in ("200", "201", "204") if c in responses), None)
        if success_code:
            resp = responses[success_code]
            resp_desc = resp.get("description", "")
            if success_code == "204":
                lines += [f"**Response:** 204 No Content  ", ""]
            else:
                resp_content = resp.get("content", {})
                resp_schema = resp_content.get("application/json", {}).get("schema", {})
                if resp_schema:
                    lines += [f"**Response:** {success_code} — {resp_desc}  ", ""]
                else:
                    lines += [f"**Response:** {success_code} — {resp_desc}  ", ""]

        lines += ["---", ""]

lines.append("")  # trailing newline

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("\n".join(lines))
print(f"Written {OUT} ({len(lines)} lines, {OUT.stat().st_size} bytes)")
