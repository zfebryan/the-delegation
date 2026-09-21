// @ts-nocheck
/**
 * Standalone Node harness (not part of the app bundle): `kanban-ws-bridge` frame → §6.2 envelope
 * → mapper, with fake stores. Run it with esbuild, see docs/kanban-transport.md §6.
 */
import { resolveTransportConfig } from '../../src/integration/transport/config';
import {
  adaptBridgeFrame,
  bridgeToTaskStatus,
  isBridgeFrame,
  parseAgentMap,
  taskStatusToBridge,
  DEFAULT_AGENT_MAP,
} from '../../src/integration/transport/BridgeAdapter';
import { EventDedupe } from '../../src/integration/transport/EventDedupe';
import { mapKanbanEvent, MapperCoreActions, MapperUiActions } from '../../src/integration/transport/KanbanEventMapper';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${a}${ok ? '' : ` (expected ${e})`}`);
};

const OPTIONS = { agentMap: DEFAULT_AGENT_MAP, validAgentIndices: [1, 2, 3, 4] };

/** Real bridge frames captured from a running `kanban-ws-bridge` (GET /events on :8000). */
const bridgeTask = (over: Record<string, any> = {}) => ({
  id: 't_29bcaba1',
  title: 'Bridge WebSocket untuk event kanban',
  assignee: 'dev',
  status: 'running',
  priority: 0,
  created_at: 1789965828.5,
  started_at: 1789965855,
  completed_at: null,
  branch_name: null,
  ...over,
});
const taskAdded = (over: Record<string, any> = {}) => ({
  type: 'task_added',
  task_id: 't_29bcaba1',
  title: 'Bridge WebSocket untuk event kanban',
  from_status: null,
  to_status: 'running',
  changes: {},
  task: bridgeTask(),
  seq: 7,
  ts: 1789966568.60717,
  ...over,
});
const statusChanged = (over: Record<string, any> = {}) => ({
  type: 'status_changed',
  task_id: 't_29bcaba1',
  title: 'Bridge WebSocket untuk event kanban',
  from_status: 'running',
  to_status: 'done',
  changes: { status: { from: 'running', to: 'done' } },
  task: bridgeTask({ status: 'done', completed_at: 1789966631 }),
  seq: 9,
  ts: 1789966633.9192042,
  ...over,
});

// ── config: the mapping table is a decision, not a guess ────────────────
check('config: default agent map', resolveTransportConfig({}).agentMap, { dev: 2, qa: 3 });
check('config: env override extends/replaces the default', resolveTransportConfig({
  VITE_KANBAN_AGENT_MAP: 'dev:1,qa:2,lead:1',
}).agentMap, { dev: 1, qa: 2, lead: 1 });
check('config: adapter + snapshot-resync defaults', (() => {
  const c = resolveTransportConfig({});
  return { adapter: c.bridgeAdapter, timeout: c.snapshotReplyTimeoutMs, attempts: c.snapshotMaxAttempts };
})(), { adapter: 'auto', timeout: 5000, attempts: 3 });
check('config: adapter off + snapshot tuning override', (() => {
  const c = resolveTransportConfig({
    VITE_KANBAN_BRIDGE_ADAPTER: 'OFF',
    VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS: '1500',
    VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS: '5',
  });
  return { adapter: c.bridgeAdapter, timeout: c.snapshotReplyTimeoutMs, attempts: c.snapshotMaxAttempts };
})(), { adapter: 'off', timeout: 1500, attempts: 5 });
check('config: bad snapshot tuning falls back to defaults', (() => {
  const c = resolveTransportConfig({ VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS: '0', VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS: '2.5' });
  return { timeout: c.snapshotReplyTimeoutMs, attempts: c.snapshotMaxAttempts };
})(), { timeout: 5000, attempts: 3 });
check('config: retired VITE_KANBAN_BACKLOG_MODE is no longer part of the config', (() => {
  const c = resolveTransportConfig({ VITE_KANBAN_BACKLOG_MODE: 'snapshot' });
  return Object.prototype.hasOwnProperty.call(c, 'backlogMode');
})(), false);

check('parseAgentMap: junk entries skipped', parseAgentMap(' dev:2 , qa:3 ,broken, x:notanumber, y:-1,'), { dev: 2, qa: 3 });
check('parseAgentMap: empty input', parseAgentMap(''), {});

// ── status translation (both directions) ────────────────────────────────
check('status: bridge → remote (table)', [
  'todo', 'ready', 'triage', 'running', 'blocked', 'review', 'done', 'DONE', 'weird',
].map(bridgeToTaskStatus), ['scheduled', 'scheduled', 'scheduled', 'in_progress', 'on_hold', 'on_hold', 'done', 'done', null]);
check('status: remote → bridge (lossy, documented)', [
  'scheduled', 'in_progress', 'on_hold', 'done',
].map(taskStatusToBridge), ['ready', 'running', 'review', 'done']);

// ── frame classification ────────────────────────────────────────────────
check('isBridgeFrame: bridge frame', isBridgeFrame(taskAdded()), true);
check('isBridgeFrame: §6.2 envelope is not a bridge frame', isBridgeFrame({ type: 'task.created', payload: {} }), false);
check('isBridgeFrame: junk', isBridgeFrame('nope'), false);
check('adapt: §6.2 envelope passes through untouched', (() => {
  const f = adaptBridgeFrame({ type: 'task.created', payload: { task: { id: 'x' } } }, OPTIONS);
  return { kind: f.kind, envelopes: f.envelopes.length };
})(), { kind: 'passthrough', envelopes: 0 });

// ── task_added → task.created ───────────────────────────────────────────
check('task_added → task.created envelope', (() => {
  const f = adaptBridgeFrame(taskAdded(), OPTIONS);
  const e = f.envelopes[0];
  return {
    kind: f.kind, nacks: f.nacks, type: e.type, id: e.id, seq: e.seq, ts: e.ts, agentIndex: e.agentIndex,
    taskId: e.taskId, task: e.payload.task,
  };
})(), {
  kind: 'envelopes', nacks: [], type: 'task.created', id: 'bridge:7', seq: 7, ts: 1789966568607, agentIndex: 2,
  taskId: 't_29bcaba1',
  task: {
    id: 't_29bcaba1', title: 'Bridge WebSocket untuk event kanban', description: '', assignedAgentId: 2,
    status: 'in_progress', requiresUserApproval: false, createdAt: 1789965828500,
  },
});

check('task_added: unknown assignee dropped + NACK', (() => {
  const f = adaptBridgeFrame(taskAdded({ task: bridgeTask({ assignee: 'intern' }) }), OPTIONS);
  return { kind: f.kind, reason: f.reason, nacks: f.nacks.map((n) => n.reason), envelopes: f.envelopes.length };
})(), { kind: 'ignored', reason: 'unknown_assignee', nacks: ['unknown_assignee'], envelopes: 0 });

check('task_added: mapped index outside the active team dropped + NACK', (() => {
  const f = adaptBridgeFrame(taskAdded({ task: bridgeTask({ assignee: 'qa' }) }), { agentMap: DEFAULT_AGENT_MAP, validAgentIndices: [1, 2] });
  return { reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { reason: 'agent_not_in_team', nacks: ['agent_not_in_team'] });

check('task_added: unknown status dropped + NACK (never guessed)', (() => {
  const f = adaptBridgeFrame(taskAdded({ task: bridgeTask({ status: 'archived' }) }), OPTIONS);
  return { reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { reason: 'unknown_status', nacks: ['unknown_status'] });

check('task_added: missing id → malformed_task NACK', (() => {
  const f = adaptBridgeFrame({ type: 'task_added', task: { assignee: 'dev', status: 'ready' }, seq: 3, ts: 1789966568 }, OPTIONS);
  return { reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { reason: 'malformed_task', nacks: ['malformed_task'] });

// ── status_changed → task.status_changed ────────────────────────────────
check('status_changed → task.status_changed envelope', (() => {
  const f = adaptBridgeFrame(statusChanged(), OPTIONS);
  const e = f.envelopes[0];
  return { kind: f.kind, type: e.type, id: e.id, taskId: e.taskId, agentIndex: e.agentIndex, payload: e.payload, nacks: f.nacks };
})(), {
  kind: 'envelopes', type: 'task.status_changed', id: 'bridge:9', taskId: 't_29bcaba1', agentIndex: 2,
  payload: { taskId: 't_29bcaba1', status: 'done' }, nacks: [],
});

check('status_changed: blocked → on_hold (boardroom / human review)', (() => {
  const f = adaptBridgeFrame(statusChanged({ to_status: 'blocked', task: bridgeTask({ status: 'blocked' }) }), OPTIONS);
  return f.envelopes[0].payload;
})(), { taskId: 't_29bcaba1', status: 'on_hold' });

check('status_changed: unknown status dropped + NACK', (() => {
  const f = adaptBridgeFrame(statusChanged({ to_status: 'weird' }), OPTIONS);
  return { kind: f.kind, reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { kind: 'ignored', reason: 'unknown_status', nacks: ['unknown_status'] });

check('status_changed: unmapped owner dropped + NACK', (() => {
  const f = adaptBridgeFrame(statusChanged({ task: bridgeTask({ assignee: 'intern', status: 'done' }) }), OPTIONS);
  return { reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { reason: 'unknown_assignee', nacks: ['unknown_assignee'] });

// ── deliberately unmapped bridge types ──────────────────────────────────
check('task_updated → NACK non_status_change_not_supported', (() => {
  const f = adaptBridgeFrame({ type: 'task_updated', task_id: 't_29bcaba1', changes: { title: { from: 'a', to: 'b' } }, task: bridgeTask(), seq: 8, ts: 1789966568 }, OPTIONS);
  return { kind: f.kind, reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { kind: 'ignored', reason: 'non_status_change_not_supported', nacks: ['non_status_change_not_supported'] });

check('task_removed → NACK removal_not_supported', (() => {
  const f = adaptBridgeFrame({ type: 'task_removed', task_id: 't_29bcaba1', task: bridgeTask(), seq: 10, ts: 1789966568 }, OPTIONS);
  return { kind: f.kind, reason: f.reason, nacks: f.nacks.map((n) => n.reason) };
})(), { kind: 'ignored', reason: 'removal_not_supported', nacks: ['removal_not_supported'] });

check('poll_error recorded as ignored, not fatal', (() => {
  const f = adaptBridgeFrame({ type: 'poll_error', error: 'exit 1', seq: 11, ts: 1789966568 }, OPTIONS);
  return { kind: f.kind, reason: f.reason, nacks: f.nacks };
})(), { kind: 'ignored', reason: 'bridge_poll_error', nacks: [] });

check('poll_recovered recorded as ignored', adaptBridgeFrame({ type: 'poll_recovered', seq: 12, ts: 1789966568 }, OPTIONS).reason, 'bridge_poll_recovered');
check('keepalive is liveness only', adaptBridgeFrame({ type: 'keepalive' }, OPTIONS).kind, 'liveness');

// ── snapshot (bridge's answer to board.snapshot.request) → board.snapshot ──
const snapshotFrame = {
  type: 'snapshot',
  count: 4,
  seq: 12,
  ts: 1789966700.25,
  initialized: true,
  poll_interval_s: 3.0,
  tasks: [
    bridgeTask({ id: 't_29bcaba1', status: 'running', assignee: 'dev' }),
    bridgeTask({ id: 't_done', status: 'done', assignee: 'qa', title: 'Sudah selesai' }),
    bridgeTask({ id: 't_intern', status: 'ready', assignee: 'intern' }),
    bridgeTask({ id: 't_weird', status: 'archived', assignee: 'dev' }),
  ],
};

check('isBridgeFrame: snapshot frame is a bridge frame', isBridgeFrame(snapshotFrame), true);

check('snapshot → one board.snapshot from the poller state (unmapped/unknown dropped + NACK)', (() => {
  const f = adaptBridgeFrame(snapshotFrame, OPTIONS);
  const e = f.envelopes[0];
  return {
    kind: f.kind, envelopes: f.envelopes.length, type: e.type, seq: e.seq, id: e.id, ts: e.ts,
    baselineSeq: f.baselineSeq, payload: e.payload,
    nacks: f.nacks.map((n) => `${n.reason}:${n.taskId}`),
  };
})(), {
  kind: 'envelopes', envelopes: 1, type: 'board.snapshot', seq: 12, id: 'bridge:snapshot:12:1789966700250',
  ts: 1789966700250, baselineSeq: 12,
  payload: {
    tasks: [
      {
        id: 't_29bcaba1', title: 'Bridge WebSocket untuk event kanban', description: '',
        assignedAgentId: 2, status: 'in_progress', requiresUserApproval: false, createdAt: 1789965828500,
      },
      {
        id: 't_done', title: 'Sudah selesai', description: '', assignedAgentId: 3, status: 'done',
        requiresUserApproval: false, createdAt: 1789965828500,
      },
    ],
    phase: 'working',
  },
  nacks: ['unknown_assignee:t_intern', 'unknown_status:t_weird'],
});

check('snapshot: initialized=false is NOT applied (no baseline ≠ empty board)', (() => {
  const f = adaptBridgeFrame({ type: 'snapshot', count: 0, seq: 4, ts: 1789966500, initialized: false, tasks: [] }, OPTIONS);
  return { kind: f.kind, reason: f.reason, envelopes: f.envelopes.length, nacks: f.nacks, baselineSeq: f.baselineSeq };
})(), { kind: 'ignored', reason: 'snapshot_not_initialized', envelopes: 0, nacks: [], baselineSeq: 4 });

check('snapshot: initialized=true with tasks: [] is a legitimately empty board', (() => {
  const f = adaptBridgeFrame({ type: 'snapshot', count: 0, seq: 5, ts: 1789966500, initialized: true, tasks: [] }, OPTIONS);
  return { kind: f.kind, payload: f.envelopes[0].payload, id: f.envelopes[0].id };
})(), { kind: 'envelopes', payload: { tasks: [], phase: 'idle' }, id: 'bridge:snapshot:5:1789966500000' });

check('snapshot: missing tasks is not applied (partial snapshot never wipes the board)', (() => {
  const f = adaptBridgeFrame({ type: 'snapshot', count: 2, seq: 6, ts: 1789966500, initialized: true }, OPTIONS);
  return { kind: f.kind, reason: f.reason, envelopes: f.envelopes.length };
})(), { kind: 'ignored', reason: 'snapshot_missing_tasks', envelopes: 0 });

check('snapshot: all-done board reports phase done', (() => {
  const f = adaptBridgeFrame({
    type: 'snapshot', seq: 7, ts: 1789966500, initialized: true,
    tasks: [bridgeTask({ id: 't_done', status: 'done', assignee: 'dev' })],
  }, OPTIONS);
  return f.envelopes[0].payload.phase;
})(), 'done');

check('snapshot: id is stable, so a replayed frame is a duplicate', (() => {
  const dedupe = new EventDedupe(10);
  const first = adaptBridgeFrame(snapshotFrame, OPTIONS).envelopes[0];
  const second = adaptBridgeFrame(snapshotFrame, OPTIONS).envelopes[0];
  return [dedupe.check(first), dedupe.check(second)];
})(), [
  { duplicate: false, gap: false, outOfOrder: false },
  { duplicate: true, gap: false, outOfOrder: false },
]);

check('snapshot: two replies with the same seq but different ts are both applied', (() => {
  // The bridge does not consume a seq for its own snapshot, so a request and its retry can answer
  // with the same seq; the retry must not be dropped as a duplicate of the first.
  const dedupe = new EventDedupe(10);
  const first = adaptBridgeFrame(snapshotFrame, OPTIONS).envelopes[0];
  const retried = adaptBridgeFrame({ ...snapshotFrame, ts: 1789966799.75 }, OPTIONS).envelopes[0];
  return { ids: [first.id, retried.id], verdicts: [dedupe.check(first), dedupe.check(retried)] };
})(), {
  ids: ['bridge:snapshot:12:1789966700250', 'bridge:snapshot:12:1789966799750'],
  verdicts: [
    { duplicate: false, gap: false, outOfOrder: false },
    { duplicate: false, gap: false, outOfOrder: false },
  ],
});

// ── backlog is retired as a board source ────────────────────────────────
const backlogFrame = {
  type: 'backlog',
  count: 2,
  poll_interval_s: 3.0,
  events: [
    taskAdded({ task: bridgeTask({ status: 'todo' }), to_status: 'todo', seq: 5, ts: 1789966500 }),
    statusChanged({ task: bridgeTask({ status: 'running' }), to_status: 'running', seq: 6, ts: 1789966510 }),
  ],
};

check('backlog is retired: known frame, no envelope, no NACK', (() => {
  const f = adaptBridgeFrame(backlogFrame, OPTIONS);
  return { kind: f.kind, reason: f.reason, envelopes: f.envelopes.length, nacks: f.nacks, baselineSeq: f.baselineSeq };
})(), { kind: 'ignored', reason: 'backlog_superseded', envelopes: 0, nacks: [], baselineSeq: undefined });

// ── dedupe/id synthesis and the snapshot seq baseline ───────────────────
check('dedupe: a skipped seq is flagged as a gap', (() => {
  const dedupe = new EventDedupe(10);
  dedupe.check({ id: 'bridge:5', seq: 5 });
  return dedupe.check(adaptBridgeFrame(statusChanged({ seq: 11 }), OPTIONS).envelopes[0]);
})(), { duplicate: false, gap: true, outOfOrder: false });

check('dedupe: adoptBaseline makes the snapshot seq itself contiguous (no false gap)', (() => {
  const dedupe = new EventDedupe(10);
  dedupe.check({ id: 'bridge:5', seq: 5 });
  dedupe.adoptBaseline(12);   // snapshot answered our request
  const snapshot = adaptBridgeFrame(snapshotFrame, OPTIONS).envelopes[0];
  return { snapshot: dedupe.check(snapshot), live: dedupe.check({ id: 'bridge:13', seq: 13 }) };
})(), {
  snapshot: { duplicate: false, gap: false, outOfOrder: false },
  live: { duplicate: false, gap: false, outOfOrder: false },
});

check('dedupe: adoptBaseline never rewinds (stale snapshot stays out of order)', (() => {
  const dedupe = new EventDedupe(10);
  dedupe.check({ id: 'bridge:9', seq: 9 });
  dedupe.adoptBaseline(4);
  const verdict = dedupe.check({ id: 'bridge:10', seq: 10 });
  return { lastSequence: dedupe.lastSequence, verdict };
})(), { lastSequence: 10, verdict: { duplicate: false, gap: false, outOfOrder: false } });

// ── end to end: real bridge frame → mapper → store actions ──────────────
const makeDeps = (initialTasks: { id: string; status: string; assignedAgentId: number }[] = [{ id: 't_other', status: 'scheduled', assignedAgentId: 2 }]) => {
  const calls: string[] = [];
  const core: MapperCoreActions = {
    tasks: initialTasks,
    phase: 'idle',
    userBrief: '',
    startProject: (brief) => calls.push(`startProject:${brief}`),
    setPhase: (phase) => calls.push(`setPhase:${phase}`),
    setUserBrief: (brief) => calls.push(`setUserBrief:${brief}`),
    addTask: (task) => { calls.push(`addTask:${task.id}:${task.status}:${task.assignedAgentId}`); return { id: task.id ?? 'gen' }; },
    applySnapshot: (snap) => calls.push(`applySnapshot:${snap.tasks.map((t) => `${t.id}/${t.status}/${t.assignedAgentId}`).join(',')}:${snap.phase}`),
    updateTaskStatus: (id, status, opts) => calls.push(`updateTaskStatus:${id}:${status}:${opts?.force === true}`),
    reopenTask: (id, status) => calls.push(`reopenTask:${id}:${status}`),
    submitTaskForReview: (id, draft) => calls.push(`submitTaskForReview:${id}:${draft ?? ''}`),
    setTaskOutput: (id, output) => calls.push(`setTaskOutput:${id}:${output}`),
    approveTask: (id) => calls.push(`approveTask:${id}`),
    rejectTask: (id, comments, opts) => calls.push(`rejectTask:${id}:${comments}:writeHistory=${opts?.writeHistory !== false}`),
    setFinalOutput: (o) => calls.push(`setFinalOutput:${o}`),
    setFinalAsset: (t, c) => calls.push(`setFinalAsset:${t}:${c}`),
    addLogEntry: (e) => calls.push(`addLogEntry:${e.agentIndex}:${e.action}`),
    appendAgentHistory: (i, role, parts) => calls.push(`appendAgentHistory:${i}:${role}:${parts.join('|')}`),
    setAgentHistory: (i, h) => calls.push(`setAgentHistory:${i}:${h.length}`),
    addResponseLog: (e) => calls.push(`addResponseLog:${e.agentIndex}:${e.usage.totalTokens}`),
  };
  const ui: MapperUiActions = {
    agentStatuses: {},
    setAgentStatus: (index, status) => calls.push(`setAgentStatus:${index}:${status}`),
  };
  return { deps: { core, ui, validAgentIndices: [1, 2, 3, 4] }, calls };
};

const runFrame = (raw: unknown, initialTasks?: { id: string; status: string; assignedAgentId: number }[]) => {
  const frame = adaptBridgeFrame(raw, OPTIONS);
  const { deps, calls } = makeDeps(initialTasks);
  const results = frame.envelopes.map((event) => mapKanbanEvent(event, deps));
  return { frame, results, calls };
};

check('E2E task_added → applied + addTask with the external id', (() => {
  const { results, calls, frame } = runFrame(taskAdded({ task: bridgeTask({ status: 'ready' }) }));
  return { results, nacks: frame.nacks, calls };
})(), {
  results: [{ status: 'applied' }], nacks: [],
  calls: ['addTask:t_29bcaba1:scheduled:2'],
});

check('E2E status_changed → applied + forced status update', (() => {
  const { results, calls } = runFrame(statusChanged(), [{ id: 't_29bcaba1', status: 'in_progress', assignedAgentId: 2 }]);
  return { results, calls };
})(), { results: [{ status: 'applied' }], calls: ['updateTaskStatus:t_29bcaba1:done:true'] });

check('E2E status_changed reopening a finished task uses reopenTask', (() => {
  const { results, calls } = runFrame(
    statusChanged({ to_status: 'running', task: bridgeTask({ status: 'running' }) }),
    [{ id: 't_29bcaba1', status: 'done', assignedAgentId: 2 }],
  );
  return { results, calls };
})(), { results: [{ status: 'applied' }], calls: ['reopenTask:t_29bcaba1:in_progress'] });

check('E2E snapshot → applied board.snapshot (from poller state)', (() => {
  const { frame, results, calls } = runFrame(snapshotFrame);
  return { results, calls, nacks: frame.nacks.map((n) => n.reason) };
})(), {
  results: [{ status: 'applied' }],
  calls: ['applySnapshot:t_29bcaba1/in_progress/2,t_done/done/3:working'],
  nacks: ['unknown_assignee', 'unknown_status'],
});

check('E2E snapshot with initialized=false never reaches the mapper', (() => {
  const { frame, results, calls } = runFrame({ type: 'snapshot', seq: 4, initialized: false, tasks: [] });
  return { kind: frame.kind, reason: frame.reason, results, calls };
})(), { kind: 'ignored', reason: 'snapshot_not_initialized', results: [], calls: [] });

check('E2E retired backlog never reaches the mapper', (() => {
  const { frame, results, calls } = runFrame(backlogFrame);
  return { kind: frame.kind, reason: frame.reason, results, calls };
})(), { kind: 'ignored', reason: 'backlog_superseded', results: [], calls: [] });

check('E2E unmapped assignee never reaches the mapper', (() => {
  const { frame, results, calls } = runFrame(taskAdded({ task: bridgeTask({ assignee: 'intern' }) }));
  return { kind: frame.kind, results, calls, nacks: frame.nacks.map((n) => n.reason) };
})(), { kind: 'ignored', results: [], calls: [], nacks: ['unknown_assignee'] });

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;