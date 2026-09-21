import type { KanbanEventEnvelope } from './types';
import type { RemoteTaskStatus } from './KanbanEventMapper';

/**
 * BridgeAdapter — frame `kanban-ws-bridge` → amplop §6.2 (`KanbanEventEnvelope`).
 *
 * The bridge in `criminals-sandbox` (`kanban-ws-bridge`, FastAPI) publishes *flat* frames
 * (`task_added`, `status_changed`, `task_updated`, `task_removed`, `backlog`, `poll_error`,
 * `keepalive`, and — since PR #12 — `snapshot` as the answer to `board.snapshot.request`),
 * while `KanbanEventMapper` consumes the §6.2 envelope
 * (`{v,id,type,seq,ts,projectId,agentIndex,taskId,payload}`). This module is the pure,
 * side-effect-free translation between the two, so it can be unit-tested without a socket.
 *
 * Decisions baked in here (rationale in `docs/kanban-transport.md` §7):
 *
 * - `assignee` (Hermes profile name) → `agentIndex` uses an **explicit table**
 *   (`VITE_KANBAN_AGENT_MAP`, default `dev:2,qa:3`). A name outside the table, or an index
 *   that does not exist in the active team, is dropped and **NACKed** — never guessed by
 *   position in the team (`getAllAgents` order differs per team set).
 * - Hermes task status → §6.2 `TaskStatus`: `todo|ready|triage → scheduled`,
 *   `running → in_progress`, `blocked|review → on_hold`, `done → done`; anything else is
 *   dropped with `unknown_status` instead of being guessed (a wrong column moves a character
 *   to the wrong desk). `on_hold` deliberately carries both "needs human review" and
 *   "in the boardroom" (§7.8).
 * - `id` is synthesized from the per-event `seq` the bridge does send
 *   (`bridge:<seq>`, plus `bridge:snapshot:<seq>` for the snapshot frame so it cannot collide
 *   with an event), so dedupe and `seq` gap detection stay enabled.
 * - `snapshot` (the bridge's answer to `board.snapshot.request`) becomes a `board.snapshot`
 *   built from the poller's `_state`: a **full** board, not a window over the event ring
 *   buffer. `initialized: false` means the poller has no baseline yet and is **not** applied
 *   (the last column of a real board must never be wiped by "not polled yet"); the frame still
 *   reports its `seq` as `baselineSeq` so gap detection is rebased on it.
 * - `backlog` is **retired** as a board source: its events are a bounded window, so the task
 *   list it produces is partial, and applying it as `board.snapshot` could delete local tasks
 *   that happen to have no event left in the buffer (same failure class as `t_4002d267`).
 *   The authoritative `snapshot` reply replaces it (§7.4).
 * - `task_updated` / `task_removed` are **not** mapped: §6.2 has no `task.updated`/`task.removed`
 *   event and the local `removeTask` pushes `phase → done` as a side effect (research §7.3).
 *   They are dropped with a NACK so the gap is visible rather than silent.
 */

export const BRIDGE_EVENT_TYPES = [
  'task_added',
  'status_changed',
  'task_updated',
  'task_removed',
  'backlog',
  'snapshot',
  'poll_error',
  'poll_recovered',
  'keepalive',
] as const;

export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number];

/**
 * Default `assignee` → `agentIndex` table (index 1 = lead/orchestrator, 2..4 = subagents).
 * The two operator profiles on this board (`dev`, `qa`) map to subagent desks; override with
 * `VITE_KANBAN_AGENT_MAP=name:index,...` when the active team differs.
 */
export const DEFAULT_AGENT_MAP: Record<string, number> = { dev: 2, qa: 3 };

/** Hermes kanban status → §6.2 `TaskStatus`. */
const STATUS_FROM_BRIDGE: Record<string, RemoteTaskStatus> = {
  todo: 'scheduled',
  ready: 'scheduled',
  triage: 'scheduled',
  scheduled: 'scheduled',
  running: 'in_progress',
  blocked: 'on_hold',
  review: 'on_hold',
  on_hold: 'on_hold',
  done: 'done',
};

