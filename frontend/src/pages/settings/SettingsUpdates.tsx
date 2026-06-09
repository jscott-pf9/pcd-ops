import { useEffect, useRef, useState } from "react";
import { checkForUpdate, getUpdateLog, getVersion, rebootAppliance, restartService, triggerUpdate, type UpdateCheck, type VersionInfo } from "../../api/system";
import { apiFetch } from "../../api/client";
import { useSettings } from "./useSettings";
import { Fieldset, SaveRow } from "./SettingsConnection";

export default function SettingsUpdates() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "updating" | "restarting" | "done" | "error">("idle");
  const [updateLog, setUpdateLog] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function handleCheck() {
    setPhase("checking");
    setUpdateCheck(null);
    try {
      setUpdateCheck(await checkForUpdate());
      setPhase("idle");
    } catch (err) {
      setUpdateLog(String(err));
      setPhase("error");
    }
  }

  async function handleUpdate() {
    setPhase("updating");
    setUpdateLog("");
    try {
      await triggerUpdate();
    } catch (err) {
      setUpdateLog(String(err));
      setPhase("error");
      return;
    }
    setPhase("restarting");
    let logInt = setInterval(async () => {
      try { setUpdateLog((await getUpdateLog()).log); } catch (_) {}
    }, 1500);
    await new Promise<void>(r => setTimeout(r, 5000));
    clearInterval(logInt);
    pollRef.current = setInterval(async () => {
      try {
        if ((await fetch("/api/health")).ok) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setVersion(await getVersion());
          setUpdateCheck(null);
          setPhase("done");
        }
      } catch (_) {}
    }, 2000);
  }

  const busy = phase === "checking" || phase === "updating" || phase === "restarting";

  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Software</h1>

      {/* ── Version & updates ── */}
      <div className="card card-body" style={{ marginBottom: "1rem" }}>
        <div style={{ fontSize: 12, color: "var(--gray-500)", marginBottom: 12 }}>
          {version
            ? <span>{version.tag ?? version.branch} &nbsp;·&nbsp; <code>{version.commit}</code></span>
            : "Loading version…"}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" disabled={busy} onClick={handleCheck}>
            {phase === "checking" ? "Checking…" : "Check for Updates"}
          </button>

          {updateCheck && (
            updateCheck.up_to_date
              ? <span className="text-success">Up to date</span>
              : <span style={{ fontSize: 13, color: "var(--gray-700)" }}>
                  Update available &nbsp;
                  <code>{updateCheck.local}</code> → <code>{updateCheck.remote}</code>
                </span>
          )}

          {updateCheck && !updateCheck.up_to_date && phase === "idle" && (
            <button className="btn btn-primary" onClick={handleUpdate}>Update &amp; Restart</button>
          )}

          {phase === "updating"   && <span className="text-muted" style={{ fontSize: 13 }}>Building…</span>}
          {phase === "restarting" && <span className="text-muted" style={{ fontSize: 13 }}>Restarting…</span>}
          {phase === "done"       && <span className="text-success">Updated successfully</span>}
          {phase === "error"      && <span className="text-danger">Update failed</span>}
        </div>

        {(phase === "updating" || phase === "restarting" || phase === "error") && updateLog && (
          <pre style={{
            marginTop: "0.75rem", padding: "0.6rem 0.75rem",
            background: "var(--gray-50)", border: "1px solid var(--gray-200)",
            borderRadius: "var(--radius)", fontSize: 11,
            fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto",
          }}>{updateLog}</pre>
        )}
      </div>

      {/* ── Appliance Controls ── */}
      <ApplianceControls />

      {/* ── Data Retention ── */}
      <DataRetentionSection />
    </div>
  );
}

