import { getAllAgents } from '../../data/agents';
import { useCoreStore } from '../store/coreStore';
import { useTeamStore, getActiveAgentSet } from '../store/teamStore';
import { useUiStore } from '../store/uiStore';
import { adaptBridgeFrame, AdaptedFrame, NackFrame } from './BridgeAdapter';
import { EventDedupe } from './EventDedupe';
import { MapperDeps, mapKanbanEvent, normalizeKanbanEvent } from './KanbanEventMapper';
import { isRemoteMode, transportConfig, useTransportStore } from './transportStore';
import { KanbanEventEnvelope } from './types';
import { KanbanWsClient } from './wsClient';

/** Upper bound on remembered NACK keys (bounded memory, no unbounded growth per session). */
const NACK_CACHE_SIZE = 200;

/**
 * KanbanTransport — Ingress seam (Seam A).
 *
 * Wiring: WebSocket → dedupe/seq-gap → `KanbanEventMapper` → existing store actions.
 * The mapper writes to `coreStore` (`tasks`, `phase`, histories, logs) and, for agent
 * status, to `uiStore.agentStatuses`. The 3D layer is never touched: `SceneManager`
 * keeps deriving motion from those two stores, so NPCs walk to the boardroom/desk/spawn
 * on their own as events arrive.
 *
 * Lifecycle is owned by `App.tsx` (mount/unmount).
 */
export class KanbanTransport {
  private client: KanbanWsClient | null = null;
  private dedupe = new EventDedupe(transportConfig.dedupeCacheSize);
  private unsubs: (() => void)[] = [];
  private started = false;
  /** Dedupe keys for NACKs already sent (bounded, see `sendNacks`). */
  private nackedKeys = new Set<string>();

  public get isStarted(): boolean {
    return this.started;
  }

  /** Idempotent: safe to call from a React effect. */
  public start(): void {
    if (this.started) return;
    this.started = true;

    if (!isRemoteMode()) {
      useTransportStore.getState().setConnectionState('disabled');
      return;
    }

    if (!transportConfig.url) {
      useTransportStore.getState().setLastError('VITE_KANBAN_WS_URL is not set');
      useTransportStore.getState().setConnectionState('offline');
      return;
    }

    this.client = new KanbanWsClient({
      url: transportConfig.url,
      reconnectMinDelayMs: transportConfig.reconnectMinDelayMs,
      reconnectMaxDelayMs: transportConfig.reconnectMaxDelayMs,
      heartbeatIntervalMs: transportConfig.heartbeatIntervalMs,
      heartbeatTimeoutMs: transportConfig.heartbeatTimeoutMs,
      onEvent: (event) => this.handleFrame(event),
      onStateChange: (state) => {
        useTransportStore.getState().setConnectionState(state);
        if (state === 'online') this.requestSnapshot('connected');
      },
      onReconnected: () => {
        // A new socket may have missed events: drop dedupe state and resync from a snapshot.
        this.dedupe.reset();
        this.requestSnapshot('reconnected');
      },
      onError: (message) => useTransportStore.getState().setLastError(message),
    });

    this.client.connect();

    // Switching team changes the agent index space → ask the board for a fresh snapshot.
    this.unsubs.push(
      useTeamStore.subscribe((state, prev) => {
        if (state.selectedAgentSetId !== prev.selectedAgentSetId) {
          this.requestSnapshot('team_changed');
        }
      }),
    );
  }

  public stop(): void {
    this.client?.dispose();
    this.client = null;
    this.unsubs.forEach((unsub) => unsub());
    this.unsubs = [];
    this.dedupe.reset();
    this.nackedKeys.clear();
    this.started = false;
    useTransportStore.getState().setConnectionState(isRemoteMode() ? 'offline' : 'disabled');
  }

  /** Asks the external board for a full board snapshot (resync path). */
  public requestSnapshot(reason: string): boolean {
    const sent = this.sendCommand('board.snapshot.request', {
      reason,
      lastSeq: this.dedupe.lastSequence,
    });
    if (sent) useTransportStore.getState().noteSnapshotRequest();
    return sent;
  }

