// @ts-nocheck
/**
 * Standalone Node harness (not part of the app bundle): pure transport layers against fake
 * stores. Run it with esbuild, see docs/kanban-transport.md §6.
 */
import { resolveTransportConfig } from '../../src/integration/transport/config';
import { EventDedupe } from '../../src/integration/transport/EventDedupe';
import { mapKanbanEvent, normalizeKanbanEvent, MapperCoreActions, MapperUiActions } from '../../src/integration/transport/KanbanEventMapper';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${a}${ok ? '' : ` (expected ${e})`}`);
};

// ── config ───────────────────────────────────────────────────────────────
check('config: no env ⇒ local/disabled', (() => {
  const c = resolveTransportConfig({});
  return { mode: c.mode, url: c.url };
})(), { mode: 'local', url: null });

check('config: url ⇒ remote', (() => {
  const c = resolveTransportConfig({ VITE_KANBAN_WS_URL: 'ws://127.0.0.1:8000/ws' });
  return { mode: c.mode, url: c.url };
})(), { mode: 'remote', url: 'ws://127.0.0.1:8000/ws' });

check('config: explicit local wins over url', resolveTransportConfig({
  VITE_KANBAN_WS_URL: 'ws://x/ws', VITE_KANBAN_TRANSPORT_MODE: 'local',
}).mode, 'local');

check('config: bad tuning falls back to defaults', (() => {
  const c = resolveTransportConfig({ VITE_KANBAN_WS_HEARTBEAT_MS: '-3', VITE_KANBAN_WS_DEDUPE_SIZE: 'abc' });
  return { hb: c.heartbeatIntervalMs, dedupe: c.dedupeCacheSize };
})(), { hb: 15000, dedupe: 500 });

check('normalize: unknown/absent fields tolerated', normalizeKanbanEvent({ type: 'task.created', payload: null })?.payload, {});
check('normalize: missing type rejected', normalizeKanbanEvent({ id: 'x' }), null);

// ── dedupe ───────────────────────────────────────────────────────────────
const dedupe = new EventDedupe(2);
check('dedupe: first', dedupe.check({ id: 'a', seq: 1 }), { duplicate: false, gap: false, outOfOrder: false });
check('dedupe: seq gap flagged', dedupe.check({ id: 'b', seq: 4 }), { duplicate: false, gap: true, outOfOrder: false });
check('dedupe: duplicate id flagged', dedupe.check({ id: 'a', seq: 5 }), { duplicate: true, gap: false, outOfOrder: false });
check('dedupe: older seq ⇒ out of order', dedupe.check({ id: 'c', seq: 2 }), { duplicate: false, gap: false, outOfOrder: true });
dedupe.reset();
check('dedupe: reset clears seq window', dedupe.check({ id: 'a', seq: 1 }), { duplicate: false, gap: false, outOfOrder: false });

check('dedupe: adoptBaseline makes a jumped snapshot seq contiguous (no false gap)', (() => {
  const d = new EventDedupe(10);
  d.check({ id: 'e5', seq: 5 });
  d.adoptBaseline(9);   // a board.snapshot / bridge `snapshot` reply at seq 9
  return { snapshot: d.check({ id: 'e9', seq: 9 }), live: d.check({ id: 'e10', seq: 10 }) };
})(), {
  snapshot: { duplicate: false, gap: false, outOfOrder: false },
  live: { duplicate: false, gap: false, outOfOrder: false },
});

check('dedupe: adoptBaseline only raises the baseline', (() => {
  const d = new EventDedupe(10);
  d.check({ id: 'e9', seq: 9 });
  d.adoptBaseline(3);
  return d.lastSequence;
})(), 9);

check('config: VITE_KANBAN_BACKLOG_MODE is retired', Object.prototype.hasOwnProperty.call(
  resolveTransportConfig({ VITE_KANBAN_BACKLOG_MODE: 'snapshot' }), 'backlogMode',
), false);

// ── mapper against fake stores ───────────────────────────────────────────
const makeDeps = () => {
  const calls: string[] = [];
  const core: MapperCoreActions = {
    tasks: [{ id: 'board-1', status: 'done', assignedAgentId: 2 }],
    phase: 'working',
    userBrief: '',
    startProject: (brief) => calls.push(`startProject:${brief}`),
    setPhase: (phase) => calls.push(`setPhase:${phase}`),
    setUserBrief: (brief) => calls.push(`setUserBrief:${brief}`),
    addTask: (task) => { calls.push(`addTask:${task.id}:${task.status}:${task.assignedAgentId}`); return { id: task.id ?? 'gen' }; },
    applySnapshot: (snap) => calls.push(`applySnapshot:${snap.tasks.map(t => `${t.id}/${t.status}`).join(',')}:${snap.phase}:${JSON.stringify(snap.agentStatuses ?? {})}`),
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
  return { deps: { core, ui, validAgentIndices: [1, 2, 3] }, calls };
};

const run = (event: any) => {
  const { deps, calls } = makeDeps();
  const result = mapKanbanEvent(event, deps);
  return { result, calls };
};

check('task.created adopts external id', (() => {
  const { result, calls } = run({ type: 'task.created', payload: { task: { id: 'board-7', title: 'Deploy', description: 'd', assignedAgentId: 2, status: 'scheduled' } } });
  return { result, calls };
})(), { result: { status: 'applied' }, calls: ['addTask:board-7:scheduled:2'] });

check('task.created with existing id is ignored', run({ type: 'task.created', payload: { task: { id: 'board-1', title: 'x', assignedAgentId: 2 } } }).calls, []);

check('task.created for unknown agent rejected', (() => {
  const { result, calls } = run({ type: 'task.created', payload: { task: { id: 'b', title: 'x', assignedAgentId: 9 } } });
  return { result, calls };
})(), { result: { status: 'rejected', reason: 'invalid_task' }, calls: [] });

check('task.status_changed done→in_progress uses reopenTask', run({ type: 'task.status_changed', payload: { taskId: 'board-1', status: 'in_progress' } }).calls, ['reopenTask:board-1:in_progress']);

check('task.status_changed scheduled→done uses force update', run({ type: 'task.status_changed', payload: { taskId: 'other', status: 'done' } }).calls, []);

check('task.review_requested → submitTaskForReview', run({ type: 'task.review_requested', taskId: 'board-1', payload: { draft: 'draft v1' } }).calls, ['submitTaskForReview:board-1:draft v1']);

check('task.rejected keeps server as history owner', run({ type: 'task.rejected', taskId: 'board-1', payload: { comments: 'too vague' } }).calls, ['rejectTask:board-1:too vague:writeHistory=false']);

check('agent.status_changed valid index', run({ type: 'agent.status_changed', agentIndex: 2, payload: { status: 'working' } }).calls, ['setAgentStatus:2:working']);
check('agent.status_changed unknown agent rejected', run({ type: 'agent.status_changed', agentIndex: 9, payload: { status: 'working' } }).result, { status: 'rejected', reason: 'unknown_agent' });
check('agent.message appends history', run({ type: 'agent.message', agentIndex: 3, payload: { role: 'assistant', content: 'hi' } }).calls, ['appendAgentHistory:3:assistant:hi']);
check('agent.replace_history replaces', run({ type: 'agent.replace_history', agentIndex: 1, payload: { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } }).calls, ['setAgentHistory:1:2']);
check('action_log.appended', run({ type: 'action_log.appended', payload: { agentIndex: 1, action: 'Started task', taskId: 'board-7' } }).calls, ['addLogEntry:1:Started task']);
check('action_log.appended without agentIndex is a System entry', run({ type: 'action_log.appended', payload: { action: 'board poll recovered' } }).calls, ['addLogEntry:-1:board poll recovered']);
check('action_log.appended for an out-of-team agent is rejected', (() => {
  const { result, calls } = run({ type: 'action_log.appended', payload: { agentIndex: 9, action: 'Started task' } });
  return { result, calls };
})(), { result: { status: 'rejected', reason: 'unknown_agent' }, calls: [] });
check('llm.usage accumulates tokens', run({ type: 'llm.usage', agentIndex: 2, payload: { promptTokens: 10, completionTokens: 5 } }).calls, ['addResponseLog:2:15']);

check('board.snapshot replaces the board', run({
  type: 'board.snapshot',
  payload: {
    phase: 'working', brief: 'Build a site',
    tasks: [
      { id: 'b1', title: 't1', assignedAgentId: 1, status: 'in_progress' },
      { id: 'b2', title: 't2', assignedAgentId: 9, status: 'scheduled' },
      { title: 'no id', assignedAgentId: 2, status: 'done' },
    ],
    agentStatuses: { 1: 'working', 9: 'idle' },
  },
}).calls, ['applySnapshot:b1/in_progress:working:{"1":"working"}']);

check('board.snapshot without tasks is rejected (never wipes the board)', (() => {
  const { result, calls } = run({ type: 'board.snapshot', payload: {} });
  return { result, calls };
})(), { result: { status: 'rejected', reason: 'missing_tasks' }, calls: [] });

check('board.snapshot with explicit empty tasks clears the board', run({
  type: 'board.snapshot',
  payload: { tasks: [] },
}).calls, ['applySnapshot::undefined:{}']);

check('project.brief_received → startProject', run({ type: 'project.brief_received', payload: { brief: 'Landing page' } }).calls, ['startProject:Landing page']);
check('project.asset_ready maps music→audio', run({ type: 'project.asset_ready', payload: { type: 'music', content: 'data:audio' } }).calls, ['setFinalAsset:audio:data:audio', 'setPhase:done']);
check('project.final_output closes the project', run({ type: 'project.final_output', payload: { output: 'done!' } }).calls, ['setFinalOutput:done!', 'setPhase:done']);
check('unknown type ignored (not fatal)', run({ type: 'board.does_not_exist', payload: {} }).result, { status: 'ignored', reason: 'unknown_type' });

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
