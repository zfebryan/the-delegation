// @ts-nocheck
/**
 * Live harness: the **real** `KanbanTransport` (real stores, real reducers) against a **real**
 * `kanban-ws-bridge`. Assertions, not a print-out, because this is the evidence for cards
 * t_a38b3925 / t_32e1770f: the resync now comes from the bridge's `snapshot` (poller state),
 * `ping` is answered with `pong`, and the retired `backlog` no longer rewrites the board.
 *
 * Every frame on the wire is logged by wrapping `globalThis.WebSocket`, so the report shows what
 * actually left and arrived on the socket, not what the client believed.
 *
 * Usage (needs a bridge listening on the URL; see docs §6):
 *
 * ```bash
 * ./node_modules/.bin/esbuild scripts/kanban-transport/live.ts --bundle --platform=node \
 *   --format=esm \
 *   --define:'import.meta.env={"VITE_KANBAN_WS_URL":"ws://127.0.0.1:8123/ws","VITE_KANBAN_TRANSPORT_MODE":"remote","VITE_KANBAN_WS_RECONNECT_MIN_MS":"200","VITE_KANBAN_WS_RECONNECT_MAX_MS":"500","VITE_KANBAN_WS_HEARTBEAT_MS":"300","VITE_KANBAN_WS_HEARTBEAT_TIMEOUT_MS":"1500","VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS":"3000","VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS":"3"}' \
 *   --outfile=/tmp/kb-live.mjs && node /tmp/kb-live.mjs
 * ```
 *
 * `BOARD_FILE=<path>` makes the harness mutate the polled board JSON (one status change) so the
 * live-event half of the report has something real to observe.
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ── raw wire log: wrap the real WebSocket before the client is constructed ──
const received: any[] = [];
const sent: any[] = [];
const OriginalWebSocket = (globalThis as any).WebSocket;
let forcedCloses = 0;
let sockets = 0;

class LoggingWebSocket extends OriginalWebSocket {
  constructor(url: string) {
    super(url);
    sockets += 1;
    this.addEventListener('message', (event: any) => {
      try {
        received.push(JSON.parse(typeof event.data === 'string' ? event.data : '{}'));
      } catch {
        received.push({ raw: String(event.data) });
      }
    });
  }
  send(data: string) {
    try {
      sent.push(JSON.parse(data));
    } catch {
      sent.push({ raw: String(data) });
    }
    return super.send(data);
  }
  close() {
    if (this.readyState === 1) forcedCloses += 1;
    return super.close();
  }
}
(globalThis as any).WebSocket = LoggingWebSocket;

// The real stores persist to `localStorage` (zustand persist); Node has none.
const memory: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => memory[k] ?? null,
  setItem: (k: string, v: string) => { memory[k] = v; },
  removeItem: (k: string) => { delete memory[k]; },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

const { kanbanTransport } = await import('../../src/integration/transport/KanbanTransport');
const { useTransportStore, transportConfig } = await import('../../src/integration/transport/transportStore');
const { useCoreStore } = await import('../../src/integration/store/coreStore');

/**
 * Every `setLastError` call, in order. `lastError` alone is only the *newest* message, so a
 * transient `heartbeat timeout` would be invisible once a later warning overwrote it.
 */
const errorTrail: string[] = [];
const store = useTransportStore as any;
const recordLastError = store.getState().setLastError;
store.setState({
  setLastError: (message: string | null) => {
    if (message) errorTrail.push(String(message));
    recordLastError(message);
  },
});

const snap = () => useTransportStore.getState();
const boardIds = () => useCoreStore.getState().tasks.map((t: any) => `${t.id}/${t.status}`).sort();
/** Hermes kanban status → §6.2 `TaskStatus`, the same table the adapter applies (docs §7.2). */
const toRemote = (status: string) =>
  ({ todo: 'scheduled', ready: 'scheduled', triage: 'scheduled', running: 'in_progress', blocked: 'on_hold', review: 'on_hold', done: 'done' }[status] ?? status);
const boardOf = (rawTasks: any[]) => rawTasks.map((t: any) => `${t.id}/${toRemote(t.status)}`).sort();
const requestsOnWire = () => sent.filter((f) => f.type === 'board.snapshot.request');
const framesOfType = (type: string) => received.filter((f) => f.type === type);
const lastSnapshotFrame = () => framesOfType('snapshot').slice(-1)[0];

const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  console.log(`  (timeout waiting for ${label})`);
  return false;
};

const health = await (async () => {
  try {
    const url = new URL(String(transportConfig.url));
    const res = await fetch(`http://${url.host}/healthz`);
    const body: any = await res.json();
    return `tasks_tracked=${body.tasks_tracked} seq=${body.seq} poll_interval=${body.poll_interval_s}s`;
  } catch (error) {
    return `healthz unavailable: ${String(error)}`;
  }
})();
console.log(`bridge        : ${transportConfig.url} (${health})`);

