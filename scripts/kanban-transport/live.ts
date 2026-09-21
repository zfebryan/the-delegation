// @ts-nocheck
// Standalone Node harness: real KanbanWsClient against a running kanban-ws-bridge, with every
// frame routed through the BridgeAdapter (flat bridge frame → §6.2 envelope) → dedupe → mapper
// → an in-memory fake store (no browser, no 3D layer).
// Usage: node <bundle> [ws://127.0.0.1:8000/ws]
import { KanbanWsClient } from '../../src/integration/transport/wsClient';
import { adaptBridgeFrame } from '../../src/integration/transport/BridgeAdapter';
import { resolveTransportConfig } from '../../src/integration/transport/config';
import { EventDedupe } from '../../src/integration/transport/EventDedupe';
import { mapKanbanEvent, MapperCoreActions, MapperUiActions } from '../../src/integration/transport/KanbanEventMapper';

const config = resolveTransportConfig({});
const OPTIONS = {
  agentMap: config.agentMap,
  validAgentIndices: [1, 2, 3, 4],
  backlogMode: config.backlogMode,
};

// ── fake store: real task list so status changes are not all "unknown_task" ──
interface FakeTask { id: string; status: string; assignedAgentId: number }
const tasks: FakeTask[] = [];
let generated = 0;
const calls: string[] = [];

const core: MapperCoreActions = {
  get tasks() { return tasks; },
  phase: 'idle',
  userBrief: '',
  startProject: (brief) => calls.push(`startProject:${brief}`),
  setPhase: (phase) => calls.push(`setPhase:${phase}`),
  setUserBrief: (brief) => calls.push(`setUserBrief:${brief}`),
  addTask: (task) => {
    const id = task.id ?? `generated_${++generated}`;
    tasks.push({ id, status: task.status, assignedAgentId: task.assignedAgentId });
    calls.push(`addTask:${id}:${task.status}:${task.assignedAgentId}`);
    return { id };
  },
  applySnapshot: (snapshot) => {
    tasks.length = 0;
    snapshot.tasks.forEach((t) => tasks.push({ id: t.id, status: t.status, assignedAgentId: t.assignedAgentId }));
    calls.push(`applySnapshot:${tasks.length} tasks:${snapshot.phase}`);
  },
  updateTaskStatus: (taskId, status, opts) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task) task.status = status;
    calls.push(`updateTaskStatus:${taskId}:${status}:force=${opts?.force === true}`);
  },
  reopenTask: (taskId, status) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task) task.status = status;
    calls.push(`reopenTask:${taskId}:${status}`);
  },
  submitTaskForReview: (id, draft) => calls.push(`submitTaskForReview:${id}:${draft ?? ''}`),
  setTaskOutput: (id, output) => calls.push(`setTaskOutput:${id}:${output.length} chars`),
  approveTask: (id) => calls.push(`approveTask:${id}`),
  rejectTask: (id, comments) => calls.push(`rejectTask:${id}:${comments}`),
  setFinalOutput: (o) => calls.push(`setFinalOutput:${o}`),
  setFinalAsset: (t, c) => calls.push(`setFinalAsset:${t}:${c.length} chars`),
  addLogEntry: (e) => calls.push(`addLogEntry:${e.agentIndex}:${e.action}`),
  appendAgentHistory: (i, role, parts) => calls.push(`appendAgentHistory:${i}:${role}`),
  setAgentHistory: (i, h) => calls.push(`setAgentHistory:${i}:${h.length}`),
  addResponseLog: (e) => calls.push(`addResponseLog:${e.agentIndex}`),
};
const ui: MapperUiActions = {
  agentStatuses: {},
  setAgentStatus: (index, status) => calls.push(`setAgentStatus:${index}:${status}`),
};
const deps = { core, ui, validAgentIndices: OPTIONS.validAgentIndices };

const states: string[] = [];
let reconnects = 0;
const framesByType: Record<string, number> = {};
const liveResults: Record<string, number> = {};
const replayResults: Record<string, number> = {};
const liveApplied: string[] = [];
const replayApplied: string[] = [];
const nacks: string[] = [];

const dedupe = new EventDedupe(500);
/** Separate dedupe for the backlog replay so it cannot disturb the live seq baseline. */
const replayDedupe = new EventDedupe(500);

const record = (bucket: Record<string, number>, result: any, type: string) => {
  const key = `${result.status}:${type}${result.reason ? `:${result.reason}` : ''}`;
  bucket[key] = (bucket[key] ?? 0) + 1;
};

const runEnvelope = (event: any, dedupeIssuer: EventDedupe, bucket: Record<string, number>, applied: string[]) => {
  const verdict = dedupeIssuer.check(event);
  if (verdict.duplicate) {
    bucket[`duplicate:${event.type}`] = (bucket[`duplicate:${event.type}`] ?? 0) + 1;
    return;
  }
  if (verdict.gap) bucket[`gap:${event.type}`] = (bucket[`gap:${event.type}`] ?? 0) + 1;
  const result = mapKanbanEvent(event, deps);
  record(bucket, result, event.type);
  if (result.status === 'applied') applied.push(event.type);
};

const client = new KanbanWsClient({
  url: process.argv[2] ?? 'ws://127.0.0.1:8000/ws',
  reconnectMinDelayMs: 300,
  reconnectMaxDelayMs: 1000,
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 800,
  onEvent: (raw) => {
    const frame = adaptBridgeFrame(raw, OPTIONS);
    framesByType[`${frame.bridgeType}/${frame.kind}`] = (framesByType[`${frame.bridgeType}/${frame.kind}`] ?? 0) + 1;

    // The backlog is a replay of real buffered events: run each one through the adapter as if it
    // had arrived live, so the report shows per-event types (`task.created`, `task.status_changed`)
    // for real bridge payloads and not only the summarized snapshot.
    if (frame.bridgeType === 'backlog' && Array.isArray((raw as any).events)) {
      (raw as any).events.forEach((inner: unknown) => {
        adaptBridgeFrame(inner, OPTIONS).envelopes.forEach((event) => runEnvelope(event, replayDedupe, replayResults, replayApplied));
      });
    }

    frame.nacks.forEach((nack) => nacks.push(`${nack.reason}:${nack.bridgeType}:${nack.taskId ?? '-'}:${nack.assignee ?? '-'}`));

    if (frame.kind === 'envelopes') {
      frame.envelopes.forEach((event) => runEnvelope(event, dedupe, liveResults, liveApplied));
    } else if (frame.kind === 'ignored') {
      record(liveResults, { status: 'ignored', reason: frame.reason }, frame.bridgeType);
    }
  },
  onStateChange: (s) => { states.push(s); },
  onReconnected: () => { reconnects += 1; },
  onError: (m) => { states.push(`err:${m}`); },
});

client.connect();

setTimeout(() => {
  client.dispose();
  console.log('agent map     :', JSON.stringify(OPTIONS.agentMap));
  console.log('states        :', JSON.stringify(states));
  console.log('reconnects    :', reconnects);
  console.log('frames        :', JSON.stringify(framesByType));
  console.log('live results  :', JSON.stringify(liveResults));
  console.log('live applied  :', JSON.stringify(liveApplied));
  console.log('replay results:', JSON.stringify(replayResults));
  console.log('replay applied:', JSON.stringify(replayApplied));
  console.log('nacks         :', JSON.stringify(nacks));
  console.log('board now     :', JSON.stringify(tasks), JSON.stringify(calls.slice(-2)));
  process.exit(0);
}, Number(process.env.SECONDS ?? 10) * 1000);