/** §6.2 `TaskStatus` → Hermes kanban status (lossy: documented in docs §7). */
const STATUS_TO_BRIDGE: Record<RemoteTaskStatus, string> = {
  scheduled: 'ready',
  in_progress: 'running',
  on_hold: 'review',
  done: 'done',
};

export type NackReason =
  | 'unknown_assignee'
  | 'agent_not_in_team'
  | 'unknown_status'
  | 'malformed_task'
  | 'non_status_change_not_supported'
  | 'removal_not_supported';

/** Best-effort negative acknowledgement sent back to the bridge. */
export interface NackFrame {
  type: 'event.nack';
  reason: NackReason;
  bridgeType: string;
  taskId?: string;
  assignee?: string;
}

export type AdaptedKind =
  /** Not a bridge frame: the raw payload is already a §6.2 envelope. */
  | 'passthrough'
  /** One or more §6.2 envelopes to feed into dedupe/mapper. */
  | 'envelopes'
  /** Liveness only (bridge `keepalive`): nothing to map. */
  | 'liveness'
  /** Known bridge frame with no store effect; recorded with `reason`. */
  | 'ignored';

export interface AdaptedFrame {
  kind: AdaptedKind;
  bridgeType: string;
  envelopes: KanbanEventEnvelope[];
  nacks: NackFrame[];
  /** Machine-readable note for `ignored` frames (e.g. `bridge_poll_error`). */
  reason?: string;
  /**
   * The bridge's own `seq` counter as reported by this frame (bridge `snapshot` frames).
   * A snapshot is authoritative *at* that seq, so the transport adopts it as the gap-detection
   * baseline — including when the frame carries no usable tasks (`initialized: false`), where
   * not adopting it would make the next live event look like a gap and trigger a second
   * `board.snapshot.request` per connect (measured: `review-a/trace-out.txt`, card t_32e1770f).
   */
  baselineSeq?: number;
}

export interface BridgeAdapterOptions {
  /** `assignee` → `agentIndex` table. */
  agentMap?: Record<string, number>;
  /** Agent indexes that exist in the active team; mapped indexes outside it are NACKed. */
  validAgentIndices?: number[];
  projectId?: string;
  /** Injectable clock (ms) so envelopes stay deterministic in tests. */
  now?: () => number;
}

const asRecord = (raw: unknown): Record<string, any> | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : null;

const asNonEmptyString = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim().length > 0 ? raw : null;

const asFiniteNumber = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

/** Parses `"dev:1,qa:2"` into a map; malformed entries and negative indexes are skipped. */
export function parseAgentMap(raw: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'string') return out;
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .forEach((entry) => {
      const [name, index] = entry.split(':').map((part) => part.trim());
      const parsed = Number(index);
      if (!name || !Number.isInteger(parsed) || parsed < 0) return;
      out[name] = parsed;
    });
  return out;
}

export function isBridgeEventType(type: string): type is BridgeEventType {
  return (BRIDGE_EVENT_TYPES as readonly string[]).includes(type);
}

/** True when `raw` is a frame from `kanban-ws-bridge` (and not already a §6.2 envelope). */
export function isBridgeFrame(raw: unknown): boolean {
  const frame = asRecord(raw);
  const type = asNonEmptyString(frame?.type);
  return type !== null && isBridgeEventType(type);
}

/** Hermes kanban status → §6.2 `TaskStatus`; `null` when unknown (never guess). */
export function bridgeToTaskStatus(raw: unknown): RemoteTaskStatus | null {
  const status = asNonEmptyString(raw);
  if (!status) return null;
  return STATUS_FROM_BRIDGE[status.toLowerCase()] ?? null;
}

/** §6.2 `TaskStatus` → Hermes kanban status (for future egress commands). */
export function taskStatusToBridge(status: RemoteTaskStatus): string {
  return STATUS_TO_BRIDGE[status];
}