  /**
   * Outbound command hook (egress seam): used for snapshot requests today and ready for
   * `chat.send` / `board.approve_task` / `board.reject_task` in the next phase.
   */
  public sendCommand(type: string, payload: Record<string, any> = {}): boolean {
    return this.client?.sendCommand(type, payload) ?? false;
  }

  private handleFrame(raw: unknown): void {
    const transport = useTransportStore.getState();

    if (transportConfig.bridgeAdapter === 'off') {
      this.applyEnvelope(normalizeKanbanEvent(raw));
      return;
    }

    const frame = adaptBridgeFrame(raw, {
      agentMap: transportConfig.agentMap,
      validAgentIndices: this.activeAgentIndices(),
      backlogMode: transportConfig.backlogMode,
    });

    switch (frame.kind) {
      case 'liveness':
        // The socket already refreshed its liveness clock for this frame.
        return;

      case 'ignored':
        transport.recordEvent({ status: 'ignored', reason: frame.reason ?? `bridge_${frame.bridgeType}` });
        this.sendNacks(frame.nacks);
        return;

      case 'envelopes':
        frame.envelopes.forEach((event) => this.applyEnvelope(event));
        this.sendNacks(frame.nacks);
        return;

      case 'passthrough':
      default:
        // A §6.2 server (or a frame type we do not know): let the mapper decide.
        this.applyEnvelope(normalizeKanbanEvent(raw));
        return;
    }
  }

  private applyEnvelope(event: KanbanEventEnvelope | null): void {
    const transport = useTransportStore.getState();

    if (!event || event.type === 'ping' || event.type === 'pong') {
      transport.recordEvent({ status: 'ignored', reason: 'invalid_envelope' }, undefined);
      return;
    }

    const verdict = this.dedupe.check(event);
    if (verdict.gap) {
      // Missing events: the local view is incomplete, so resync instead of diverging.
      this.requestSnapshot('seq_gap');
    }
    if (verdict.duplicate) {
      transport.recordEvent({ status: 'ignored', reason: 'duplicate_event' }, event.seq);
      return;
    }

    const result = mapKanbanEvent(event, this.buildDeps());
    transport.recordEvent(result, event.seq);

    if (result.status === 'rejected') {
      console.warn(`[KanbanTransport] rejected "${event.type}" (${result.reason})`, event.id ?? '');
    }
  }

  /**
   * Best-effort NACK for bridge events that were dropped (unmapped assignee, unknown status,
   * unsupported type). `kanban-ws-bridge` ignores inbound frames, so this is observability,
   * not flow control — and each distinct reason/task pair is sent at most once per session so
   * a persistently unmapped task cannot spam the socket.
   */
  private sendNacks(nacks: NackFrame[]): void {
    const transport = useTransportStore.getState();
    nacks.forEach((nack) => {
      const key = `${nack.reason}:${nack.bridgeType}:${nack.taskId ?? '-'}:${nack.assignee ?? '-'}`;
      if (this.nackedKeys.has(key)) return;
      this.nackedKeys.add(key);
      while (this.nackedKeys.size > NACK_CACHE_SIZE) {
        const oldest = this.nackedKeys.values().next();
        if (oldest.done) break;
        this.nackedKeys.delete(oldest.value);
      }
      transport.noteNack();
      this.sendCommand('event.nack', {
        reason: nack.reason,
        bridgeType: nack.bridgeType,
        taskId: nack.taskId,
        assignee: nack.assignee,
      });
    });
  }

  /** Agent indexes of the active team: the second gate on the `assignee` → index mapping. */
  private activeAgentIndices(): number[] {
    return getAllAgents(getActiveAgentSet()).map((agent) => agent.index);
  }

  private buildDeps(): MapperDeps {
    const system = getActiveAgentSet();
    return {
      core: useCoreStore.getState() as unknown as MapperDeps['core'],
      ui: useUiStore.getState() as unknown as MapperDeps['ui'],
      validAgentIndices: getAllAgents(system).map((agent) => agent.index),
    };
  }
}

/** App-wide singleton, mounted by `App.tsx`. */
export const kanbanTransport = new KanbanTransport();
