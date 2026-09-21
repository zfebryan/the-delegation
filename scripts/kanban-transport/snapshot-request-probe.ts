// @ts-nocheck
/**
 * Probe: how many `board.snapshot.request` frames does one connect / one reconnect produce?
 *
 * `smoke.ts` only covers the pure mapper, so this drives the real `KanbanTransport` against a
 * fake WebSocket (same trick as `heartbeat.ts`) and reads `transportStore.snapshotRequests`.
 * The bug it pins down: `onStateChange('online')` and `onReconnected` both asked for a
 * snapshot, so every reconnect sent two frames.
 *
 * `config.ts` reads `import.meta.env` (Vite), which Node does not provide, so run it with the
 * env inlined by esbuild:
 *
 * ```bash
 * ./node_modules/.bin/esbuild scripts/kanban-transport/snapshot-request-probe.ts \
 *   --bundle --platform=node --format=esm \
 *   --define:'import.meta.env={"VITE_KANBAN_WS_URL":"ws://fake/ws","VITE_KANBAN_TRANSPORT_MODE":"remote","VITE_KANBAN_WS_RECONNECT_MIN_MS":"10","VITE_KANBAN_WS_RECONNECT_MAX_MS":"10","VITE_KANBAN_WS_HEARTBEAT_MS":"60000"}' \
 *   --outfile=/tmp/kb-snap.mjs && node /tmp/kb-snap.mjs
 * ```
 */

type Fake = {
  readyState: number;
  sent: any[];
  open(): void;
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

const summary = (label: string, socket: Fake) => {
  const state = useTransportStore.getState();
  const requests = socket.sent.filter((f) => f.type === 'board.snapshot.request');
  console.log(
    `${label}\n  mode           : ${transportConfig.mode} url=${transportConfig.url}` +
    `\n  connectionState: ${state.connectionState}` +
    `\n  snapshotReq    : counter=${state.snapshotRequests} framesOnThisSocket=${requests.length}` +
    ` (reasons: ${JSON.stringify(requests.map((f) => f.payload.reason))})`,
  );
};

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

kanbanTransport.start();

// 1) first connect — exactly one request, reason `connected`
sockets[0].open();
await sleep(20);
summary('1. first connect', sockets[0]);
expect('first connect sends one request', sockets[0].sent.filter((f) => f.type === 'board.snapshot.request').length, 1);
expect('first connect counter', useTransportStore.getState().snapshotRequests, 1);
expect('first connect reason', sockets[0].sent.find((f) => f.type === 'board.snapshot.request')?.payload.reason, 'connected');

// 2) reconnect — exactly one request on the new socket, reason `reconnected`
sockets[0].close();
const reconnected = await waitForSockets(2);
const second = sockets[sockets.length - 1];
second.open();
await sleep(20);
summary('2. reconnect', second);
expect('reconnect opened a new socket', reconnected, true);
expect('reconnect sends one request', second.sent.filter((f) => f.type === 'board.snapshot.request').length, 1);
expect('reconnect increments the counter once', useTransportStore.getState().snapshotRequests, 2);
expect('reconnect reason', second.sent.find((f) => f.type === 'board.snapshot.request')?.payload.reason, 'reconnected');

// 3) a board.snapshot without `tasks` must not reach `applySnapshot` (no wipe), and an explicit
//    `tasks: []` must clear the board. Measured through the real transport, not the mapper alone.
const before = useTransportStore.getState().appliedEvents;
second.push({ v: 1, id: 'e1', type: 'board.snapshot', seq: 1, payload: {} });
await sleep(10);
expect('partial snapshot counted as rejected', useTransportStore.getState().rejectedEvents, 1);
expect('partial snapshot applied nothing', useTransportStore.getState().appliedEvents, before);
second.push({ v: 1, id: 'e2', type: 'board.snapshot', seq: 2, payload: { tasks: [] } });
await sleep(10);
expect('explicit empty snapshot applied', useTransportStore.getState().appliedEvents, before + 1);

kanbanTransport.stop();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;