/** Bridge `ts` is Unix **seconds** (float); §6.2 envelopes use epoch milliseconds. */
const bridgeTsToMs = (value: unknown): number | undefined => {
  const seconds = asFiniteNumber(value);
  return seconds === null ? undefined : Math.round(seconds * 1000);
};

interface AgentResolution {
  index?: number;
  nack?: NackReason;
}

function resolveAgent(
  assignee: unknown,
  agentMap: Record<string, number>,
  validAgentIndices: number[],
): AgentResolution {
  const name = asNonEmptyString(assignee);
  if (!name) return {};
  const index = agentMap[name];
  if (typeof index !== 'number') return { nack: 'unknown_assignee' };
  if (validAgentIndices.length > 0 && !validAgentIndices.includes(index)) {
    return { nack: 'agent_not_in_team' };
  }
  return { index };
}

/** Task payload in the shape `KanbanEventMapper.normalizeTask` accepts. */
function toRemoteTask(
  bridgeTask: Record<string, any>,
  assignedAgentId: number,
  taskId: string,
): Record<string, any> {
  return {
    id: taskId,
    title: asNonEmptyString(bridgeTask.title) ?? taskId,
    // The bridge summarizes tasks without their body; the §6.2 contract has no body field either.
    description: '',
    assignedAgentId,
    status: bridgeToTaskStatus(bridgeTask.status) ?? 'scheduled',
    requiresUserApproval: false,
    createdAt: Math.round((asFiniteNumber(bridgeTask.created_at) ?? 0) * 1000) || undefined,
  };
}

/** Board phase derived from the translated task statuses (no bridge field carries it). */
function derivePhase(statuses: RemoteTaskStatus[]): 'idle' | 'working' | 'done' {
  if (statuses.length === 0) return 'idle';
  if (statuses.every((status) => status === 'done')) return 'done';
  if (statuses.some((status) => status === 'in_progress' || status === 'on_hold')) return 'working';
  return 'idle';
}

/**
 * Translates a bridge task list (the `snapshot` frame's `tasks`, same `summarize()` shape as the
 * `task` field of an event) into §6.2 task inputs. Tasks whose owner is unmapped / outside the
 * active team, or whose status is unknown, are **dropped with a NACK** instead of being applied
 * with a guessed desk — the same rule as the per-event path (docs §7.1, §7.2).
 */
function translateTaskList(
  tasks: unknown[],
  agentMap: Record<string, number>,
  validAgentIndices: number[],
  bridgeType: string,
): { translated: { taskId: string; task: Record<string, any>; status: RemoteTaskStatus }[]; nacks: NackFrame[] } {
  const nacks: NackFrame[] = [];
  const translated: { taskId: string; task: Record<string, any>; status: RemoteTaskStatus }[] = [];

  tasks.forEach((rawTask) => {
    const bridgeTask = asRecord(rawTask);
    if (!bridgeTask) return;
    const taskId = asNonEmptyString(bridgeTask.id);
    if (!taskId) return;
    const agent = resolveAgent(bridgeTask.assignee, agentMap, validAgentIndices);
    if (agent.nack || agent.index === undefined) {
      nacks.push({
        type: 'event.nack',
        reason: agent.nack ?? 'unknown_assignee',
        bridgeType,
        taskId,
        assignee: asNonEmptyString(bridgeTask.assignee) ?? undefined,
      });
      return;
    }
    const status = bridgeToTaskStatus(bridgeTask.status);
    if (!status) {
      nacks.push({ type: 'event.nack', reason: 'unknown_status', bridgeType, taskId });
      return;
    }
    translated.push({ taskId, task: toRemoteTask(bridgeTask, agent.index, taskId), status });
  });

  return { translated, nacks };
}

let synthesizedIdCounter = 0;

function envelopeId(seq: number | null, type: string, taskId: string | null, ts: number | undefined): string {
  if (seq !== null) return `bridge:${seq}`;
  if (ts !== undefined) return `bridge:${type}:${taskId ?? '-'}:${ts}`;
  synthesizedIdCounter += 1;
  return `bridge:${type}:${taskId ?? '-'}:local${synthesizedIdCounter}`;
}

