// @ts-nocheck
// Standalone Node harness: real KanbanWsClient + mapper against a running board bridge.
// Usage: node <bundle> [ws://127.0.0.1:8000/ws]
import { KanbanWsClient } from '../../src/integration/transport/wsClient';
import { EventDedupe } from '../../src/integration/transport/EventDedupe';
import { mapKanbanEvent, normalizeKanbanEvent, MapperCoreActions, MapperUiActions } from '../../src/integration/transport/KanbanEventMapper';

const states: string[] = [];
let reconnects = 0;
const byType: Record<string, number> = {};
const byStatus: Record<string, number> = {};
const applied: string[] = [];

const calls: string[] = [];
const core = new Proxy({} as MapperCoreActions, {
  get: (_t, prop) => {
    if (prop === 'tasks') return [];
    if (prop === 'phase') return 'idle';
    if (prop === 'userBrief') return '';
    return (...args: any[]) => { calls.push(`${String(prop)}:${JSON.stringify(args)}`); };
  },
});
const ui = { agentStatuses: {}, setAgentStatus: (i: number, s: string) => calls.push(`setAgentStatus:${i}:${s}`) } as unknown as MapperUiActions;

const dedupe = new EventDedupe(500);

const client = new KanbanWsClient({
  url: process.argv[2] ?? 'ws://127.0.0.1:8000/ws',
  reconnectMinDelayMs: 300,
  reconnectMaxDelayMs: 1000,
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 800,
  onEvent: (raw) => {
    const event = normalizeKanbanEvent(raw);
    if (!event) { byType['<invalid>'] = (byType['<invalid>'] ?? 0) + 1; return; }
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    const verdict = dedupe.check(event);
    if (verdict.duplicate) { byStatus['duplicate'] = (byStatus['duplicate'] ?? 0) + 1; return; }
    const result = mapKanbanEvent(event, { core, ui, validAgentIndices: [1, 2, 3, 4] });
    const key = `${result.status}${result.reason ? `:${result.reason}` : ''}`;
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    if (result.status === 'applied') applied.push(event.type);
  },
  onStateChange: (s) => { states.push(s); },
  onReconnected: () => { reconnects += 1; },
  onError: (m) => { states.push(`err:${m}`); },
});

client.connect();

setTimeout(() => {
  client.dispose();
  console.log('states        :', JSON.stringify(states));
  console.log('reconnects    :', reconnects);
  console.log('events by type:', JSON.stringify(byType));
  console.log('map results   :', JSON.stringify(byStatus));
  console.log('store calls   :', JSON.stringify(calls.slice(0, 5)), calls.length);
  process.exit(0);
}, Number(process.env.SECONDS ?? 8) * 1000);
