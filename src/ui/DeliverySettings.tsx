// Settings → Delivery: how finished work leaves Orchestration. One mode at a time (off, a local
// branch, or GitHub pull requests), the pull-request options, and the read-only list of what the app
// found on GitHub. Turning pull requests on only reads from GitHub. Merging automatically is a
// separate, explicit choice with its own warnings; no preset makes it.

import { useEffect, useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { PostureItem, PrDeliveryConfig } from "../domain/types";
import { fmtTime, relTime, resumeAutoMergeText } from "./common";
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
  const [merge, setMerge] = useState<PrDeliveryConfig["merge"]>(cfg.merge);
  const [reviewer, setReviewer] = useState<PrDeliveryConfig["reviewer"]>(cfg.reviewer);
  const [update, setUpdate] = useState(cfg.updateBeforeMerge);
  const [repair, setRepair] = useState(cfg.autoRepair);
  const [localOk, setLocalOk] = useState(cfg.allowLocalWorkers);
  const [perDay, setPerDay] = useState(String(cfg.maxAutoMergesPerDay));
  // Follow the live values when they change elsewhere.
  useEffect(() => setPick(mode), [mode]);
  useEffect(() => setBranch(p.autonomy.autoDeliver.branch), [p.autonomy.autoDeliver.branch]);
  const pathsKey = cfg.protectedPaths.join("\n");
  useEffect(() => {
    setRemote(cfg.remote);
    setBase(cfg.base);
    setMaxOpen(String(cfg.maxOpenPrs));
    setPaths(pathsKey);
    setMerge(cfg.merge);
    setReviewer(cfg.reviewer);
    setUpdate(cfg.updateBeforeMerge);
    setRepair(cfg.autoRepair);
    setLocalOk(cfg.allowLocalWorkers);
    setPerDay(String(cfg.maxAutoMergesPerDay));
  }, [cfg.remote, cfg.base, cfg.maxOpenPrs, pathsKey, cfg.merge, cfg.reviewer, cfg.updateBeforeMerge, cfg.autoRepair, cfg.allowLocalWorkers, cfg.maxAutoMergesPerDay]);

  const sampleBlocked = real && p.sample;
  const modeChanged = pick !== mode || (pick === "local" && branch.trim() !== p.autonomy.autoDeliver.branch);
  const pathList = paths.split("\n").map((x) => x.trim()).filter(Boolean);
  const optionsChanged =
    remote.trim() !== cfg.remote ||
    base.trim() !== cfg.base ||
    Number(maxOpen) !== cfg.maxOpenPrs ||
    pathList.join("\n") !== pathsKey ||
    merge !== cfg.merge ||
    reviewer !== cfg.reviewer ||
    update !== cfg.updateBeforeMerge ||
    repair !== cfg.autoRepair ||
    localOk !== cfg.allowLocalWorkers ||
    Number(perDay) !== cfg.maxAutoMergesPerDay;
  // What stands in the way of automatic merging, or makes it less safe, as the app sees it now.
  const local = p.enabledProviders.filter((x) => p.workerEnvironment[x] === "local");
  const posture = (id: string) => gh?.posture.find((x) => x.id === id);
  const autoWarnings: string[] = [
    ...(gh?.autoMergeBlockers.length ? [`It cannot merge in this repository yet: ${gh.autoMergeBlockers.join("; ")}. Pull requests will wait for you.`] : []),
    ...(reviewer === "other-provider" && p.enabledProviders.length < 2
      ? [`Only ${p.enabledProviders.map(M.providerLabel).join(", ") || "no provider"} is enabled. An independent review needs the other provider: every pull request will wait with "review cannot run" until you enable it or let any agent count.`]
      : []),
    ...(reviewer === "any-agent" ? ["With \"any agent\", the provider that wrote a change may also be the one that reviews it."] : []),
    ...(local.length && !localOk ? [`A worker environment is set to "local" (${local.map(M.providerLabel).join(", ")}), so nothing merges automatically until it is isolated or you allow local workers below.`] : []),
    ...(local.length && localOk ? [`Local worker environments (${local.map(M.providerLabel).join(", ")}) may expose your GitHub sign-in or a GitHub MCP server to agents, and you allow automatic merging anyway.`] : []),
    ...(posture("bypass") ? ["Your GitHub account can bypass the branch rules. The app never does, so for merges the app makes, its own checks are the only barrier."] : []),
    ...(posture("unattributed") ? ["The ruleset may demand an approval from a second account for commits authored by Orchestrator. If it does, pull requests wait with \"approval required\"; the app never bypasses it. Unverified."] : []),
    ...(posture("worker-shell") ? ["Claude workers have shell access, so the app cannot claim that only the service reaches GitHub."] : []),
    ...(!update ? ["Without \"bring up to date before merging\", a pull request can merge on a base its checks never ran on."] : []),
    ...(!gh?.simulated && real ? ["Checked on a GitHub sandbox with scripted agents, not yet with real Claude and Codex workers. Watch the first merges."] : []),
  ];
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
        How finished work leaves Orchestrator. One mode at a time. Everything that lands is listed on the <a href="#/review">Review</a> page, which never blocks anything.
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
            branch the app owns. It is held for you to merge, unless you choose automatic merging below.
          </label>
          {sampleBlocked && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.4rem 1.4rem" }}>
              Not available for the sample project. Start a project of your own first.
            </p>
          )}
          {pick === "pr" && mode !== "pr" && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.5rem 1.4rem" }}>
              {real
                ? "Switching this on only reads from GitHub, using your own gh sign-in. After that, each finished task is pushed to its own branch and opened as a pull request under your account. Nothing merges by itself unless you also choose automatic merging, which is a separate setting."
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
          {gh?.autoMergePaused && (
            <div className="banner danger" role="alert" style={{ margin: "0.5rem 0" }}>
              <strong>Automatic merging is paused:</strong> {gh.autoMergePaused.reason}. {gh.autoMergePaused.sticky ? "It is the second failure within a day, so it stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} Nothing is reverted automatically; pull
              requests wait, and you can merge them yourself.{" "}
              <button className="small" disabled={disabled} onClick={() => {
              if (confirm(resumeAutoMergeText(gh?.autoMergePaused?.reason))) void send("resumeAutoMerge");
            }}>
                Resume automatic merging
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // Consent: turning automatic merging on (or loosening what guards it) is confirmed, with what it means.
              const turningOn = merge === "auto" && cfg.merge !== "auto";
              // Protected files that are no longer protected, and a higher daily cap, loosen it too.
              const unprotected = cfg.protectedPaths.filter((x) => !pathList.includes(x));
              const capRaised = Number(perDay) > cfg.maxAutoMergesPerDay;
              const loosening =
                merge === "auto" && ((localOk && !cfg.allowLocalWorkers) || (reviewer === "any-agent" && cfg.reviewer !== "any-agent") || (!update && cfg.updateBeforeMerge) || unprotected.length > 0 || capRaised);
              // The project's choice also applies to every pull request that is already open and follows it.
              const following = D.trackedPrTasks(state).filter((t) => t.integration!.pr!.policySource === "project");
              if (turningOn || loosening) {
                const text = [
                  turningOn ? "Merge pull requests automatically?" : "Save these changes to automatic merging?",
                  "",
                  ...(turningOn
                    ? [
                        following.length
                          ? `This applies to new pull requests and to the ${following.length} pull request${following.length === 1 ? "" : "s"} already open (${following
                              .slice(0, 8)
                              .map((t) => (t.integration!.pr!.number ? `#${t.integration!.pr!.number}` : t.id))
                              .join(", ")}${following.length > 8 ? ", …" : ""}): ${following.length === 1 ? "it" : "they"} will merge by ${following.length === 1 ? "itself" : "themselves"} too. Hold any you want to merge yourself.`
                          : "This applies to new pull requests and to any pull request already open that follows the project's setting.",
                        "",
                      ]
                    : []),
                  ...(!turningOn && unprotected.length
                    ? [`No longer protected: ${unprotected.join(", ")}. Pull requests that touch ${unprotected.length === 1 ? "it" : "them"}, including ones already open, may then merge automatically.`, ""]
                    : []),
                  ...(!turningOn && capRaised ? [`The daily limit goes from ${cfg.maxAutoMergesPerDay} to ${Number(perDay)} automatic merges. Pull requests that were waiting for tomorrow may merge today.`, ""] : []),
                  "The app will merge a pull request by itself, under your GitHub account, only when all of this holds for the exact commit:",
                  `- an independent agent review is clean (${reviewer === "any-agent" ? "by any agent" : "by another provider than the one that wrote the change"});`,
                  "- every check the repository requires has passed;",
                  "- GitHub reports it mergeable;",
                  "- it touches no protected file, and nothing is paused or held.",
                  "",
                  "It never bypasses branch rules, never uses GitHub's own auto-merge and never forces a push. An agent review is not a human review.",
                  ...(autoWarnings.length ? ["", "Before you confirm:", ...autoWarnings.map((w) => `- ${w}`)] : []),
                ].join("\n");
                if (!confirm(text)) return;
              }
              void send("setPrDelivery", {
                config: { remote: remote.trim(), base: base.trim(), maxOpenPrs: Number(maxOpen), protectedPaths: pathList, merge, reviewer, updateBeforeMerge: update, autoRepair: repair, allowLocalWorkers: localOk, maxAutoMergesPerDay: Number(perDay) },
              });
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
                <select value={merge} onChange={(e) => setMerge(e.target.value as PrDeliveryConfig["merge"])} aria-describedby="merge-mode-note">
                  <option value="hold">Hold and notify me</option>
                  <option value="auto">Merge automatically after an independent review and passing required checks</option>
                </select>
              </label>
              <p id="merge-mode-note" className="muted" style={{ fontSize: "0.82rem", margin: "-0.3rem 0 0.6rem" }}>
                {merge === "auto"
                  ? "The app merges a pull request by itself, one at a time, only when an independent review is clean for exactly that change, every required check passed on its head, GitHub reports it mergeable, and it touches no protected file. It never bypasses branch rules, never uses GitHub's own auto-merge and never forces. You can hold or merge any pull request yourself at any time."
                  : "You merge each pull request, here or on GitHub. A Merge click here is tied to the commit you saw and goes through only once GitHub's required checks and rules pass. Each pull request is still reviewed by an independent agent, and you are told once when it is ready."}
              </p>
              {merge === "auto" && autoWarnings.length > 0 && (
                <div className="banner neutral" role="note" style={{ margin: "0 0 0.6rem" }}>
                  <strong>Before you rely on automatic merging:</strong>
                  <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}>
                    {autoWarnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="field">
                <span>Which review counts as independent</span>
                <select value={reviewer} onChange={(e) => setReviewer(e.target.value as PrDeliveryConfig["reviewer"])}>
                  <option value="other-provider">A review by another provider than the one that wrote the change</option>
                  <option value="any-agent">A review by any agent</option>
                </select>
              </label>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "-0.3rem 0 0.6rem" }}>
                The task's own review counts when it saw the final change. Otherwise one dedicated review task is started for the pull request. The app never swaps in another provider by itself: if the other provider is not enabled, the pull request waits and says so.
              </p>
              {merge === "auto" && (
                <>
                  <label style={{ display: "block", marginBottom: "0.35rem" }}>
                    <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Bring a pull request up to date with {base.trim() || cfg.base} before merging it, and run its checks again (what lands is what was tested; one merge per check run)
                  </label>
                  <label style={{ display: "block", marginBottom: "0.35rem" }}>
                    <input type="checkbox" checked={repair} onChange={(e) => setRepair(e.target.checked)} /> Repair automatically: when a required check fails, a review finds problems or the pull request conflicts, create one fix task whose result is pushed onto the same pull request (at most {D.PR_LIMITS.repairs} per
                    pull request, then it asks you)
                  </label>
                  <label style={{ display: "block", marginBottom: "0.35rem" }}>
                    <input type="checkbox" checked={localOk} onChange={(e) => setLocalOk(e.target.checked)} /> Allow automatic merging while a worker environment is "local" (agents may then reach your GitHub sign-in)
                  </label>
                  <label className="field">
                    <span>Automatic merges per day at most (0 to 100)</span>
                    <input type="number" min={0} max={100} value={perDay} onChange={(e) => setPerDay(e.target.value)} style={{ width: "5rem" }} />
                  </label>
                </>
              )}
              <label className="field">
                <span>Protected files (one pattern per line)</span>
                <textarea value={paths} onChange={(e) => setPaths(e.target.value)} style={{ minHeight: "5.5rem" }} className="mono" />
              </label>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "-0.3rem 0 0.6rem" }}>
                A pull request that touches these is never merged automatically: you merge it. A change to CI workflow files (.github/workflows/) is not pushed until you allow it for that pull request.
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
            {!gh?.simulated && real ? " Your repository's rules may differ from the sandbox this was checked on: watch the first pull requests." : ""}
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
        Deliveries, reviews and merges happen only while this service is running. No preset turns on publishing or automatic merging.
      </p>
    </section>
  );
}