/**
 * Translates one raw WebSocket frame into §6.2 envelopes plus (optionally) NACKs.
 *
 * Frames whose `type` is not a bridge event are returned as `passthrough` so a real §6.2
 * server can keep feeding the transport unchanged.
 */
export function adaptBridgeFrame(raw: unknown, options: BridgeAdapterOptions = {}): AdaptedFrame {
  const frame = asRecord(raw);
  const type = asNonEmptyString(frame?.type);

  if (!frame || type === null || !isBridgeEventType(type)) {
    return { kind: 'passthrough', bridgeType: type ?? '<none>', envelopes: [], nacks: [] };
  }

  const agentMap = options.agentMap ?? DEFAULT_AGENT_MAP;
  const validAgentIndices = options.validAgentIndices ?? [];
  const projectId = options.projectId;
  const now = options.now ?? (() => Date.now());
  const seq = asFiniteNumber(frame.seq);
  const ts = bridgeTsToMs(frame.ts) ?? now();

  const base = (envelopeType: string, taskId: string | null, agentIndex?: number) =>
    ({
      v: 1,
      id: envelopeId(seq, envelopeType, taskId, ts),
      type: envelopeType,
      seq: seq ?? undefined,
      ts,
      projectId,
      agentIndex,
      taskId: taskId ?? undefined,
    }) as KanbanEventEnvelope;

  switch (type) {
    // Liveness only: `WebSocket.onmessage` has already refreshed the liveness clock.
    case 'keepalive':
      return { kind: 'liveness', bridgeType: type, envelopes: [], nacks: [] };

    case 'poll_error':
      return { kind: 'ignored', bridgeType: type, envelopes: [], nacks: [], reason: 'bridge_poll_error' };

    case 'poll_recovered':
      return { kind: 'ignored', bridgeType: type, envelopes: [], nacks: [], reason: 'bridge_poll_recovered' };

    // §6.2 has no event for these; NACK so the divergence is visible (research §7.3).
    case 'task_updated':
      return {
        kind: 'ignored',
        bridgeType: type,
        envelopes: [],
        nacks: [
          {
            type: 'event.nack',
            reason: 'non_status_change_not_supported',
            bridgeType: type,
            taskId: asNonEmptyString(frame.task_id) ?? undefined,
            assignee: asNonEmptyString(asRecord(frame.task)?.assignee) ?? undefined,
          },
        ],
        reason: 'non_status_change_not_supported',
      };

    case 'task_removed':
      return {
        kind: 'ignored',
        bridgeType: type,
        envelopes: [],
        nacks: [
          {
            type: 'event.nack',
            reason: 'removal_not_supported',
            bridgeType: type,
            taskId: asNonEmptyString(frame.task_id) ?? undefined,
          },
        ],
        reason: 'removal_not_supported',
      };

    case 'task_added': {
      const task = asRecord(frame.task);
      const taskId = asNonEmptyString(task?.id) ?? asNonEmptyString(frame.task_id);
      if (!taskId) {
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [{ type: 'event.nack', reason: 'malformed_task', bridgeType: type }],
          reason: 'malformed_task',
        };
      }

      const agent = resolveAgent(task?.assignee, agentMap, validAgentIndices);
      if (agent.nack) {
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [
            {
              type: 'event.nack',
              reason: agent.nack,
              bridgeType: type,
              taskId,
              assignee: asNonEmptyString(task?.assignee) ?? undefined,
            },
          ],
          reason: agent.nack,
        };
      }

      const status = bridgeToTaskStatus(task?.status ?? frame.to_status);
      if (!status) {
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [{ type: 'event.nack', reason: 'unknown_status', bridgeType: type, taskId }],
          reason: 'unknown_status',
        };
      }

      const payloadTask = { ...toRemoteTask(task ?? {}, agent.index!, taskId), status };
      return {
        kind: 'envelopes',
        bridgeType: type,
        envelopes: [{ ...base('task.created', taskId, agent.index), payload: { task: payloadTask } }],
        nacks: [],
      };
    }

    case 'status_changed': {
      const task = asRecord(frame.task);
      const taskId = asNonEmptyString(frame.task_id) ?? asNonEmptyString(task?.id);
      if (!taskId) {
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [{ type: 'event.nack', reason: 'malformed_task', bridgeType: type }],
          reason: 'malformed_task',
        };
      }

      const status = bridgeToTaskStatus(frame.to_status ?? task?.status);
      if (!status) {
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [{ type: 'event.nack', reason: 'unknown_status', bridgeType: type, taskId }],
          reason: 'unknown_status',
        };
      }

      // The event carries the owner: a task whose assignee is unmapped/inactive is not ours.
      const agent = resolveAgent(task?.assignee ?? frame.assignee, agentMap, validAgentIndices);
      if (agent.nack) {
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [
            {
              type: 'event.nack',
              reason: agent.nack,
              bridgeType: type,
              taskId,
              assignee: asNonEmptyString(task?.assignee ?? frame.assignee) ?? undefined,
            },
          ],
          reason: agent.nack,
        };
      }

      return {
        kind: 'envelopes',
        bridgeType: type,
        envelopes: [{ ...base('task.status_changed', taskId, agent.index), payload: { taskId, status } }],
        nacks: [],
      };
    }

    // Retired as a board source: the bridge now answers `board.snapshot.request` with `snapshot`
    // built from the poller state, while the backlog is a bounded window over the event ring
    // buffer — applying it would delete local tasks whose events already left the buffer
    // (docs §7.4). Known frame, no store effect, no NACK (nothing is divergent).
    case 'backlog':
      return { kind: 'ignored', bridgeType: type, envelopes: [], nacks: [], reason: 'backlog_superseded' };

    // Resync answer to `board.snapshot.request`: the poller's current task state (`_state`),
    // independent of `EVENT_BUFFER_SIZE`.
    case 'snapshot': {
      const baselineSeq = seq ?? undefined;

      if (frame.initialized === false) {
        // The poller has not produced a baseline yet: an empty/short `tasks` list means
        // "unknown", not "empty board". Applying it would wipe a real local board, which is the
        // failure mode fixed for `board.snapshot` without `tasks` (t_4002d267). The `seq` is
        // still adopted so the first live event after the baseline is not read as a gap.
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [],
          reason: 'snapshot_not_initialized',
          baselineSeq,
        };
      }

      if (!Array.isArray(frame.tasks)) {
        // Defensive twin of the mapper's `missing_tasks` guard: a frame we cannot read in full
        // must never replace the board.
        return {
          kind: 'ignored',
          bridgeType: type,
          envelopes: [],
          nacks: [],
          reason: 'snapshot_missing_tasks',
          baselineSeq,
        };
      }

      const { translated, nacks } = translateTaskList(frame.tasks, agentMap, validAgentIndices, type);
      return {
        kind: 'envelopes',
        bridgeType: type,
        baselineSeq,
        envelopes: [
          {
            v: 1,
            // `seq` alone is not unique per reply: the bridge's snapshot does not consume its own
            // seq, so two resyncs with no event in between (a request plus its retry) arrive with
            // the same `seq`. `ts` (reply time, ms) makes the id stable for a repeated *frame* but
            // distinct across replies, so a retried resync is never dropped as a duplicate.
            id: seq !== null && ts !== undefined
              ? `bridge:snapshot:${seq}:${ts}`
              : envelopeId(seq, 'snapshot', null, ts),
            type: 'board.snapshot',
            seq: seq ?? undefined,
            ts,
            projectId,
            payload: {
              tasks: translated.map((entry) => entry.task),
              phase: derivePhase(translated.map((entry) => entry.status)),
            },
          },
        ],
        nacks,
      };
    }

    default:
      return { kind: 'passthrough', bridgeType: type, envelopes: [], nacks: [] };
  }
}