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
  /** Guards the one-time `board.snapshot.request` on the first connect (see `onStateChange`). */
  private requestedInitialSnapshot = false;
  /** Dedupe keys for NACKs already sent (bounded, see `sendNacks`). */
  private nackedKeys = new Set<string>();
  /**
   * The `board.snapshot.request` still waiting for its `snapshot` reply (bridge, PR #12) or for
   * a `board.snapshot` envelope (§6.2 server). A resync is answered in-frame now, so "the socket
   * was open when we sent it" is no longer mistaken for "the board answered" (t_32e1770f).
   */
  private pendingSnapshot: { reason: string; attempts: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

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
        // A dead socket cannot answer a pending request; the reconnect path asks again.
        if (state === 'offline') this.clearSnapshotDeadline();
        // Only the *first* successful connect asks here; every later one goes through
        // `onReconnected`. Requesting from both paths sent two `board.snapshot.request`
        // frames per reconnect (observed as a 2× `snapshotRequests` counter).
        if (state !== 'online' || this.requestedInitialSnapshot) return;
        this.requestedInitialSnapshot = true;
        this.requestSnapshot('connected');
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
    this.clearSnapshotDeadline();
    this.requestedInitialSnapshot = false;
    this.started = false;
    useTransportStore.getState().setConnectionState(isRemoteMode() ? 'offline' : 'disabled');
  }

  /** Asks the external board for a full board snapshot (resync path). */
  public requestSnapshot(reason: string): boolean {
    const sent = this.sendCommand('board.snapshot.request', {
      reason,
      lastSeq: this.dedupe.lastSequence,
    });
    if (!sent) return false;
    useTransportStore.getState().noteSnapshotRequest();
    // The request is only half the story: the board now answers with `snapshot`, so wait for it
    // (`armSnapshotDeadline`) instead of trusting the open socket.
    this.armSnapshotDeadline(reason, 1);
    return true;
  }

  /**
   * Arms the reply deadline of a pending `board.snapshot.request`.
   *
   * A peer that does not answer (an old bridge, or one whose poller has no baseline yet:
   * `snapshot` with `initialized: false`) gets `snapshotMaxAttempts` attempts, then the resync is
   * reported as unanswered (`snapshotUnanswered` + `lastError`) instead of the client silently
   * believing it has a fresh board. Bounded on purpose: no request loop.
   */
  private armSnapshotDeadline(reason: string, attempts: number): void {
    this.clearSnapshotDeadline();
    const timer = setTimeout(() => this.onSnapshotDeadline(reason, attempts), transportConfig.snapshotReplyTimeoutMs);
    this.pendingSnapshot = { reason, attempts, timer };
  }

  private clearSnapshotDeadline(): void {
    if (this.pendingSnapshot?.timer) clearTimeout(this.pendingSnapshot.timer);
    this.pendingSnapshot = null;
  }

  /** The reply did not arrive (or was not usable) in time. */
  private onSnapshotDeadline(reason: string, attempts: number): void {
    this.pendingSnapshot = null;
    const transport = useTransportStore.getState();

    if (attempts >= transportConfig.snapshotMaxAttempts) {
      transport.noteSnapshotUnanswered();
      transport.setLastError(
        `board.snapshot.request unanswered after ${attempts} attempt(s) (${reason})`,
      );
      return;
    }

    const sent = this.sendCommand('board.snapshot.request', {
      reason,
      lastSeq: this.dedupe.lastSequence,
      retry: attempts,
    });
    if (!sent) return; // socket gone: the reconnect path asks again
    transport.noteSnapshotRequest();
    this.armSnapshotDeadline(reason, attempts + 1);
  }

  /** A usable snapshot arrived: the resync is complete. */
  private settleSnapshotReply(): void {
    this.clearSnapshotDeadline();
    useTransportStore.getState().noteSnapshotReply();
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
    });

    // A bridge `snapshot` frame carries the poller's own `seq` counter. Adopt it as the gap
    // baseline *before* dispatching: the snapshot is the state at that seq, so the next live
    // event is contiguous, and a snapshot that skipped seqs is not a gap (asking again would
    // double `board.snapshot.request` per connect — t_32e1770f, review-a/trace-out.txt).
    if (typeof frame.baselineSeq === 'number') this.dedupe.adoptBaseline(frame.baselineSeq);

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

    // A snapshot *is* the state at its `seq`, so it is adopted as the gap baseline before the
    // check: the snapshot that answered our resync must not itself be read as a `seq` gap
    // (that sent a second `board.snapshot.request` per connect — t_32e1770f).
    if (event.type === 'board.snapshot' && typeof event.seq === 'number' && Number.isFinite(event.seq)) {
      this.dedupe.adoptBaseline(event.seq);
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

    // The resync has been answered (the pending request is complete) only when the snapshot was
    // actually usable: a partial one (`missing_tasks`) still leaves the board stale.
    if (event.type === 'board.snapshot' && result.status === 'applied') {
      this.settleSnapshotReply();
    }

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
