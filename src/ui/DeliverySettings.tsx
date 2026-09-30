// Settings → Delivery: how finished work leaves Orchestration. One mode at a time (off, a local
// branch, or GitHub pull requests), the pull-request options, and the read-only list of what the app
// found on GitHub. Turning pull requests on only reads from GitHub; nothing merges by itself.

import { useEffect, useState } from "react";
import * as D from "../domain/delivery";
import type { PostureItem } from "../domain/types";
import { fmtTime, relTime } from "./common";
import { useStore } from "./store";

const MODE_LABEL: Record<D.DeliveryMode, string> = { off: "Off", local: "Local branch", pr: "GitHub pull requests" };
const POSTURE_MARK: Record<PostureItem["status"], string> = { ok: "✓", warn: "!", fail: "×", unverified: "?" };
const POSTURE_WORD: Record<PostureItem["status"], string> = { ok: "fine", warn: "note", fail: "problem", unverified: "unverified" };

export function DeliverySettings() {
  const { state, service, send, disabled } = useStore();
  const p = state.project;
  const mode = D.deliveryMode(state);
  const cfg = p.prDelivery;
  const gh = p.github;
  const d = p.delivery;
  const real = service.runtime === "real";
  const [pick, setPick] = useState<D.DeliveryMode>(mode);
  const [branch, setBranch] = useState(p.autonomy.autoDeliver.branch);
  const [remote, setRemote] = useState(cfg.remote);
  const [base, setBase] = useState(cfg.base);
  const [maxOpen, setMaxOpen] = useState(String(cfg.maxOpenPrs));
  const [paths, setPaths] = useState(cfg.protectedPaths.join("\n"));
  // Follow the live values when they change elsewhere.
  useEffect(() => setPick(mode), [mode]);
  useEffect(() => setBranch(p.autonomy.autoDeliver.branch), [p.autonomy.autoDeliver.branch]);
  const pathsKey = cfg.protectedPaths.join("\n");
  useEffect(() => {
    setRemote(cfg.remote);
    setBase(cfg.base);
    setMaxOpen(String(cfg.maxOpenPrs));
    setPaths(pathsKey);
  }, [cfg.remote, cfg.base, cfg.maxOpenPrs, pathsKey]);

  const sampleBlocked = real && p.sample;
  const modeChanged = pick !== mode || (pick === "local" && branch.trim() !== p.autonomy.autoDeliver.branch);
  const pathList = paths.split("\n").map((x) => x.trim()).filter(Boolean);
  const optionsChanged = remote.trim() !== cfg.remote || base.trim() !== cfg.base || Number(maxOpen) !== cfg.maxOpenPrs || pathList.join("\n") !== pathsKey;
  const undelivered = D.redeliverable(state).filter((t) => !t.integration?.pr);
  const open = D.trackedPrTasks(state).length;
  const canReset = mode !== "pr" && (d?.status === "blocked" || !!d?.lastSha);

  return (
    <section className="card" aria-labelledby="delivery-settings-h" id="delivery">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="delivery-settings-h" style={{ margin: 0 }}>
          Delivery
        </h2>
        <span className={mode === "off" ? "chip" : "chip strong"}>
          {MODE_LABEL[mode]}
          {mode === "local" ? `: ${p.autonomy.autoDeliver.branch}` : mode === "pr" ? `: ${cfg.remote}/${cfg.base}` : ""}
        </span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
        How finished work leaves Orchestration. One mode at a time. Everything that lands is listed on the <a href="#/review">Review</a> page, which never blocks anything.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send("setDeliveryMode", pick === "local" ? { mode: pick, branch: branch.trim() } : { mode: pick });
        }}
      >
        <fieldset className="plain-fieldset" disabled={disabled}>
          <legend className="sr-only">Delivery mode</legend>
          <label style={{ display: "block", marginBottom: "0.35rem" }}>
            <input type="radio" name="delivery-mode" checked={pick === "off"} onChange={() => setPick("off")} /> <strong>Off.</strong> Finished work stays on the integration branch for you to merge.
          </label>
          <label style={{ display: "block", marginBottom: "0.35rem" }}>
            <input type="radio" name="delivery-mode" checked={pick === "local"} onChange={() => setPick("local")} /> <strong>Local branch.</strong> Fast-forward a branch of your repository, only when its working tree is clean.
          </label>
          {pick === "local" && (
            <label className="row" style={{ gap: "0.4rem", margin: "0 0 0.5rem 1.4rem" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Branch
              </span>
              <input type="text" aria-label="Delivery branch" value={branch} required onChange={(e) => setBranch(e.target.value)} style={{ width: "10rem" }} />
            </label>
          )}
          <label style={{ display: "block", marginBottom: "0.35rem" }}>
            <input type="radio" name="delivery-mode" checked={pick === "pr"} disabled={sampleBlocked} onChange={() => setPick("pr")} /> <strong>GitHub pull requests.</strong> One pull request per finished task, on a
            branch the app owns. It is held for you: you merge it here or on GitHub.
          </label>
          {sampleBlocked && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.4rem 1.4rem" }}>
              Not available for the sample project. Start a project of your own first.
            </p>
          )}
          {pick === "pr" && mode !== "pr" && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.5rem 1.4rem" }}>
              {real
                ? "Switching this on only reads from GitHub, using your own gh sign-in. After that, each finished task is pushed to its own branch and opened as a pull request under your account. Nothing merges by itself. Not verified against GitHub yet."
                : "With the simulated runtime nothing is sent to GitHub: pull requests, checks and merges are simulated and labelled so."}
            </p>
          )}
          <button type="submit" disabled={!modeChanged || (pick === "local" && !branch.trim())}>
            {pick === mode ? "Save delivery mode" : `Switch to ${MODE_LABEL[pick].toLowerCase()}`}
          </button>
        </fieldset>
      </form>

      {mode !== "pr" && d?.status && (
        <p style={{ fontSize: "0.88rem", margin: "0.7rem 0 0" }}>
          Last local delivery: {d.status === "delivered" ? "delivered" : d.status === "blocked" ? "stopped" : d.status === "conflict" ? "conflict" : "waiting"}. <span className="muted">{d.message}</span>
        </p>
      )}
      {canReset && (
        <div style={{ marginTop: "0.6rem" }}>
          <button
            disabled={disabled}
            onClick={() => {
              if (confirm("Forget what was delivered before? The next local delivery starts from the branch as it is now. Do this after you decided what the branch should contain.")) void send("resetDeliveryBaseline");
            }}
          >
            Reset delivery baseline
          </button>
          <div className="muted" style={{ fontSize: "0.82rem", marginTop: "0.25rem" }}>
            {d?.status === "blocked"
              ? "Local delivery stopped because the branch no longer contains work delivered earlier. Reset the baseline once the branch is how you want it, then switch local delivery on again."
              : "Use this if you reset or rewrote the delivery branch on purpose. It does not switch delivery on or off."}
          </div>
        </div>
      )}

      {mode !== "pr" && open > 0 && (
        <div className="banner neutral" role="status" style={{ margin: "0.7rem 0 0" }}>
          {open} pull request{open === 1 ? " is" : "s are"} still open from when pull-request delivery was on. {open === 1 ? "It is" : "They are"} only watched: nothing is pushed, merged or commented. See <a href="#/review">Review</a>.
        </div>
      )}

      {mode === "pr" && (
        <>
          <h3 style={{ marginTop: "1rem" }}>Pull-request options</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send("setPrDelivery", { config: { remote: remote.trim(), base: base.trim(), maxOpenPrs: Number(maxOpen), protectedPaths: pathList } });
            }}
          >
            <fieldset className="plain-fieldset" disabled={disabled}>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <label className="field">
                  <span>Remote</span>
                  <input type="text" value={remote} required onChange={(e) => setRemote(e.target.value)} style={{ width: "8rem" }} />
                </label>
                <label className="field">
                  <span>Base branch</span>
                  <input type="text" value={base} required onChange={(e) => setBase(e.target.value)} style={{ width: "10rem" }} />
                </label>
                <label className="field">
                  <span>Open pull requests at most</span>
                  <input type="number" min={1} max={20} value={maxOpen} onChange={(e) => setMaxOpen(e.target.value)} style={{ width: "5rem" }} />
                </label>
              </div>
              <label className="field">
                <span>When a pull request is ready</span>
                <select value="hold" onChange={() => undefined} aria-describedby="merge-mode-note">
                  <option value="hold">Hold and notify me</option>
                  <option value="auto" disabled>
                    Merge automatically after an independent review and passing required checks (not available yet)
                  </option>
                </select>
              </label>
              <p id="merge-mode-note" className="muted" style={{ fontSize: "0.82rem", margin: "-0.3rem 0 0.6rem" }}>
                You merge each pull request, here or on GitHub. A Merge click here is tied to the commit you saw and goes through only once GitHub's required checks and rules pass. Automatic merging is not built yet.
              </p>
              <label className="field">
                <span>Protected files (one pattern per line)</span>
                <textarea value={paths} onChange={(e) => setPaths(e.target.value)} style={{ minHeight: "5.5rem" }} className="mono" />
              </label>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "-0.3rem 0 0.6rem" }}>
                A pull request that touches these is marked. A change to CI workflow files (.github/workflows/) is not pushed until you allow it for that pull request.
              </p>
              <button type="submit" disabled={!optionsChanged}>
                Save pull-request options
              </button>
            </fieldset>
          </form>

          {undelivered.length > 0 && (
            <div className="banner neutral" role="status" style={{ margin: "0.8rem 0 0" }}>
              {undelivered.length} integrated task{undelivered.length === 1 ? " was" : "s were"} never delivered.{" "}
              <button
                className="small"
                disabled={disabled}
                onClick={() => {
                  const ids = undelivered.slice(0, 20).map((t) => t.id);
                  if (confirm(`Open ${ids.length} pull request${ids.length === 1 ? "" : "s"} for ${ids.join(", ")}?`)) void send("redeliver", { taskIds: ids });
                }}
              >
                Deliver {undelivered.length > 20 ? "the first 20" : undelivered.length === 1 ? "it" : "them"} as pull request{undelivered.length === 1 ? "" : "s"}
              </button>
            </div>
          )}

          <div className="row" style={{ justifyContent: "space-between", marginTop: "1rem" }}>
            <h3 style={{ margin: 0 }}>What the app found on GitHub{gh?.simulated ? " (simulated)" : ""}</h3>
            <button className="small" disabled={disabled || !!gh?.recheck} onClick={() => void send("recheckGitHub")}>
              {gh?.recheck ? "Checking…" : "Check again"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: "0.82rem", margin: "0.3rem 0 0" }}>
            Read-only. The app uses your own gh and git sign-in and never reads, stores or prints a token.
            {!gh?.simulated && real ? " Pull-request delivery is not verified against GitHub yet." : ""}
          </p>
          {gh?.problem && (
            <div className="banner danger" role="alert" style={{ margin: "0.5rem 0 0" }}>
              <strong>GitHub delivery is stopped.</strong> {gh.problem.message} <span className="muted">Since {fmtTime(gh.problem.since)}. It is checked again by itself.</span>
            </div>
          )}
          {!gh?.checkedAt && !gh?.problem && <p className="muted">Not checked yet.</p>}
          {gh?.checkedAt && (
            <dl className="kv" style={{ marginTop: "0.5rem" }}>
              <dt>Repository</dt>
              <dd>
                {gh.repo ?? "unknown"}
                {gh.login ? ` as ${gh.login}` : ""}
                {gh.ghVersion ? ` · gh ${gh.ghVersion}` : ""}
              </dd>
              <dt>Checked</dt>
              <dd title={fmtTime(gh.checkedAt)}>{relTime(gh.checkedAt)}</dd>
              <dt>Base</dt>
              <dd>
                {gh.base ? (
                  <>
                    <span className="mono">{gh.base.sha.slice(0, 12)}</span> fetched <span title={fmtTime(gh.base.fetchedAt)}>{relTime(gh.base.fetchedAt)}</span>; new work starts from it
                  </>
                ) : (
                  `Not fetched yet; coders wait for the first fetch of ${cfg.remote}/${cfg.base}`
                )}
              </dd>
            </dl>
          )}
          {gh && gh.posture.length > 0 && (
            <ul className="checklist" aria-label="GitHub posture">
              {gh.posture.map((it) => (
                <li key={it.id} className={it.status === "ok" ? "done" : undefined}>
                  <span className="check" aria-hidden="true">
                    {POSTURE_MARK[it.status]}
                  </span>
                  <span>
                    <span className="label">{it.label}</span>
                    <span className="sr-only"> ({POSTURE_WORD[it.status]})</span>
                    <div className="detail muted">{it.detail}</div>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.8rem 0 0" }}>
        Deliveries and merges happen only while this service is running. No preset turns on publishing or merging.
      </p>
    </section>
  );
}
