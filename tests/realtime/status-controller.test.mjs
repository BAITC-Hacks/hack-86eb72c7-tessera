import assert from "node:assert/strict";
import { test } from "node:test";
import "./load-typescript.mjs";

const { RunStatusController, viewForRun } = await import("../../lib/realtime/status-controller.ts");

const initial = Object.freeze({ projectId: "p1", runId: "r1", stateVersion: 1, status: "running", stage: "validate" });
const event = (overrides = {}) => ({ type: "run.updated", projectId: "p1", runId: "r1", stateVersion: 2,
  status: "succeeded", stage: "explain", emittedAt: "2026-09-23T10:00:00.000Z", ...overrides });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { due: time + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const end = time + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, item]) => item.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        time = due[1].due;
        timers.delete(due[0]);
        due[1].fn();
      }
      time = end;
    },
    due: () => [...timers.values()].map((item) => item.due).sort((a, b) => a - b),
    count: () => timers.size,
  };
}

test("events only trigger confirmed reread; forged version and stale snapshot cannot advance status", async () => {
  const clock = fakeClock();
  const results = [{ ...initial, stateVersion: 4, stage: "forecast" }, { ...initial, stateVersion: 2, status: "succeeded" }];
  let calls = 0;
  const updates = [];
  const controller = new RunStatusController(initial, async () => { calls++; return results.shift(); }, (view) => updates.push(view), clock);
  controller.start();
  clock.tick(0); await flush();
  assert.equal(controller.current.snapshot.stateVersion, 4);
  assert.equal(controller.current.snapshot.status, "running");
  controller.onEvent(event({ stateVersion: 999_999 }));
  assert.equal(controller.current.snapshot.stateVersion, 4);
  assert.deepEqual(clock.due(), [1_000]);
  clock.tick(1_000); await flush();
  assert.equal(calls, 2);
  assert.equal(controller.current.snapshot.stateVersion, 4);
  assert.equal(controller.current.snapshot.status, "running");
  assert.equal(controller.current.delayed, true);
  controller.onEvent(event({ projectId: "foreign" }));
  assert.equal(calls, 2);
  assert.ok(updates.length >= 2);
  controller.dispose();
  assert.equal(clock.count(), 0);
});

test("failed polls back off; focus and reconnect resync; terminal state stops timers", async () => {
  const clock = fakeClock();
  let calls = 0;
  const controller = new RunStatusController(initial, async () => {
    calls++;
    if (calls <= 2) throw new Error("offline");
    return { ...initial, stateVersion: 3, status: "succeeded", stage: "explain" };
  }, () => {}, clock);
  controller.start();
  clock.tick(0); await flush();
  assert.equal(controller.current.delayed, true);
  assert.deepEqual(clock.due(), [10_000]);
  clock.tick(10_000); await flush();
  assert.deepEqual(clock.due(), [30_000]);
  controller.setConnected(true);
  assert.equal(controller.current.connected, true);
  assert.deepEqual(clock.due(), [11_000]);
  clock.tick(1_000); await flush();
  assert.equal(controller.current.snapshot.status, "succeeded");
  assert.equal(controller.current.delayed, false);
  assert.equal(clock.count(), 0);
  controller.focus();
  controller.onEvent(event());
  assert.equal(clock.count(), 0);
  controller.dispose();
});

test("scope change disposal aborts old fetch and late response cannot update old or new run", async () => {
  const clock = fakeClock();
  const late = deferred();
  let aborted = false;
  const oldUpdates = [];
  const old = new RunStatusController(initial, (signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return late.promise;
  }, (view) => oldUpdates.push(view), clock);
  old.start();
  clock.tick(0);
  const newInitial = { ...initial, runId: "r2", stateVersion: 0 };
  old.dispose();
  assert.equal(aborted, true);
  const newer = new RunStatusController(newInitial, async () => ({ ...newInitial, stateVersion: 1 }), () => {}, clock);
  newer.start();
  clock.tick(0); await flush();
  late.resolve({ ...initial, stateVersion: 999, status: "succeeded" });
  await flush();
  assert.equal(oldUpdates.length, 0);
  assert.equal(newer.current.snapshot.runId, "r2");
  assert.equal(newer.current.snapshot.stateVersion, 1);
  newer.dispose();
  assert.equal(clock.count(), 0);
});