kanbanTransport.start();
const connected = await waitFor(() => snap().connectionState === 'online', 3000, 'online');
check('socket came up', connected, true);

// 1) bootstrap: exactly one request, answered by the bridge's own snapshot (not the backlog).
await waitFor(() => snap().snapshotReplies >= 1, 4000, 'the snapshot reply');
check('exactly one board.snapshot.request per connect', requestsOnWire().length, 1);
check('...with reason `connected`', requestsOnWire()[0]?.payload?.reason, 'connected');
check('the bridge answered with one snapshot frame', framesOfType('snapshot').length, 1);
check('the reply was applied as the board', snap().snapshotReplies, 1);
check('the bridge sent exactly one (now retired) backlog frame', framesOfType('backlog').length, 1);
check('the backlog frame did not touch the board (applied == 1)', snap().appliedEvents, 1);
await waitFor(() => framesOfType('pong').length >= 1, 2500, 'the first pong');
check('the bridge answered the ping with a pong', framesOfType('pong').length >= 1, true);

const frameTasks = boardOf(lastSnapshotFrame()?.tasks ?? []);
check('the applied board equals the snapshot frame, task for task', boardIds(), frameTasks);
console.log(`board         : ${JSON.stringify(boardIds().slice(0, 6))}${boardIds().length > 6 ? ` (+${boardIds().length - 6})` : ''}`);

// 2) a board change reaches the client as a live event...
const boardFile = process.env.BOARD_FILE;
let mutatedIds: string[] | null = null;
if (boardFile) {
  const tasks = JSON.parse(readFileSync(boardFile, 'utf8'));
  const target = tasks.find((t: any) => t.status !== 'done' && t.assignee === 'dev');
  if (target) {
    target.status = 'done';
    writeFileSync(boardFile, JSON.stringify(tasks, null, 2));
    mutatedIds = boardOf(tasks);
    console.log(`mutated board : ${target.id} → done (${boardFile})`);
  }
} else {
  console.log('mutated board : (BOARD_FILE unset — live-change half skipped)');
}

if (mutatedIds) {
  await waitFor(() => boardIds().join() !== frameTasks.join(), 5000, 'the live status change');
  check('the live status_changed was applied', boardIds(), mutatedIds);
}

// 3) an explicit resync is answered from poller state: a *fresh* board, same request budget.
const requestsBefore = snap().snapshotRequests;
const repliesBefore = snap().snapshotReplies;
const snapped = kanbanTransport.requestSnapshot('live_probe');
check('requestSnapshot reports the frame was sent', snapped, true);
await waitFor(() => snap().snapshotReplies > repliesBefore, 3000, 'the second snapshot reply');
await sleep(200);
check('the resync was one request, not two', snap().snapshotRequests, requestsBefore + 1);
check('...and it was answered', snap().snapshotReplies, repliesBefore + 1);
check('no seq-gap request was injected by the snapshot reply', requestsOnWire().length, 2);
check('no resync was left unanswered', snap().snapshotUnanswered, 0);

// 4) heartbeat: the bridge answers pong, so the timeout path is armed — and must not fire on a
//    healthy socket. The timeout budget is deliberately roomier than the ping interval here (the
//    interval > timeout ordering, where a stall of one interval would look like a dead peer, is
//    pinned deterministically by `heartbeat.ts` scenario A on a fake socket).
const pongsBefore = framesOfType('pong').length;
await sleep(2000);
check('heartbeat timeout never force-closed a live socket', forcedCloses, 0);
check('pongs kept arriving (the timeout path is armed)', framesOfType('pong').length - pongsBefore >= 2, true);
check('socket still online', snap().connectionState, 'online');
check('no reconnect happened', sockets, 1);
check('no heartbeat error was recorded', errorTrail.filter((m) => /heartbeat timeout/.test(m)).length, 0);

console.log(
  `wire frames   : received=${framesOfType('backlog').length} backlog, ${framesOfType('snapshot').length} snapshot, ` +
  `${framesOfType('pong').length} pong, ${framesOfType('keepalive').length} keepalive | sent=` +
  `${requestsOnWire().length} board.snapshot.request, ${sent.filter((f) => f.type === 'ping').length} ping`,
);
console.log(`last snapshot : seq=${lastSnapshotFrame()?.seq} initialized=${lastSnapshotFrame()?.initialized} tasks=${lastSnapshotFrame()?.tasks?.length} ${JSON.stringify(lastSnapshotFrame()?.tasks?.map((t: any) => `${t.id}/${t.status}/${t.assignee}`))}`);
console.log(`error trail   : ${JSON.stringify(errorTrail)}`);

kanbanTransport.stop();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