function ApplianceControls() {
  const [restartPhase, setRestartPhase] = useState<"idle" | "restarting" | "done" | "error">("idle");
  const [rebootConfirm, setRebootConfirm] = useState(false);
  const [rebooting, setRebooting]         = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function handleRestart() {
    setRestartPhase("restarting");
    try {
      await restartService();
    } catch {
      setRestartPhase("error");
      return;
    }
    // Poll until the service comes back
    await new Promise<void>(r => setTimeout(r, 3000));
    pollRef.current = setInterval(async () => {
      try {
        if ((await fetch("/api/health")).ok) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setRestartPhase("done");
          setTimeout(() => setRestartPhase("idle"), 3000);
        }
      } catch (_) {}
    }, 1500);
  }

  async function handleReboot() {
    setRebooting(true);
    setRebootConfirm(false);
    try { await rebootAppliance(); } catch (_) {}
    // The VM will go offline; nothing more to poll
  }

  return (
    <Fieldset title="Appliance Controls">
      <p style={{ fontSize: 12, color: "var(--gray-600)", marginBottom: 12 }}>
        Restart the app service without updating code, or reboot the entire VM.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: 8 }}>
        {/* Restart App */}
        <button
          className="btn btn-secondary"
          disabled={restartPhase === "restarting"}
          onClick={handleRestart}
        >
          {restartPhase === "restarting" ? "Restarting…" : "Restart App"}
        </button>
        {restartPhase === "done"  && <span className="text-success" style={{ fontSize: 13 }}>Service restarted</span>}
        {restartPhase === "error" && <span className="text-danger"  style={{ fontSize: 13 }}>Restart failed</span>}
      </div>

      {/* Reboot Appliance — two-step confirm */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        {!rebootConfirm && !rebooting && (
          <button className="btn btn-secondary" onClick={() => setRebootConfirm(true)}>
            Reboot Appliance
          </button>
        )}
        {rebootConfirm && (
          <>
            <span style={{ fontSize: 13, color: "var(--gray-700)" }}>
              This will reboot the VM. The page will be unreachable for ~30s.
            </span>
            <button className="btn btn-danger" onClick={handleReboot}>Confirm Reboot</button>
            <button className="btn btn-secondary" onClick={() => setRebootConfirm(false)}>Cancel</button>
          </>
        )}
        {rebooting && (
          <span style={{ fontSize: 13, color: "var(--gray-500)" }}>
            Rebooting… reload the page in ~30 seconds.
          </span>
        )}
      </div>
    </Fieldset>
  );
}

function DataRetentionSection() {
  const { form, set, status, error, save } = useSettings();
  const [purgeMsg, setPurgeMsg] = useState("");

  async function runCleanupNow() {
    setPurgeMsg("Running…");
    try {
      const [r1, r2] = await Promise.all([
        apiFetch<{ deleted: number }>(`/jobs/runs/purge?older_than_days=${form.job_run_retention_days ?? 30}`, { method: "DELETE" }),
        apiFetch<{ deleted: number }>(`/reports/purge?older_than_days=${form.report_retention_days ?? 30}`, { method: "DELETE" }),
      ]);
      setPurgeMsg(`Removed ${r1.deleted} run(s) and ${r2.deleted} report(s).`);
    } catch {
      setPurgeMsg("Cleanup failed.");
    }
    setTimeout(() => setPurgeMsg(""), 4000);
  }

  return (
    <form onSubmit={save}>
      <Fieldset title="Data Retention">
        <p style={{ fontSize: 12, color: "var(--gray-600)", marginBottom: 12 }}>
          Job run history and capacity reports are automatically removed after the configured
          number of days. Set to <strong>0</strong> to keep forever.
          The cleanup runs automatically once per day.
        </p>

        <div style={{ display: "flex", gap: "1rem", marginBottom: 12 }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
            <label className="form-label">Job run history (days)</label>
            <input type="number" min={0} max={365} className="form-input"
              value={form.job_run_retention_days ?? 30}
              onChange={e => set("job_run_retention_days" as any, e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
            <label className="form-label">Capacity reports (days)</label>
            <input type="number" min={0} max={365} className="form-input"
              value={form.report_retention_days ?? 30}
              onChange={e => set("report_retention_days" as any, e.target.value)} />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button type="button" className="btn btn-secondary" onClick={runCleanupNow}>
            Run cleanup now
          </button>
          {purgeMsg && <span style={{ fontSize: 12, color: "var(--gray-600)" }}>{purgeMsg}</span>}
        </div>
      </Fieldset>
      <SaveRow status={status} error={error} />
    </form>
  );
}
