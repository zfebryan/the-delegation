// @ts-nocheck
/**
 * Probe: how many `board.snapshot.request` frames does one connect / one reconnect produce, and
 * what does the client do with the `snapshot` answer?
 *
 * `smoke.ts` only covers the pure mapper, so this drives the real `KanbanTransport` against a
 * fake WebSocket (same trick as `heartbeat.ts`) and reads `transportStore`.
 *
 * It pins down three things:
 * 1. the reconnect double-request (`onStateChange('online')` + `onReconnected`),
 * 2. the snapshot that answered a resync is applied as the board — and its poller `seq`, which is
 *    not contiguous with the event stream, no longer counts as a `seq` gap (that used to send a
 *    second `board.snapshot.request` per connect: card t_32e1770f),
 * 3. a resync that is never usefully answered (`snapshot` with `initialized: false`) is retried a
 *    bounded number of times and then reported as unanswered, instead of being believed because
 *    the socket was open.
 *
 * `config.ts` reads `import.meta.env` (Vite), which Node does not provide, so run it with the
 * env inlined by esbuild:
 *
 * ```bash
 * ./node_modules/.bin/esbuild scripts/kanban-transport/snapshot-request-probe.ts \
 *   --bundle --platform=node --format=esm \
 *   --define:'import.meta.env={"VITE_KANBAN_WS_URL":"ws://fake/ws","VITE_KANBAN_TRANSPORT_MODE":"remote","VITE_KANBAN_WS_RECONNECT_MIN_MS":"10","VITE_KANBAN_WS_RECONNECT_MAX_MS":"10","VITE_KANBAN_WS_HEARTBEAT_MS":"60000","VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS":"150","VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS":"2"}' \
 *   --outfile=/tmp/kb-snap.mjs && node /tmp/kb-snap.mjs
 * ```
 */

type Fake = {
  readyState: number;
  sent: any[];
  open(): void;
  push(payload: any): void;
  close(): void;
};

let sockets: Fake[] = [];

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    sockets.push(this as unknown as Fake);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  push(payload: any) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

(globalThis as any).WebSocket = FakeWebSocket;

// The real stores persist to `localStorage` (zustand persist); Node has none.
const memory: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => memory[k] ?? null,
  setItem: (k: string, v: string) => { memory[k] = v; },
  removeItem: (k: string) => { delete memory[k]; },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until `count` sockets exist (the client reconnects on a timer). */
const waitForSockets = async (count: number, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (sockets.length < count && Date.now() < deadline) await sleep(10);
  return sockets.length >= count;
};

const { kanbanTransport } = await import('../../src/integration/transport/KanbanTransport');
const { useTransportStore, transportConfig } = await import('../../src/integration/transport/transportStore');

const requestsOf = (socket: Fake) => socket.sent.filter((f) => f.type === 'board.snapshot.request');

const summary = (label: string, socket: Fake) => {
  const state = useTransportStore.getState();
  console.log(
    `${label}\n  mode           : ${transportConfig.mode} url=${transportConfig.url} ` +
    `snapshotTimeout=${transportConfig.snapshotReplyTimeoutMs}ms attempts=${transportConfig.snapshotMaxAttempts}` +
    `\n  connectionState: ${state.connectionState}` +
    `\n  snapshotReq    : counter=${state.snapshotRequests} replies=${state.snapshotReplies}` +
    ` unanswered=${state.snapshotUnanswered} framesOnThisSocket=${requestsOf(socket).length}` +
    ` (reasons: ${JSON.stringify(requestsOf(socket).map((f) => f.payload.reason))})`,
  );
};

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

expect('probe runs with a short snapshot deadline', [transportConfig.snapshotReplyTimeoutMs, transportConfig.snapshotMaxAttempts], [150, 2]);

kanbanTransport.start();

// 1) first connect — exactly one request, reason `connected`
sockets[0].open();
await sleep(20);
summary('1. first connect', sockets[0]);
expect('first connect sends one request', requestsOf(sockets[0]).length, 1);
expect('first connect counter', useTransportStore.getState().snapshotRequests, 1);
expect('first connect reason', requestsOf(sockets[0])[0]?.payload.reason, 'connected');

// 2) reconnect — exactly one request on the new socket, reason `reconnected`
sockets[0].close();
const reconnected = await waitForSockets(2);
const second = sockets[sockets.length - 1];
second.open();
await sleep(20);
summary('2. reconnect', second);
expect('reconnect opened a new socket', reconnected, true);
expect('reconnect sends one request', requestsOf(second).length, 1);
expect('reconnect increments the counter once', useTransportStore.getState().snapshotRequests, 2);
expect('reconnect reason', requestsOf(second)[0]?.payload.reason, 'reconnected');

