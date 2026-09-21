// @ts-nocheck
// Standalone Node harness: heartbeat/liveness of KanbanWsClient with a fake WebSocket (no network).
import { KanbanWsClient } from '../../src/integration/transport/wsClient';

type Fake = {
  readyState: number;
  sent: any[];
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((m: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
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

const run = (label: string, drive: (sock: Fake, i: number) => void, ticks: number) =>
  new Promise<void>((resolve) => {
    sockets = [];
    const log: string[] = [];
    let reconnects = 0;
    const client = new KanbanWsClient({
      url: 'ws://fake/ws',
      reconnectMinDelayMs: 10,
      reconnectMaxDelayMs: 10,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 30,
      onEvent: () => {},
      onStateChange: (s) => log.push(s),
      onReconnected: () => { reconnects += 1; },
      onError: (m) => log.push(`err:${m}`),
    });
    client.connect();
    const first = sockets[0];
    first.open();
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      drive(sockets[sockets.length - 1] ?? first, i);
      if (i >= ticks) {
        clearInterval(timer);
        client.dispose();
        console.log(`${label}\n  log       : ${JSON.stringify(log)}\n  reconnects: ${reconnects}\n  pings     : ${first.sent.filter((p) => p.type === 'ping').length}`);
        resolve();
      }
    }, 50);
  });

await run('A. peer answers ping → dead socket is detected and reconnected',
  (sock, i) => { if (i === 1) sock.push({ type: 'pong' }); }, 6);

await run('B. silent peer (bridge) → no forced close, no reconnect loop',
  () => { /* never answers */ }, 6);