test("in-flight events coalesce and invalid events never request a read", async () => {
  const clock = fakeClock();
  const pending = deferred();
  let calls = 0;
  const controller = new RunStatusController(initial, async () => { calls++; return calls === 1 ? pending.promise : { ...initial, stateVersion: 2 }; }, () => {}, clock);
  controller.start();
  clock.tick(0);
  controller.onEvent(event({ status: "invented" }));
  assert.equal(calls, 1);
  for (let index = 0; index < 20; index++) controller.onEvent(event({ stateVersion: index + 100 }));
  pending.resolve(initial);
  await flush();
  assert.deepEqual(clock.due(), [1_000]);
  clock.tick(1_000); await flush();
  assert.equal(calls, 2);
  controller.dispose();
});

test("equal version with contradictory status does not overwrite confirmed state", async () => {
  const clock = fakeClock();
  const controller = new RunStatusController(initial, async () => ({ ...initial, status: "succeeded", stage: "explain" }), () => {}, clock);
  controller.start();
  clock.tick(0); await flush();
  assert.equal(controller.current.snapshot.status, "running");
  assert.equal(controller.current.snapshot.stage, "validate");
  assert.equal(controller.current.delayed, true);
  controller.dispose();
});

test("a changed run is masked synchronously before effects replace its controller", () => {
  const previous = { snapshot: initial, lastConfirmedAt: 12_345, delayed: true, connected: false };
  const next = { ...initial, projectId: "p2", runId: "r2", stateVersion: 0 };
  assert.deepEqual(viewForRun(previous, next, true), {
    snapshot: next, lastConfirmedAt: 0, delayed: false, connected: true,
  });
  assert.equal(viewForRun(previous, initial, true), previous);
});

test("hung fetch hits deadline, aborts, backs off and ignores a late response", async () => {
  const clock = fakeClock();
  const late = deferred();
  let firstSignal;
  let calls = 0;
  const controller = new RunStatusController(initial, (signal) => {
    calls++;
    if (calls === 1) { firstSignal = signal; return late.promise; }
    return Promise.resolve({ ...initial, stateVersion: 2, stage: "forecast" });
  }, () => {}, clock);
  controller.start();
  clock.tick(0);
  assert.deepEqual(clock.due(), [8_000]);
  clock.tick(8_000); await flush();
  assert.equal(firstSignal.aborted, true);
  assert.equal(controller.current.delayed, true);
  assert.equal(controller.current.snapshot.stateVersion, 1);
  assert.deepEqual(clock.due(), [18_000]);
  late.resolve({ ...initial, stateVersion: 999, status: "succeeded" });
  await flush();
  assert.equal(controller.current.snapshot.stateVersion, 1);
  clock.tick(10_000); await flush();
  assert.equal(calls, 2);
  assert.equal(controller.current.snapshot.stateVersion, 2);
  controller.dispose();
  assert.equal(clock.count(), 0);
});

test("dispose clears an active read deadline even when fetch ignores abort", async () => {
  const clock = fakeClock();
  const late = deferred();
  let aborted = false;
  const updates = [];
  const controller = new RunStatusController(initial, (signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return late.promise;
  }, (view) => updates.push(view), clock);
  controller.start();
  clock.tick(0);
  assert.deepEqual(clock.due(), [8_000]);
  controller.dispose();
  await flush();
  assert.equal(aborted, true);
  assert.equal(clock.count(), 0);
  late.resolve({ ...initial, stateVersion: 100, status: "succeeded" });
  await flush();
  assert.deepEqual(updates, []);
  assert.equal(clock.count(), 0);
});