// 3) the bridge answers the pending request with `snapshot` → applied, and the request is settled.
const appliedBefore = useTransportStore.getState().appliedEvents;
second.push({
  type: 'snapshot', count: 1, seq: 9, ts: Math.floor(Date.now() / 1000),
  initialized: true, poll_interval_s: 3.0,
  tasks: [{ id: 't_probe', title: 'Probe task', assignee: 'dev', status: 'running', priority: 0, created_at: 1789965000 }],
});
await sleep(20);
summary('3. bridge snapshot answer', second);
expect('snapshot answer applied as the board', useTransportStore.getState().appliedEvents, appliedBefore + 1);
expect('snapshot reply counted', useTransportStore.getState().snapshotReplies, 1);
expect('snapshot seq is not a gap for the next live event', useTransportStore.getState().snapshotRequests, 2);

// 3b) the same round trip that used to cost an extra request: baseline seq 5, snapshot seq 9.
second.push({ type: 'status_changed', task_id: 't_gone', to_status: 'running', seq: 5, ts: Math.floor(Date.now() / 1000), task: { id: 't_gone', assignee: 'dev', status: 'running' } });
await sleep(10);
second.push({
  type: 'snapshot', count: 1, seq: 9, ts: Math.floor(Date.now() / 1000),
  initialized: true, poll_interval_s: 3.0,
  tasks: [{ id: 't_probe', title: 'Probe task', assignee: 'dev', status: 'running', priority: 0, created_at: 1789965000 }],
});
await sleep(40);
expect('a snapshot with a jumped seq does not trigger another request', requestsOf(second).length, 1);
expect('...so the counter stays at one per connect', useTransportStore.getState().snapshotRequests, 2);
const appliedBeforeLive = useTransportStore.getState().appliedEvents;
second.push({
  type: 'status_changed', task_id: 't_probe', to_status: 'done', seq: 10, ts: Math.floor(Date.now() / 1000),
  task: { id: 't_probe', assignee: 'dev', status: 'done' },
});
await sleep(10);
console.log(`  live event: applied ${appliedBeforeLive} -> ${useTransportStore.getState().appliedEvents}` +
  ` ignored=${useTransportStore.getState().ignoredEvents} rejected=${useTransportStore.getState().rejectedEvents}`);
expect('live events still flow after the snapshot', useTransportStore.getState().appliedEvents, appliedBeforeLive + 1);

// 4) `snapshot` with initialized:false is not a board; the resync is retried (bounded) and then
//    reported as unanswered.
const requestsBeforeUninit = useTransportStore.getState().snapshotRequests;
const appliedBeforeUninit = useTransportStore.getState().appliedEvents;
kanbanTransport.requestSnapshot('probe_uninitialized');
await sleep(20);
second.push({ type: 'snapshot', count: 0, seq: 11, ts: Math.floor(Date.now() / 1000), initialized: false, tasks: [] });
await sleep(20);
expect('initialized:false did not touch the board', useTransportStore.getState().appliedEvents, appliedBeforeUninit);
expect('initialized:false is recorded, not silent', useTransportStore.getState().ignoredEvents >= 1, true);
expect('no retry before the deadline', useTransportStore.getState().snapshotRequests, requestsBeforeUninit + 1);
await sleep(200);
summary('4. after the first deadline', second);
expect('the unanswered request was retried once', useTransportStore.getState().snapshotRequests, requestsBeforeUninit + 2);
expect('the retry keeps the reason and is marked', requestsOf(second).map((f) => f.payload.reason).slice(-1), ['probe_uninitialized']);
expect('the retry is marked as a retry', requestsOf(second).slice(-1)[0]?.payload.retry, 1);
await sleep(220);
summary('4b. after the attempt budget', second);
expect('the resync is reported as unanswered', useTransportStore.getState().snapshotUnanswered, 1);
expect('...with an explanation in lastError', /unanswered after 2 attempt/.test(useTransportStore.getState().lastError ?? ''), true);
expect('no request loop (attempts are bounded)', useTransportStore.getState().snapshotRequests, requestsBeforeUninit + 2);

// 5) a §6.2 `board.snapshot` without `tasks` must not reach `applySnapshot` (no wipe), and an
//    explicit `tasks: []` must clear the board. Measured through the real transport, not the mapper.
const before = useTransportStore.getState().appliedEvents;
second.push({ v: 1, id: 'e1', type: 'board.snapshot', seq: 21, payload: {} });
await sleep(10);
expect('partial snapshot counted as rejected', useTransportStore.getState().rejectedEvents, 1);
expect('partial snapshot applied nothing', useTransportStore.getState().appliedEvents, before);
second.push({ v: 1, id: 'e2', type: 'board.snapshot', seq: 22, payload: { tasks: [] } });
await sleep(10);
expect('explicit empty snapshot applied', useTransportStore.getState().appliedEvents, before + 1);
expect('a usable §6.2 snapshot settles a pending resync', useTransportStore.getState().snapshotReplies, 2);

kanbanTransport.stop();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
