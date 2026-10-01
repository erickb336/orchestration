// Settings › delivery: how finished work leaves Orchestrator. It is split in two:
//  - Project › Delivery: the mode (off, a local branch, GitHub pull requests), the remote and base, and who merges;
//  - Advanced › Pull requests and Advanced › GitHub: every other pull-request option, and what the app found on GitHub.
// Both edit their section's draft; nothing here saves by itself. Turning automatic merging on, or loosening what
// guards it, asks first, in an in-page confirmation that says what it means. No preset ever turns it on.

import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { PostureItem, PrDeliveryConfig, State } from "../domain/types";
import { Banner, Button, Checkbox, Field, Input, Select, SimulatedChip, Textarea, type ConfirmOptions } from "./kit";
import { fmtTime, relTime, resumeAutoMergeText } from "./common";
import { CONFIRM_RESET_BASELINE, confirmAutoMerge, confirmRedeliver, confirmResumeAutoMerge } from "./settingsText";
import { useStore, type SendResult } from "./store";
import { intIn } from "./settings/draft";
import { Choice, SettingsCard } from "./settings/parts";
import { cardHref } from "./settings/sections";

type Confirm = (o: ConfirmOptions) => Promise<boolean>;
type Send = (name: Parameters<ReturnType<typeof useStore>["send"]>[0], args?: object) => Promise<SendResult>;

// The domain's own patterns (delivery.ts), so a field says what the save would refuse.
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
const REMOTE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const POSTURE_MARK: Record<PostureItem["status"], string> = { ok: "✓", warn: "!", fail: "×", unverified: "?" };
const POSTURE_WORD: Record<PostureItem["status"], string> = { ok: "fine", warn: "note", fail: "problem", unverified: "unverified" };

/**
 * What stands in the way of automatic merging, or makes it less safe, as the app sees it now. Said before
 * the person turns it on, and in the confirmation.
 */
export function autoMergeWarnings(state: State, real: boolean, o: { reviewer: PrDeliveryConfig["reviewer"]; localOk: boolean; update: boolean }): string[] {
  const p = state.project;
  const gh = p.github;
  const local = p.enabledProviders.filter((x) => p.workerEnvironment[x] === "local");
  const posture = (id: string) => gh?.posture.find((x) => x.id === id);
  return [
    ...(gh?.autoMergeBlockers.length ? [`It cannot merge in this repository yet: ${gh.autoMergeBlockers.join("; ")}. Pull requests will wait for you.`] : []),
    ...(o.reviewer === "other-provider" && p.enabledProviders.length < 2
      ? [`Only ${p.enabledProviders.map(M.providerLabel).join(", ") || "no provider"} is enabled. An independent review needs the other provider: every pull request will wait with "review cannot run" until you enable it or let any agent count.`]
      : []),
    ...(o.reviewer === "any-agent" ? ['With "any agent", the provider that wrote a change may also be the one that reviews it.'] : []),
    ...(local.length && !o.localOk ? [`An agent environment is set to "local" (${local.map(M.providerLabel).join(", ")}), so nothing merges automatically until it is isolated or you allow local agents in Advanced.`] : []),
    ...(local.length && o.localOk ? [`Local agent environments (${local.map(M.providerLabel).join(", ")}) may expose your GitHub sign-in or a GitHub MCP server to agents, and you allow automatic merging anyway.`] : []),
    ...(posture("bypass") ? ["Your GitHub account can bypass the branch rules. The app never does, so for merges the app makes, its own checks are the only barrier."] : []),
    ...(posture("unattributed") ? ['The ruleset may demand an approval from a second account for commits authored by Orchestrator. If it does, pull requests wait with "approval required"; the app never bypasses it. Unverified.'] : []),
    ...(posture("worker-shell") ? ["Claude workers have shell access, so the app cannot claim that only the service reaches GitHub."] : []),
    ...(!o.update ? ['Without "bring up to date before merging", a pull request can merge on a base its checks never ran on.'] : []),
    ...(!gh?.simulated && real ? ["Checked on a GitHub sandbox with scripted agents, not yet with real Claude and Codex agents. Watch the first merges."] : []),
  ];
}

/** Open pull requests that follow the project's merge setting, as the confirmation names them. */
function followingPrs(state: State): string[] {
  return D.trackedPrTasks(state)
    .filter((t) => t.integration!.pr!.policySource === "project")
    .map((t) => (t.integration!.pr!.number ? `#${t.integration!.pr!.number}` : t.id));
}

// ---------- Project › Delivery ----------

export type DeliveryDraft = { pick: D.DeliveryMode; branch: string; remote: string; base: string; merge: PrDeliveryConfig["merge"] };

