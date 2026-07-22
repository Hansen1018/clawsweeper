import assert from "node:assert/strict";

export function evaluateStateModel(scenario) {
  const state = initialState();
  if (scenario === "pending-run-replacement") pendingRunReplacement(state);
  else if (scenario === "duplicate-command-replay") duplicateCommandReplay(state);
  else if (scenario === "crash-after-intent") crashAfterIntent(state);
  else if (scenario === "crash-after-merge-before-outcome") crashAfterMerge(state);
  else if (scenario.endsWith("-drift-before-mutation")) mutationSensitiveDrift(state, scenario);
  else throw new Error(`unsupported state model scenario: ${scenario}`);
  return state;
}

function initialState() {
  return {
    activeRun: null,
    commandDurable: false,
    deliveries: new Set(),
    eventSequence: [],
    intentDurable: false,
    mergeCallCount: 0,
    merged: false,
    outcomeCount: 0,
    repairCompleted: false,
    repairCallCount: 0,
    snapshot: readinessSnapshot(),
    current: readinessSnapshot(),
  };
}

function pendingRunReplacement(state) {
  event(state, "command-durable");
  state.commandDurable = true;
  startRun(state, "run-1");
  event(state, "router-run-replaced");
  state.activeRun = null;
  reconcile(state, "run-2");
  assert.equal(state.activeRun, "run-2");
  assert.equal(state.intentDurable, true);
  assert.equal(state.repairCallCount, 1);
  state.actualOutcome = "replacement-run-recovered-command";
  state.terminalProductState = "recovered";
  state.invariant = "a replaced pending run cannot erase its durable command fact";
}

function duplicateCommandReplay(state) {
  receiveDelivery(state, "delivery-1");
  receiveDelivery(state, "delivery-1");
  receiveDelivery(state, "delivery-2");
  completeOutcome(state);
  completeOutcome(state);
  assert.equal(state.repairCallCount, 1);
  assert.equal(state.outcomeCount, 1);
  state.actualOutcome = "duplicate-delivery-collapsed";
  state.terminalProductState = "recovered";
  state.invariant = "duplicate command and delivery replays produce one intent and outcome";
}

function crashAfterIntent(state) {
  event(state, "command-durable");
  state.commandDurable = true;
  durableIntent(state);
  crash(state);
  reconcile(state, "reconciler-1");
  completeOutcome(state);
  assert.equal(state.repairCallCount, 1);
  assert.equal(state.outcomeCount, 1);
  state.actualOutcome = "intent-reconciled";
  state.terminalProductState = "recovered";
  state.invariant = "a crash after durable intent cannot lose or duplicate repair work";
}

function crashAfterMerge(state) {
  durableIntent(state);
  mergeOnce(state);
  crash(state);
  reconcile(state, "reconciler-1");
  completeOutcome(state);
  reconcile(state, "reconciler-2");
  assert.equal(state.mergeCallCount, 1);
  assert.equal(state.outcomeCount, 1);
  state.actualOutcome = "merged-outcome-reconciled";
  state.terminalProductState = "recovered";
  state.invariant = "a crash after merge writes one outcome without a second merge call";
}

function mutationSensitiveDrift(state, scenario) {
  event(state, "exact-head-verdict");
  const field = scenario.slice(0, -"-drift-before-mutation".length);
  if (field === "head") state.current.head = "head-2";
  else if (field === "base") state.current.base = "base-2";
  else if (field === "check") state.current.check = "pending";
  else if (field === "review") state.current.review = "changes_requested";
  else if (field === "permission") state.current.permission = "read";
  else if (field === "protected-label") state.current.protectedLabel = true;
  else throw new Error(`unsupported drift field: ${field}`);
  event(state, `${field}-drift`);
  const block = readinessBlock(state.snapshot, state.current);
  event(state, "pre-mutation-snapshot-refresh");
  if (!block) mergeOnce(state);
  assert.ok(block, `${field} drift must block`);
  assert.equal(state.mergeCallCount, 0);
  state.actualOutcome = `blocked:${block}`;
  state.terminalProductState = "blocked";
  state.invariant = `${field} drift after verdict must stop before merge mutation`;
}

function readinessSnapshot() {
  return {
    base: "base-1",
    check: "success",
    head: "head-1",
    permission: "write",
    protectedLabel: false,
    review: "approved",
  };
}

function readinessBlock(snapshot, current) {
  if (current.head !== snapshot.head) return "head-drift";
  if (current.base !== snapshot.base) return "base-drift";
  if (current.check !== "success") return "check-drift";
  if (current.review !== "approved") return "review-drift";
  if (current.permission !== "write") return "permission-drift";
  if (current.protectedLabel) return "protected-label-drift";
  return null;
}

function receiveDelivery(state, delivery) {
  event(state, `delivery:${delivery}`);
  if (state.deliveries.has(delivery) || state.intentDurable) return;
  state.deliveries.add(delivery);
  durableIntent(state);
  executeIntent(state);
}

function durableIntent(state) {
  if (state.intentDurable) return;
  event(state, "intent-durable");
  state.intentDurable = true;
}

function executeIntent(state) {
  if (!state.intentDurable || state.repairCompleted) return;
  event(state, "repair-completed");
  state.repairCompleted = true;
  state.repairCallCount += 1;
}

function startRun(state, run) {
  event(state, `run-started:${run}`);
  state.activeRun = run;
}

function reconcile(state, run) {
  event(state, `reconcile:${run}`);
  if (state.merged) {
    completeOutcome(state);
    return;
  }
  if (state.commandDurable && !state.intentDurable) {
    startRun(state, run);
    durableIntent(state);
  }
  if (state.intentDurable && !state.repairCompleted) {
    if (!state.activeRun) startRun(state, run);
    executeIntent(state);
  }
}

function mergeOnce(state) {
  if (state.merged) return;
  event(state, "merge-api-success");
  state.mergeCallCount += 1;
  state.merged = true;
}

function completeOutcome(state) {
  if (state.outcomeCount > 0) return;
  assert.ok(state.repairCompleted || state.merged, "outcome requires resumed terminal work");
  event(state, "outcome-durable");
  state.outcomeCount = 1;
}

function crash(state) {
  event(state, "process-crash");
  state.activeRun = null;
}

function event(state, name) {
  state.eventSequence.push(name);
}
