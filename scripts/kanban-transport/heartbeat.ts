// @ts-nocheck
/**
 * Standalone Node harness: heartbeat/liveness of KanbanWsClient with a fake WebSocket (no
 * network). Scenario A is the reason this file has assertions: `heartbeatTimeoutMs` is only
 * reachable now that the bridge answers `ping` (PR #12), and the naive "now - lastPong > timeout"
 * rule closes a *healthy* socket on the second tick whenever interval > timeout (the defaults are
 * 15000 / 10000). Run it with esbuild, see docs/kanban-transport.md §6.
 */
import { KanbanWsClient } from '../../src/integration/transport/wsClient';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${a}${ok ? '' : ` (expected ${e})`}`);
};

type Fake = {
  readyState: number;
  sent: any[];
  open(): void;
  push(payload: any): void;
  close(): void;
};

let sockets: Fake[] = [];
/** Socket closes issued by the client while the socket was OPEN (a force-close). */
let forcedCloses = 0;

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
  close() {
    if (this.readyState === 1) forcedCloses += 1;
    this.readyState = 3;
    this.onclose?.();
  }
}

(globalThis as any).WebSocket = FakeWebSocket;

interface RunResult {
  log: string[];
  forcedCloses: number;
  reconnects: number;
  /** Pings sent per socket, in dial order. */
  pingsPerSocket: number[];
  finalState: string;
}

/**
 * Drives the client for `ticks` heartbeat intervals. `answerPong(sock, i)` decides whether the
 * peer answers the ping for tick `i`; the harness auto-opens every socket the client dials (so a
 * reconnect actually proceeds).
 */
const run = (
  label: string,
  options: { intervalMs: number; timeoutMs: number; ticks: number; answerPong: (sock: Fake, i: number) => boolean },
): Promise<RunResult> =>
  new Promise((resolve) => {
    sockets = [];
    forcedCloses = 0;
    const log: string[] = [];
    let reconnects = 0;

    const client = new KanbanWsClient({
      url: 'ws://fake/ws',
      reconnectMinDelayMs: 5,
      reconnectMaxDelayMs: 5,
      heartbeatIntervalMs: options.intervalMs,
      heartbeatTimeoutMs: options.timeoutMs,
      onEvent: () => {},
      onStateChange: (s) => log.push(s),
      onReconnected: () => { reconnects += 1; },
      onError: (m) => log.push(`err:${m}`),
    });

    client.connect();
    sockets[0].open();

    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      const sock = sockets[sockets.length - 1];
      // A reconnect dialled a new socket: bring it up the way a server would.
      if (sock.readyState === 0) sock.open();
      if (options.answerPong(sock, i)) sock.push({ type: 'pong', ts: Date.now() });

      if (i >= options.ticks) {
        clearInterval(timer);
        // Read the outcome *before* disposing: `dispose()` closes the socket on purpose (and that
        // close is not a liveness decision).
        const pingsPerSocket = sockets.map((s) => s.sent.filter((f) => f.type === 'ping').length);
        const result = { log, forcedCloses, reconnects, pingsPerSocket, finalState: client.connectionState };
        client.dispose();
        console.log(`${label}\n  log         : ${JSON.stringify(log)}\n  pings/socket: ${JSON.stringify(pingsPerSocket)}`);
        resolve(result);
      }
    }, options.intervalMs);
  });

// A. answering peer with interval (50) > timeout (30): the previous pong is always one whole
//    interval old by the next tick, so the naive rule force-closes a healthy socket. Must not.
const a = await run('A. peer answers every ping (interval > timeout) → stays online', {
  intervalMs: 50, timeoutMs: 30, ticks: 8, answerPong: () => true,
});
check('A: no forced close', a.forcedCloses, 0);
check('A: no reconnect', a.reconnects, 0);
check('A: connection stays online', a.finalState, 'online');
check('A: no heartbeat timeout logged', a.log.some((line) => line.includes('heartbeat timeout')), false);
check('A: no false "peer never answered" warning before the first pong', a.log.some((line) => line.includes('never answered ping')), false);
check('A: one ping per tick (each one answered, so the next tick asks again)', a.pingsPerSocket[0], 8);

// B. peer answers, then goes silent → the socket is declared dead and the client reconnects.
const b = await run('B. peer answers once, then goes silent → dead socket detected + reconnect', {
  intervalMs: 50, timeoutMs: 30, ticks: 8, answerPong: (_sock, i) => i <= 1,
});
check('B: forced close happened', b.forcedCloses >= 1, true);
check('B: heartbeat timeout logged', b.log.some((line) => line.includes('heartbeat timeout')), true);
check('B: a new socket was dialled', b.pingsPerSocket.length >= 2, true);
check('B: onReconnected fired for the new socket', b.reconnects >= 1, true);

// C. silent peer (the pre-PR#12 bridge): no forced close, no reconnect loop, one warning, and the
//    keepalive cadence is unchanged (one ping per tick).
const c = await run('C. silent peer → never force-closed (onclose owns death detection)', {
  intervalMs: 50, timeoutMs: 30, ticks: 6, answerPong: () => false,
});
check('C: no forced close', c.forcedCloses, 0);
check('C: no reconnect', c.reconnects, 0);
check('C: connection stays online', c.finalState, 'online');
check('C: warned once about the missing handshake', c.log.filter((line) => line.includes('never answered ping')).length, 1);
check('C: keeps pinging the socket warm (one per tick)', c.pingsPerSocket[0], 6);

// D. deadline measured from the ping, not from the last pong: with timeout (30) < interval (50) a
//    proven peer that stops answering is detected on the next tick, and the outstanding ping is
//    not re-sent before then.
const d = await run('D. proven peer stops answering → detected on the next tick', {
  intervalMs: 50, timeoutMs: 30, ticks: 6, answerPong: (_sock, i) => i === 1,
});
check('D: the outstanding ping is not re-sent before the deadline', d.pingsPerSocket[0] <= 3, true);
check('D: forced close happened after the deadline', d.forcedCloses >= 1, true);

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