export function liveDelivery(state: State): DeliveryDraft {
  const cfg = state.project.prDelivery;
  return { pick: D.deliveryMode(state), branch: state.project.autonomy.autoDeliver.branch, remote: cfg.remote, base: cfg.base, merge: cfg.merge };
}

export function deliveryErrors(v: DeliveryDraft) {
  return {
    branch: v.pick === "local" && !BRANCH.test(v.branch.trim()) ? "Name the branch to deliver to." : undefined,
    remote: v.pick === "pr" && !REMOTE.test(v.remote.trim()) ? "Name the remote, for example origin." : undefined,
    base: v.pick === "pr" && !BRANCH.test(v.base.trim()) ? "Name the base branch, for example main." : undefined,
  };
}

/**
 * The commands that save Project › Delivery, in order: the pull-request basics first (so switching on checks
 * the right remote and base), then the mode. Turning automatic merging on asks first; a "no" saves nothing.
 */
export async function deliverySteps(state: State, real: boolean, live: DeliveryDraft, v: DeliveryDraft, changed: { has(k: keyof DeliveryDraft): boolean }, send: Send, confirm: Confirm): Promise<(() => Promise<SendResult> | null)[] | null> {
  const cfg = state.project.prDelivery;
  const prChanged = v.pick === "pr" && (changed.has("remote") || changed.has("base") || changed.has("merge"));
  if (v.pick === "pr" && v.merge === "auto" && cfg.merge !== "auto") {
    const warnings = autoMergeWarnings(state, real, { reviewer: cfg.reviewer, localOk: cfg.allowLocalWorkers, update: cfg.updateBeforeMerge });
    if (!(await confirm(confirmAutoMerge({ turningOn: true, following: followingPrs(state), unprotected: [], reviewer: cfg.reviewer, warnings })))) return null;
  }
  const modeChanged = v.pick !== live.pick || (v.pick === "local" && v.branch.trim() !== live.branch);
  return [
    () => (prChanged ? send("setPrDelivery", { config: { remote: v.remote.trim(), base: v.base.trim(), merge: v.merge } }) : null),
    () => (modeChanged ? send("setDeliveryMode", v.pick === "local" ? { mode: "local", branch: v.branch.trim() } : { mode: v.pick }) : null),
  ];
}

