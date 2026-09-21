import { DEFAULT_AGENT_MAP, parseAgentMap } from './BridgeAdapter';
import { TransportConfig, TransportMode } from './types';

/**
 * Env-driven transport configuration.
 *
 * - `VITE_KANBAN_WS_URL`           → WebSocket URL of the external bridge.
 * - `VITE_KANBAN_TRANSPORT_MODE`   → force `remote`/`local` (otherwise derived
 *                                     from the presence of the URL).
 * - `VITE_KANBAN_WS_RECONNECT_*`   → reconnect backoff bounds.
 * - `VITE_KANBAN_WS_HEARTBEAT_MS`  → ping interval.
 *
 * In remote mode the app stops driving the board with Gemini (`AgentSimulation`
 * is disarmed) and instead reflects whatever the external board publishes.
 */
const asPositiveNumber = (raw: unknown, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const asPositiveInteger = (raw: unknown, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * Vite inlines `import.meta.env.<NAME>` statically, so the reads below must be explicit
 * property accesses (a destructured/dynamic lookup would ship `import.meta.env` unresolved).
 */
const readBuildEnv = (): Record<string, unknown> => ({
  VITE_KANBAN_WS_URL: import.meta.env.VITE_KANBAN_WS_URL,
  VITE_KANBAN_TRANSPORT_MODE: import.meta.env.VITE_KANBAN_TRANSPORT_MODE,
  VITE_KANBAN_WS_RECONNECT_MIN_MS: import.meta.env.VITE_KANBAN_WS_RECONNECT_MIN_MS,
  VITE_KANBAN_WS_RECONNECT_MAX_MS: import.meta.env.VITE_KANBAN_WS_RECONNECT_MAX_MS,
  VITE_KANBAN_WS_HEARTBEAT_MS: import.meta.env.VITE_KANBAN_WS_HEARTBEAT_MS,
  VITE_KANBAN_WS_HEARTBEAT_TIMEOUT_MS: import.meta.env.VITE_KANBAN_WS_HEARTBEAT_TIMEOUT_MS,
  VITE_KANBAN_WS_DEDUPE_SIZE: import.meta.env.VITE_KANBAN_WS_DEDUPE_SIZE,
  VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS: import.meta.env.VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS,
  VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS: import.meta.env.VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS,
  VITE_KANBAN_AGENT_MAP: import.meta.env.VITE_KANBAN_AGENT_MAP,
  VITE_KANBAN_BRIDGE_ADAPTER: import.meta.env.VITE_KANBAN_BRIDGE_ADAPTER,
});

export function resolveTransportConfig(
  env: Record<string, unknown> = readBuildEnv(),
): TransportConfig {
  const url = String(env.VITE_KANBAN_WS_URL ?? '').trim();
  const explicitMode = String(env.VITE_KANBAN_TRANSPORT_MODE ?? '').trim().toLowerCase();

  let mode: TransportMode;
  if (explicitMode === 'remote' || explicitMode === 'local') {
    mode = explicitMode;
  } else {
    mode = url ? 'remote' : 'local';
  }

  return {
    mode,
    url: url || null,
    reconnectMinDelayMs: asPositiveNumber(env.VITE_KANBAN_WS_RECONNECT_MIN_MS, 500),
    reconnectMaxDelayMs: asPositiveNumber(env.VITE_KANBAN_WS_RECONNECT_MAX_MS, 15000),
    heartbeatIntervalMs: asPositiveNumber(env.VITE_KANBAN_WS_HEARTBEAT_MS, 15000),
    heartbeatTimeoutMs: asPositiveNumber(env.VITE_KANBAN_WS_HEARTBEAT_TIMEOUT_MS, 10000),
    dedupeCacheSize: asPositiveNumber(env.VITE_KANBAN_WS_DEDUPE_SIZE, 500),
    // `kanban-ws-bridge` speaks its own flat frame format; the adapter is what makes those
    // frames land in the §6.2 envelope. `off` keeps the raw §6.2 path for a future server.
    bridgeAdapter: String(env.VITE_KANBAN_BRIDGE_ADAPTER ?? '').trim().toLowerCase() === 'off' ? 'off' : 'auto',
    // The bridge answers `board.snapshot.request` with `snapshot` (PR #12), so a resync no longer
    // has to trust "the socket was open": wait for the reply, retry a bounded number of times,
    // then report it as unanswered.
    snapshotReplyTimeoutMs: asPositiveNumber(env.VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS, 5000),
    snapshotMaxAttempts: asPositiveInteger(env.VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS, 3),
    // Explicit table beats guessing: see BridgeAdapter header + docs §7.
    agentMap: { ...DEFAULT_AGENT_MAP, ...parseAgentMap(env.VITE_KANBAN_AGENT_MAP as string) },
  };
}
