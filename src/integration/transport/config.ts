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
  };
}