/** Project › Delivery: the mode, and for pull requests the remote, the base and who merges. */
export function DeliveryCard({ v, set, confirm }: { v: DeliveryDraft; set: (p: Partial<DeliveryDraft>) => void; confirm: Confirm }) {
  const { state, service, send } = useStore();
  const p = state.project;
  const mode = D.deliveryMode(state);
  const cfg = p.prDelivery;
  const gh = p.github;
  const d = p.delivery;
  const real = service.runtime === "real";
  const sampleBlocked = real && p.sample;
  const errors = deliveryErrors(v);
  const live = liveDelivery(state);
  // Leaving pull requests drops the unsaved pull-request edits with it, so nothing hidden stays "unsaved".
  const pick = (m: D.DeliveryMode) => set(m === "pr" ? { pick: m } : { pick: m, remote: live.remote, base: live.base, merge: live.merge });
  const undelivered = D.redeliverable(state).filter((t) => !t.integration?.pr);
  const open = D.trackedPrTasks(state).length;
  const canReset = mode !== "pr" && (d?.status === "blocked" || !!d?.lastSha);
  const warnings = v.pick === "pr" && v.merge === "auto" ? autoMergeWarnings(state, real, { reviewer: cfg.reviewer, localOk: cfg.allowLocalWorkers, update: cfg.updateBeforeMerge }) : [];

  return (
    <SettingsCard id="delivery" title="Delivery" help={<>How finished work leaves Orchestrator. Everything that lands is listed under <a href="#/results">Results</a>.</>}>
      <fieldset className="s-choices">
        <legend className="sr-only">Delivery mode</legend>
        <Choice name="delivery-mode" checked={v.pick === "off"} onChange={() => pick("off")} label="Off" description="Finished work stays on the integration branch for you to merge." />
        <Choice name="delivery-mode" checked={v.pick === "local"} onChange={() => pick("local")} label="Local branch" description="Fast-forward a branch of your repository, only when its working tree is clean.">
          <Field label="Branch" error={errors.branch} width="medium">
            <Input type="text" value={v.branch} onChange={(e) => set({ branch: e.target.value })} required />
          </Field>
        </Choice>
        <Choice
          name="delivery-mode"
          checked={v.pick === "pr"}
          onChange={() => pick("pr")}
          disabled={sampleBlocked}
          label="GitHub pull requests"
          aside={!real ? <SimulatedChip title="Simulated: in the demo nothing is sent to GitHub." /> : undefined}
          description={sampleBlocked ? "Not available for the sample project. Start a project of your own first." : "One pull request per finished task, on a branch the app owns."}
        >
          {mode !== "pr" && (
            <p className="s-card-help">
              {real
                ? "Switching on only reads from GitHub, with your own gh sign-in. After that, each finished task is pushed to its own branch and opened as a pull request under your account."
                : "In the demo nothing is sent to GitHub: pull requests, checks and merges are simulated."}
            </p>
          )}
          <div className="s-fields">
            <Field label="Remote" error={errors.remote}>
              <Input type="text" value={v.remote} onChange={(e) => set({ remote: e.target.value })} required />
            </Field>
            <Field label="Base branch" error={errors.base}>
              <Input type="text" value={v.base} onChange={(e) => set({ base: e.target.value })} required />
            </Field>
          </div>
          <fieldset className="s-choices">
            <legend className="k-field__label">Who merges</legend>
            <Choice name="merge-mode" checked={v.merge === "hold"} onChange={() => set({ merge: "hold" })} label="You merge" description="Each pull request waits under Needs you; your Merge goes through only once GitHub's required checks pass." />
            <Choice
              name="merge-mode"
              checked={v.merge === "auto"}
              onChange={() => set({ merge: "auto" })}
              label="Merges automatically"
              description="After a clean independent review and passing required checks, the app merges it under your account. It never bypasses branch rules; you can hold any pull request."
            />
          </fieldset>
          {warnings.length > 0 && (
            <Banner tone="info" title="Before you rely on automatic merging">
              <ul className="plain">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}
          <p className="s-note">
            More pull-request options, and what the app found on GitHub, are in <a href={cardHref("pull-requests")}>Advanced</a>.
          </p>
        </Choice>
      </fieldset>

      {mode !== "pr" && d?.status && (
        <p className="s-note">
          Last local delivery: {d.status === "delivered" ? "landed" : d.status === "blocked" ? "stopped" : d.status === "conflict" ? "conflict" : "waiting"}. {d.message}
        </p>
      )}
      {canReset && (
        <div className="s-gap">
          <Button size="small" onClick={async () => (await confirm(CONFIRM_RESET_BASELINE)) && void send("resetDeliveryBaseline")}>
            Reset delivery baseline
          </Button>
          <p className="s-note">
            {d?.status === "blocked"
              ? "Local delivery stopped because the branch no longer contains work delivered earlier. Reset the baseline once the branch is how you want it."
              : "Use this if you reset or rewrote the delivery branch on purpose. It does not switch delivery on or off."}
          </p>
        </div>
      )}
      {mode !== "pr" && open > 0 && (
        <Banner tone="info" className="s-gap">
          {open} pull request{open === 1 ? " is" : "s are"} still open from when pull-request delivery was on. {open === 1 ? "It is" : "They are"} only watched: nothing is pushed, merged or commented. See <a href="#/results">Results</a>.
        </Banner>
      )}
      {mode === "pr" && gh?.problem && (
        <Banner tone="fail" title="GitHub delivery is stopped" className="s-gap">
          {gh.problem.message} Since {fmtTime(gh.problem.since)}; it is checked again by itself.
        </Banner>
      )}
      {mode === "pr" && gh?.autoMergePaused && (
        <Banner
          tone="you"
          title="Automatic merging is paused"
          className="s-gap"
          actions={
            <Button size="small" onClick={async () => (await confirm(confirmResumeAutoMerge(resumeAutoMergeText(gh.autoMergePaused?.reason)))) && void send("resumeAutoMerge")}>
              Resume automatic merging
            </Button>
          }
        >
          {gh.autoMergePaused.reason}. {gh.autoMergePaused.sticky ? "It is the second failure within a day, so it stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} Nothing is reverted; pull requests wait, and you can
          merge them yourself.
        </Banner>
      )}
      {mode === "pr" && undelivered.length > 0 && (
        <Banner
          tone="info"
          className="s-gap"
          actions={
            <Button
              size="small"
              onClick={async () => {
                const ids = undelivered.slice(0, 20).map((t) => t.id);
                if (await confirm(confirmRedeliver(ids))) void send("redeliver", { taskIds: ids });
              }}
            >
              Deliver {undelivered.length > 20 ? "the first 20" : undelivered.length === 1 ? "it" : "them"} as pull request{undelivered.length === 1 ? "" : "s"}
            </Button>
          }
        >
          {undelivered.length} finished task{undelivered.length === 1 ? " was" : "s were"} never delivered.
        </Banner>
      )}
    </SettingsCard>
  );
}

// ---------- Advanced › Pull requests ----------

export type PrOptionsDraft = {
  maxOpen: string;
  reviewer: PrDeliveryConfig["reviewer"];
  update: boolean;
  repair: boolean;
  localOk: boolean;
  perDay: string;
  paths: string;
  rerunBudget: string;
  bots: string;
  noCi: boolean;
};

export function livePrOptions(state: State): PrOptionsDraft {
  const c = state.project.prDelivery;
  return {
    maxOpen: String(c.maxOpenPrs),
    reviewer: c.reviewer,
    update: c.updateBeforeMerge,
    repair: c.autoRepair,
    localOk: c.allowLocalWorkers,
    perDay: String(c.maxAutoMergesPerDay),
    paths: c.protectedPaths.join("\n"),
    rerunBudget: String(c.rerunBudget),
    bots: c.reviewBotApps.join(", "),
    noCi: c.noCi,
  };
}

const pathList = (paths: string) => paths.split("\n").map((x) => x.trim()).filter(Boolean);
const botList = (bots: string) => bots.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function prOptionsErrors(v: PrOptionsDraft) {
  return {
    maxOpen: intIn(v.maxOpen, 1, 20) === undefined ? "Between 1 and 20." : undefined,
    perDay: intIn(v.perDay, 0, 100) === undefined ? "Between 0 and 100." : undefined,
  };
}

/** The command that saves Advanced › Pull requests. Loosening automatic merging asks first; a "no" saves nothing. */
export async function prOptionsSteps(state: State, real: boolean, v: PrOptionsDraft, changed: ReadonlySet<keyof PrOptionsDraft>, send: Send, confirm: Confirm): Promise<(() => Promise<SendResult> | null)[] | null> {
  if (!changed.size) return [];
  const cfg = state.project.prDelivery;
  const paths = pathList(v.paths);
  const unprotected = cfg.protectedPaths.filter((x) => !paths.includes(x));
  const perDay = Number(v.perDay);
  const capRaised = perDay > cfg.maxAutoMergesPerDay;
  const loosening = cfg.merge === "auto" && ((v.localOk && !cfg.allowLocalWorkers) || (v.reviewer === "any-agent" && cfg.reviewer !== "any-agent") || (!v.update && cfg.updateBeforeMerge) || unprotected.length > 0 || capRaised);
  if (loosening) {
    const warnings = autoMergeWarnings(state, real, { reviewer: v.reviewer, localOk: v.localOk, update: v.update });
    const ok = await confirm(confirmAutoMerge({ turningOn: false, following: followingPrs(state), unprotected, cap: capRaised ? { from: cfg.maxAutoMergesPerDay, to: perDay } : undefined, reviewer: v.reviewer, warnings }));
    if (!ok) return null;
  }
  return [
    () =>
      send("setPrDelivery", {
        config: {
          maxOpenPrs: Number(v.maxOpen),
          reviewer: v.reviewer,
          updateBeforeMerge: v.update,
          autoRepair: v.repair,
          allowLocalWorkers: v.localOk,
          maxAutoMergesPerDay: perDay,
          protectedPaths: paths,
          rerunBudget: Number(v.rerunBudget),
          reviewBotApps: botList(v.bots),
          noCi: v.noCi,
        },
      }),
  ];
}

/** Advanced › Pull requests: every option beyond the mode, the remote, the base and who merges. */
export function PullRequestOptionsCard({ v, set }: { v: PrOptionsDraft; set: (p: Partial<PrOptionsDraft>) => void }) {
  const { state } = useStore();
  const cfg = state.project.prDelivery;
  const errors = prOptionsErrors(v);
  if (!cfg.enabled) {
    return (
      <SettingsCard id="pull-requests" title="Pull requests" help={<>These apply when delivery is GitHub pull requests (<a href={cardHref("delivery")}>Project › Delivery</a>).</>} />
    );
  }
  const auto = cfg.merge === "auto";
  return (
    <SettingsCard id="pull-requests" title="Pull requests" help={<>Options beyond the remote, the base and who merges, which are in <a href={cardHref("delivery")}>Project › Delivery</a>.</>}>
      <div className="s-fields s-fields--wide">
        <Field label="Open pull requests at most" error={errors.maxOpen} hint="More wait until one merges or closes.">
          <Input type="number" min={1} max={20} value={v.maxOpen} onChange={(e) => set({ maxOpen: e.target.value })} />
        </Field>
        <Field label="Which review counts as independent" hint="If the other provider is not enabled, the pull request waits and says so; nothing is swapped in.">
          <Select
            value={v.reviewer}
            onChange={(e) => set({ reviewer: e.target.value as PrDeliveryConfig["reviewer"] })}
            options={[
              { value: "other-provider", label: "Another provider than the one that wrote it" },
              { value: "any-agent", label: "Any agent" },
            ]}
          />
        </Field>
      </div>
      {auto && (
        <>
          <h4 className="s-sub">Automatic merging</h4>
          <Checkbox label={`Bring a pull request up to date with ${cfg.base} before merging, and run its checks again`} hint="What lands is what was tested; one merge per check run." checked={v.update} onChange={(e) => set({ update: e.target.checked })} />
          <Checkbox
            label="Repair automatically"
            hint={`When a required check fails, a review finds problems or the pull request conflicts, one fix task pushes onto the same pull request (at most ${D.PR_LIMITS.repairs}, then it asks you).`}
            checked={v.repair}
            onChange={(e) => set({ repair: e.target.checked })}
          />
          <Checkbox label='Allow automatic merging while an agent environment is "local"' hint="Agents may then reach your GitHub sign-in." checked={v.localOk} onChange={(e) => set({ localOk: e.target.checked })} />
          <Field label="Automatic merges per day at most" error={errors.perDay} width="short">
            <Input type="number" min={0} max={100} value={v.perDay} onChange={(e) => set({ perDay: e.target.value })} />
          </Field>
        </>
      )}
      <Field label="Protected files (one pattern per line)" hint="A pull request that touches these is never merged automatically. A change to .github/workflows/ is pushed only when you allow it for that pull request.">
        <Textarea className="s-mono" rows={5} value={v.paths} onChange={(e) => set({ paths: e.target.value })} />
      </Field>
      <h4 className="s-sub">Failing checks</h4>
      <p className="s-card-help">Only a check that fails on the code starts a fix task; a review bot's verdict and a skipped check wait for you.</p>
      <div className="s-fields s-fields--wide">
        <Field label="Re-run a check GitHub cancelled" hint={`Only GitHub Actions jobs, at most ${D.PR_LIMITS.reruns} per pull request, under your account. Choose 0 if you cancel runs on purpose.`}>
          <Select
            value={v.rerunBudget}
            onChange={(e) => set({ rerunBudget: e.target.value })}
            options={[
              { value: "0", label: "Never" },
              { value: "1", label: "Once per check per head" },
              { value: "2", label: "Twice per check per head" },
              { value: "3", label: "3 times per check per head" },
            ]}
          />
        </Field>
        <Field label="Review bots (GitHub app names, comma-separated)" hint="A failing check from one of these is a bot's opinion: it waits for you. The default names are not verified against a real installation.">
          <Input type="text" className="s-mono" value={v.bots} onChange={(e) => set({ bots: e.target.value })} />
        </Field>
      </div>
      <Checkbox
        label="This repository has no CI"
        hint="Your own Merge then works with no checks; automatic merging still needs a required check. Any check GitHub does report is still honoured."
        checked={v.noCi}
        onChange={(e) => set({ noCi: e.target.checked })}
      />
    </SettingsCard>
  );
}

/** Advanced › GitHub: what the app found on GitHub, read-only, with Check again. Only while delivering pull requests. */
export function GitHubCard() {
  const { state, service, send, disabled } = useStore();
  const p = state.project;
  const gh = p.github;
  const cfg = p.prDelivery;
  if (!cfg.enabled) return null;
  const real = service.runtime === "real";
  return (
    <SettingsCard
      id="github"
      title="What the app found on GitHub"
      help={`Read-only, with your own gh and git sign-in; the app never reads, stores or prints a token.${!gh?.simulated && real ? " Your repository's rules may differ from the sandbox this was checked on: watch the first pull requests." : ""}`}
      actions={
        <Button size="small" disabled={disabled || !!gh?.recheck} loading={!!gh?.recheck} onClick={() => void send("recheckGitHub")}>
          {gh?.recheck ? "Checking…" : "Check again"}
        </Button>
      }
    >
      {!gh?.checkedAt && !gh?.problem && <p className="muted">Not checked yet.</p>}
      {gh?.checkedAt && (
        <dl className="kv">
          <dt>Repository</dt>
          <dd>
            {gh.repo ?? "unknown"}
            {gh.login ? ` as ${gh.login}` : ""}
            {gh.ghVersion ? ` · gh ${gh.ghVersion}` : ""} {gh.simulated && <SimulatedChip title="Simulated: in the demo nothing is read from GitHub." />}
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
    </SettingsCard>
  );
}
