// The "change-order" journey (ORC-030 QA): a new design while the factory runs, its Lock in, and the change order the
// lead answers, with Undo, at 1280 and 375 wide.
//
// Sample data: a fixture built through the real commands (after src/domain/testing/changeOrders.ts). The factory runs
// from blueprint r1 (Trip plan, Trip list, Reminders). Four tasks cite it: one runs, one waits, one builds only
// Reminders, and one has finished. In round 2 the designer made Trip plan v2 and a new Packing list, and the PE agreed.
// The runtime is the fake one, and the scheduler runs, so the simulated lead answers the change order.
//
// Run: ORCHESTRATION_TEST_PORT=5996 node --import tsx scripts/qa/change-order.mjs

import { resolve } from "node:path";
import * as M from "../../src/domain/model.ts";
import { buildSeed } from "../../src/domain/seed.ts";
import * as B from "../../src/domain/studio/blueprint.ts";
import { at, leadTaskCiting, startTask, taskCiting } from "../../src/domain/testing/changeOrders.ts";
import { startFactoryAsOwner } from "../../src/domain/testing/factory.ts";
import { addScreen, feedback, openRound, pePass, run } from "../../src/domain/testing/studio.ts";

const MANUAL = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };

/** A screen of one take in the round, which the PE agreed to. */
function screen(s, round, title, sec, over = {}) {
  const a = addScreen(s, round, at(sec), { title, variants: [], ...over });
  return { s: pePass(a.state, a.id, a.version, [{ verdict: "feasible" }], at(sec)), id: a.id };
}

/** The fixture: the factory runs from r1, and round 2 holds Trip plan v2 and Packing list, ready for the owner. */
export function scene() {
  let s = M.initProject(buildSeed(Date.parse(at(0)), { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
  s = openRound(s, "experience", at(1)).state;
  const plan = screen(s, 1, "Trip plan", 2);
  const list = screen(plan.s, 1, "Trip list", 3);
  const remind = screen(list.s, 1, "Reminders", 4);
  s = startFactoryAsOwner(run(remind.s, "approveRound", { round: 1 }, at(5)).state, at(6), MANUAL);
  const item = (artifactId) => B.blueprintItems(s).find((i) => i.artifactId === artifactId).id;
  const ids = { plan: item(plan.id), list: item(list.id), remind: item(remind.id) };
  const running = taskCiting(s, [ids.plan], "Trip plan screen", 7);
  const queued = taskCiting(running.s, [ids.plan, ids.list], "Trip list screen", 8);
  const retiring = leadTaskCiting(queued.s, [ids.remind], "Outing reminders", 9);
  const early = taskCiting(retiring.s, [ids.plan], "Early trip plan", 10);
  s = structuredClone(startTask(early.s, running.id, 11));
  s.tasks.find((t) => t.id === early.id).lifecycle = "done";
  // Round 2: the owner's note on Trip plan v1, then the designer's v2 and a new Packing list, both agreed by the PE.
  s = feedback(s, plan.id, 1, { mark: "change", note: "Day list first, the map below it." }, at(12));
  s = openRound(run(s, "closeRound", { round: 1 }, at(12)).state, "experience", at(12)).state;
  const v2 = addScreen(s, 2, at(13), { artifactId: plan.id, title: "Trip plan", variants: [] });
  s = pePass(v2.state, plan.id, 2, [{ verdict: "feasible" }], at(13));
  const packing = screen(s, 2, "Packing list", 14);
  return { s: packing.s, art: { plan: plan.id, packing: packing.id }, ids, tasks: { running: running.id, queued: queued.id, retiring: retiring.id, early: early.id } };
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const { runJourney, text } = await import("./harness.mjs");
  await runJourney("change-order", () => scene().s, journeyBody, { service: { run: true }, ...(process.env.QA_WIDTH ? { widths: [Number(process.env.QA_WIDTH)] } : {}) });
}

async function journeyBody(j, page, service, width) {
  j.note(`width ${width}`);
}
