/**
 * Shared types for the external kanban event transport (Seam A — Ingress).
 *
 * Nothing in this file touches the 3D layer: events are translated into
 * `coreStore` / `uiStore` actions only, and the visual layer keeps reacting to
 * those stores exactly like it does in local (Gemini) mode.
 */

export type TransportMode = 'local' | 'remote';

/** Connection badge state, mirrored into `uiStore.connectionState`. */
export type ConnectionState = 'disabled' | 'connecting' | 'online' | 'offline';

/**
 * Wire envelope for every event coming from the external board/bridge.
 * `type` is the only required field — unknown/absent optional fields must be
 * ignored (never throw) so the server can evolve independently.
 */
export interface KanbanEventEnvelope {
  v?: number;
  id?: string;
  type: string;
  seq?: number;
  ts?: number;
  projectId?: string;
  agentIndex?: number;
  taskId?: string;
  payload?: Record<string, any>;
}

export interface TransportConfig {
  mode: TransportMode;
  /** `null` when no WebSocket URL is configured (transport stays disabled). */
  url: string | null;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  heartbeatIntervalMs: number;
  /** How long to wait for a pong before treating the socket as dead. */
  heartbeatTimeoutMs: number;
  /** LRU size for event id dedupe. */
  dedupeCacheSize: number;
}

/** Outcome of mapping a single event onto store actions (used for logging/counters). */
export type MapStatus = 'applied' | 'ignored' | 'rejected';

export interface MapResult {
  status: MapStatus;
  /** Short machine-readable reason, e.g. `unknown_type`, `unknown_agent`, `unknown_task`. */
  reason?: string;
}
