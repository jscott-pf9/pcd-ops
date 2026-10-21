"""
Deployment lifecycle management.

Tracks every terraform apply invocation, persists state, and provides
redeploy / destroy / stop operations.
"""

import asyncio
import json
import logging
import os
import shutil
import tempfile

import openstack.connection
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.appliance import connection as pcd
from app.services import db
from app.services.openstack import user_connection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/deployments", tags=["deployments"])

TF = "/snap/bin/terraform"


# ── Helpers ────────────────────────────────────────────────────────────────────

def _event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def pcd_env(request: Request) -> dict[str, str]:
    """Environment for the OpenStack Terraform provider: the logged-in user's token (rescoped
    by the provider to the deployment's tenant_name), never a stored account."""
    conn = pcd.load()
    tok = request.state.session["token"]
    env = {
        "OS_AUTH_URL": conn.auth_url,
        "OS_AUTH_TOKEN": tok.value,
        "OS_PROJECT_DOMAIN_NAME": conn.project_domain,
        "OS_ENDPOINT_TYPE": "public",
    }
    if conn.region:
        env["OS_REGION_NAME"] = conn.region
    return env


async def _run_tf(tmpdir: str, *args, auth_env: dict[str, str]) -> tuple[int, list[str]]:
    """Run a terraform command, return (returncode, [output_lines])."""
    # Drop any OS_* from the service's own environment; auth comes only from auth_env.
    env = {k: v for k, v in os.environ.items() if not k.startswith("OS_")}
    env.update(auth_env, TF_IN_AUTOMATION="1")
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=tmpdir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    lines = []
    async for line in proc.stdout:
        t = line.decode().rstrip()
        if t:
            lines.append(t)
    await proc.wait()
    return proc.returncode, lines


async def _tf_operation(dep_id: str, op: str, auth_env: dict[str, str]):
    """Shared generator: init + {apply|destroy}, stream SSE, save state."""
    dep = db.deployment_get(dep_id)
    if not dep:
        yield _event({"type": "error", "message": "Deployment not found"})
        return

    tmpdir = tempfile.mkdtemp(prefix=f"pcd-{op}-")
    try:
        # Write files
        with open(os.path.join(tmpdir, "main.tf"), "w") as f:
            f.write(dep["hcl"])

        evars = dep.get("extra_vars") or {}
        with open(os.path.join(tmpdir, "terraform.tfvars"), "w") as f:
            f.write(f'tenant_name  = "{dep["tenant_name"]}"\n')
            if dep.get("network_name"):
                f.write(f'network_name = "{dep["network_name"]}"\n')
            if dep.get("key_pair"):
                f.write(f'key_pair     = "{dep["key_pair"]}"\n')
            for k, v in evars.items():
                f.write(f'{k} = "{v}"\n')

        # Restore state
        if dep.get("tf_state"):
            with open(os.path.join(tmpdir, "terraform.tfstate"), "w") as f:
                f.write(dep["tf_state"])

        db.deployment_update(dep_id, status=op + "ing")

        # Init
        yield _event({"type": "log", "line": "▶ terraform init"})
        rc, lines = await _run_tf(tmpdir, TF, "init", "-input=false", "-no-color", auth_env=auth_env)
        for ln in lines:
            yield _event({"type": "log", "line": ln})
        if rc != 0:
            db.deployment_update(dep_id, status="error", error_msg="terraform init failed")
            yield _event({"type": "error", "message": "terraform init failed"})
            return

        # Apply or destroy
        tf_args = [TF, op, "-input=false", "-no-color"]
        if op == "apply":
            tf_args.append("-auto-approve")
        elif op == "destroy":
            tf_args.append("-auto-approve")

        yield _event({"type": "log", "line": f"▶ terraform {op}"})
        rc2, lines2 = await _run_tf(tmpdir, *tf_args, auth_env=auth_env)
        for ln in lines2:
            yield _event({"type": "log", "line": ln})

        # Read updated state
        state_path = os.path.join(tmpdir, "terraform.tfstate")
        new_state = None
        if os.path.exists(state_path):
            with open(state_path) as f:
                new_state = f.read()

        if rc2 != 0:
            db.deployment_update(dep_id, status="error",
                                  tf_state=new_state,
                                  error_msg=f"terraform {op} failed (rc={rc2})")
            yield _event({"type": "error", "message": f"terraform {op} failed"})
            return

        # Save state
        db.deployment_update(dep_id, tf_state=new_state)

        if op == "destroy":
            db.deployment_update(dep_id, status="destroyed")
            yield _event({"type": "done", "outputs": {}})
            return

        # Outputs
        rc3, out_lines = await _run_tf(tmpdir, TF, "output", "-json", auth_env=auth_env)
        try:
            raw = json.loads("\n".join(out_lines))
            outputs = {k: v.get("value") for k, v in raw.items()}
        except Exception:
            outputs = {}

        db.deployment_update(dep_id, status="running", outputs=outputs)
        yield _event({"type": "done", "outputs": outputs})

    except Exception as e:
        db.deployment_update(dep_id, status="error", error_msg=str(e))
        yield _event({"type": "error", "message": str(e)})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/")
async def list_deployments(profile_id: int | None = None):
    """List all deployments, optionally filtered by app profile ID."""
    return db.deployment_list(profile_id=profile_id)


@router.get("/{dep_id}")
async def get_deployment(dep_id: str):
    """Get a deployment by ID including HCL, Terraform outputs, and current status."""
    dep = db.deployment_get(dep_id)
    if not dep:
        raise HTTPException(404, detail="Deployment not found")
    return dep


@router.post("/{dep_id}/redeploy")
async def redeploy(dep_id: str, request: Request):
    """Re-run terraform init + apply for a deployment, streaming SSE progress and final outputs."""
    dep = db.deployment_get(dep_id)
    if not dep:
        raise HTTPException(404)
    if dep["status"] == "deploying":
        raise HTTPException(409, detail="Deployment already in progress")

    auth_env = pcd_env(request)

    async def _stream():
        async for chunk in _tf_operation(dep_id, "apply", auth_env):
            yield chunk

    return StreamingResponse(_stream(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/{dep_id}/destroy")
async def destroy_deployment(dep_id: str, request: Request):
    """Run terraform destroy for a deployment, streaming SSE progress lines."""
    dep = db.deployment_get(dep_id)
    if not dep:
        raise HTTPException(404)
    if dep["status"] in ("deploying", "destroying"):
        raise HTTPException(409, detail="Operation already in progress")
    if dep["status"] == "destroyed":
        raise HTTPException(409, detail="Already destroyed")

    auth_env = pcd_env(request)

    async def _stream():
        async for chunk in _tf_operation(dep_id, "destroy", auth_env):
            yield chunk

    return StreamingResponse(_stream(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/{dep_id}/stop")
async def stop_vms(dep_id: str,
                   conn: openstack.connection.Connection = Depends(user_connection)):
    """Shelve all VMs belonging to this deployment via OpenStack API."""
    dep = db.deployment_get(dep_id)
    if not dep:
        raise HTTPException(404)
    if dep["status"] not in ("running",):
        raise HTTPException(409, detail="Only running deployments can be stopped")

    servers = await asyncio.to_thread(
        lambda: list(conn.compute.servers(all_projects=True))
    )

    # Match VMs by tenant + name prefix (tier names from outputs keys)
    outputs = dep.get("outputs") or {}
    tier_names = [k.replace("_ips", "").replace("_ip", "") for k in outputs if "ip" in k.lower()]

    shelved = []
    for s in servers:
        if s.project_id and dep["tenant_name"]:
            # Match by name prefix if we have tier names, otherwise skip
            matched = any(s.name.startswith(t) for t in tier_names) if tier_names else False
            if matched and s.status == "ACTIVE":
                try:
                    await asyncio.to_thread(lambda sid=s.id: conn.compute.shelve_server(sid))
                    shelved.append(s.name)
                except Exception as e:
                    logger.warning("Failed to shelve %s: %s", s.name, e)

    if shelved:
        db.deployment_update(dep_id, status="stopped")
    return {"shelved": shelved, "count": len(shelved)}


@router.get("/{dep_id}/status")
async def check_status(dep_id: str,
                       conn: openstack.connection.Connection = Depends(user_connection)):
    """Refresh deployment status by querying OpenStack for VM states."""
    dep = db.deployment_get(dep_id)
    if not dep:
        raise HTTPException(404)

    servers = await asyncio.to_thread(
        lambda: list(conn.compute.servers(all_projects=True))
    )

    outputs = dep.get("outputs") or {}
    tier_names = [k.replace("_ips", "").replace("_ip", "") for k in outputs if "ip" in k.lower()]

    tiers: dict[str, dict] = {}
    for s in servers:
        matched = next((t for t in tier_names if s.name.startswith(t)), None)
        if matched:
            if matched not in tiers:
                tiers[matched] = {"active": 0, "shutoff": 0, "error": 0, "other": 0}
            st = s.status.lower()
            if st == "active":
                tiers[matched]["active"] += 1
            elif st in ("shutoff", "shelved", "shelved_offloaded"):
                tiers[matched]["shutoff"] += 1
            elif st == "error":
                tiers[matched]["error"] += 1
            else:
                tiers[matched]["other"] += 1

    # Derive overall status
    if all(v["active"] > 0 for v in tiers.values()) and tiers:
        live_status = "running"
    elif any(v["error"] > 0 for v in tiers.values()):
        live_status = "error"
    elif all(v["shutoff"] > 0 for v in tiers.values()) and tiers:
        live_status = "stopped"
    else:
        live_status = dep["status"]

    if live_status != dep["status"] and dep["status"] not in ("deploying", "destroying"):
        db.deployment_update(dep_id, status=live_status)

    return {"status": live_status, "tiers": tiers, "deployment_id": dep_id}


@router.delete("/{dep_id}", status_code=204)
async def delete_deployment(dep_id: str):
    """Delete a deployment record (only allowed when status is 'destroyed' or 'error')."""
    dep = db.deployment_get(dep_id)
    if not dep:
        raise HTTPException(404)
    if dep["status"] not in ("destroyed", "error"):
        raise HTTPException(409, detail="Can only delete destroyed or errored deployments")
    db.deployment_delete(dep_id)
