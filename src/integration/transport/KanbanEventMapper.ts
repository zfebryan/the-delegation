import { AgentState } from '../../types';
import { KanbanEventEnvelope, MapResult } from './types';

/**
 * KanbanEventMapper — pure mapping layer between external board events and the
 * app's existing store actions (see `docs/research/the-delegation-integration.md` §6.2).
 *
 * The mapper never touches `SceneManager`/3D: it only calls store actions, and the
 * visual layer keeps reacting to `coreStore.tasks` + `uiStore.agentStatuses` as usual.
 * Stores are injected, so the mapping can be unit-tested without a browser.
 */

export type RemoteTaskStatus = 'scheduled' | 'on_hold' | 'in_progress' | 'done';
export type RemotePhase = 'idle' | 'working' | 'done';

export interface RemoteTaskInput {
  id?: string;
  title?: string;
  description?: string;
  assignedAgentId?: number;
  status?: RemoteTaskStatus;
  parentTaskId?: string;
  requiresUserApproval?: boolean;
  draftOutput?: string;
  reviewComments?: string;
  output?: string;
  revisions?: { output: string; feedback?: string; timestamp: number }[];
  createdAt?: number;
  updatedAt?: number;
}

export interface BoardSnapshotInput {
  tasks?: RemoteTaskInput[];
  phase?: RemotePhase;
  brief?: string;
  userBrief?: string;
  agentStatuses?: Record<number | string, AgentState>;
}

/** Subset of `coreStore` used by the mapper (structurally satisfied by the real store). */
export interface MapperCoreActions {
  tasks: { id: string; status: RemoteTaskStatus; assignedAgentId: number }[];
  phase: RemotePhase;
  userBrief: string;
  startProject: (brief: string) => void;
  setPhase: (phase: RemotePhase) => void;
  setUserBrief: (brief: string) => void;
  addTask: (task: RemoteTaskInput & { title: string; description: string; assignedAgentId: number; status: RemoteTaskStatus; requiresUserApproval: boolean }) => { id: string };
  applySnapshot: (snapshot: {
    tasks: (RemoteTaskInput & { id: string; title: string; description: string; assignedAgentId: number; status: RemoteTaskStatus; requiresUserApproval: boolean })[];
    phase?: RemotePhase;
    userBrief?: string;
    agentStatuses?: Record<number, AgentState>;
  }) => void;
  updateTaskStatus: (taskId: string, status: RemoteTaskStatus, options?: { force?: boolean }) => void;
  reopenTask: (taskId: string, status: RemoteTaskStatus) => void;
  submitTaskForReview: (taskId: string, draftOutput?: string) => void;
  setTaskOutput: (taskId: string, output: string) => void;
  approveTask: (taskId: string) => void;
  rejectTask: (taskId: string, comments: string, options?: { writeHistory?: boolean }) => void;
  setFinalOutput: (output: string) => void;
  setFinalAsset: (type: 'image' | 'audio' | 'video', content: string) => void;
  addLogEntry: (entry: { agentIndex: number; action: string; taskId?: string }) => void;
  appendAgentHistory: (agentIndex: number, role: 'user' | 'assistant', parts: any[]) => void;
  setAgentHistory: (agentIndex: number, history: any[]) => void;
  addResponseLog: (entry: any) => void;
}

/** Subset of `uiStore` used by the mapper. */
export interface MapperUiActions {
  agentStatuses: Record<number, AgentState>;
  setAgentStatus: (index: number, status: AgentState) => void;
}

export interface MapperDeps {
  core: MapperCoreActions;
  ui: MapperUiActions;
  /** Agent indexes that exist in the active team (0 = user). Events for others are rejected. */
  validAgentIndices: number[];
}

const TASK_STATUSES: RemoteTaskStatus[] = ['scheduled', 'on_hold', 'in_progress', 'done'];
const AGENT_STATES: AgentState[] = ['idle', 'moving', 'working', 'on_hold', 'talking'];
const PHASES: RemotePhase[] = ['idle', 'working', 'done'];

const asStatus = (raw: unknown): RemoteTaskStatus | null =>
  TASK_STATUSES.includes(raw as RemoteTaskStatus) ? (raw as RemoteTaskStatus) : null;

const asAgentState = (raw: unknown): AgentState | null =>
  AGENT_STATES.includes(raw as AgentState) ? (raw as AgentState) : null;

const asPhase = (raw: unknown): RemotePhase | null =>
  PHASES.includes(raw as RemotePhase) ? (raw as RemotePhase) : null;

const asNonEmptyString = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim().length > 0 ? raw : null;

/** Missing/absent optional envelope fields are ignored, never fatal. */
export function normalizeKanbanEvent(raw: unknown): KanbanEventEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, any>;
  if (candidate.type === 'ping' || candidate.type === 'pong') {
    return { type: candidate.type, id: candidate.id, seq: candidate.seq };
  }
  const type = asNonEmptyString(candidate.type);
  if (!type) return null;
  return {
    v: typeof candidate.v === 'number' ? candidate.v : undefined,
    id: asNonEmptyString(candidate.id) ?? undefined,
    type,
    seq: typeof candidate.seq === 'number' && Number.isFinite(candidate.seq) ? candidate.seq : undefined,
    ts: typeof candidate.ts === 'number' ? candidate.ts : undefined,
    projectId: asNonEmptyString(candidate.projectId) ?? undefined,
    agentIndex: typeof candidate.agentIndex === 'number' ? candidate.agentIndex : undefined,
    taskId: asNonEmptyString(candidate.taskId) ?? undefined,
    payload: candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {},
  };
}

export function mapKanbanEvent(event: KanbanEventEnvelope, deps: MapperDeps): MapResult {
  const { core, ui, validAgentIndices } = deps;
  const payload: Record<string, any> = event.payload ?? {};
  const taskId = asNonEmptyString(payload.taskId) ?? event.taskId ?? null;
  const agentIndex = typeof payload.agentIndex === 'number' ? payload.agentIndex : event.agentIndex;

  const isKnownAgent = (index: number | undefined): index is number =>
    typeof index === 'number' && validAgentIndices.includes(index);

  switch (event.type) {
    // ── Project ──────────────────────────────────────────────────
    case 'project.brief_received': {
      const brief = asNonEmptyString(payload.brief) ?? asNonEmptyString(payload.userBrief);
      if (brief === null) return { status: 'rejected', reason: 'missing_brief' };
      core.startProject(brief);
      return { status: 'applied' };
    }

    case 'project.phase_changed': {
      const phase = asPhase(payload.phase ?? payload.status);
      if (!phase) return { status: 'rejected', reason: 'invalid_phase' };
      core.setPhase(phase);
      return { status: 'applied' };
    }

    case 'project.final_output': {
      const output = asNonEmptyString(payload.output) ?? '';
      core.setFinalOutput(output);
      core.setPhase('done');
      return { status: 'applied' };
    }

    case 'project.asset_ready': {
      const type = payload.type === 'music' ? 'audio' : payload.type;
      if (type !== 'image' && type !== 'audio' && type !== 'video') {
        return { status: 'rejected', reason: 'invalid_asset_type' };
      }
      const content = typeof payload.content === 'string' ? payload.content : '';
      core.setFinalAsset(type, content);
      core.setPhase('done');
      return { status: 'applied' };
    }

    // ── Board ────────────────────────────────────────────────────
    case 'board.snapshot': {
      const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      const tasks = rawTasks
        .map((t) => normalizeTask(t, validAgentIndices))
        .filter((t): t is NonNullable<ReturnType<typeof normalizeTask>> & { id: string } => !!t && !!t.id);

      const agentStatuses = normalizeAgentStatuses(payload.agentStatuses, validAgentIndices);
      core.applySnapshot({
        tasks,
        phase: asPhase(payload.phase) ?? undefined,
        userBrief: asNonEmptyString(payload.brief) ?? asNonEmptyString(payload.userBrief) ?? undefined,
        agentStatuses,
      });
      return { status: 'applied' };
    }

    case 'task.created': {
      const task = normalizeTask(payload.task ?? payload, validAgentIndices);
      if (!task) return { status: 'rejected', reason: 'invalid_task' };
      if (task.id && core.tasks.some((t) => t.id === task.id)) {
        return { status: 'ignored', reason: 'duplicate_task' };
      }
      core.addTask(task);
      return { status: 'applied' };
    }

    case 'task.status_changed': {
      const status = asStatus(payload.status);
      if (!taskId || !status) return { status: 'rejected', reason: 'invalid_status_event' };
      const task = core.tasks.find((t) => t.id === taskId);
      if (!task) return { status: 'ignored', reason: 'unknown_task' };
      // Local anti-regression guard is bypassed on purpose: an external board may reopen
      // (re-dispatch) a finished task, and the local guard would make the board look dead.
      if (task.status === 'done' && (status === 'in_progress' || status === 'on_hold')) {
        core.reopenTask(taskId, status);
      } else {
        core.updateTaskStatus(taskId, status, { force: true });
      }
      return { status: 'applied' };
    }

    case 'task.output_ready': {
      if (!taskId) return { status: 'rejected', reason: 'missing_task_id' };
      if (!core.tasks.some((t) => t.id === taskId)) return { status: 'ignored', reason: 'unknown_task' };
      core.setTaskOutput(taskId, typeof payload.output === 'string' ? payload.output : '');
      return { status: 'applied' };
    }

    case 'task.review_requested': {
      if (!taskId) return { status: 'rejected', reason: 'missing_task_id' };
      if (!core.tasks.some((t) => t.id === taskId)) return { status: 'ignored', reason: 'unknown_task' };
      core.submitTaskForReview(taskId, typeof payload.draft === 'string' ? payload.draft : undefined);
      return { status: 'applied' };
    }

    case 'task.approved': {
      if (!taskId) return { status: 'rejected', reason: 'missing_task_id' };
      if (!core.tasks.some((t) => t.id === taskId)) return { status: 'ignored', reason: 'unknown_task' };
      core.approveTask(taskId);
      return { status: 'applied' };
    }

    case 'task.rejected': {
      if (!taskId) return { status: 'rejected', reason: 'missing_task_id' };
      if (!core.tasks.some((t) => t.id === taskId)) return { status: 'ignored', reason: 'unknown_task' };
      // In remote mode the server owns agent history; `agent.message` events carry the
      // rejection text. Writing it here too would duplicate the conversation (§7.4).
      core.rejectTask(taskId, typeof payload.comments === 'string' ? payload.comments : '', { writeHistory: false });
      return { status: 'applied' };
    }

    // ── Agents ───────────────────────────────────────────────────
    case 'agent.status_changed': {
      const status = asAgentState(payload.status);
      if (!isKnownAgent(agentIndex) || !status) return { status: 'rejected', reason: 'unknown_agent' };
      ui.setAgentStatus(agentIndex, status);
      return { status: 'applied' };
    }

    case 'agent.message': {
      const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
      if (!isKnownAgent(agentIndex) || !role) return { status: 'rejected', reason: 'unknown_agent' };
      const content = typeof payload.content === 'string' ? payload.content : '';
      core.appendAgentHistory(agentIndex, role, [content]);
      return { status: 'applied' };
    }

    case 'agent.replace_history': {
      if (!isKnownAgent(agentIndex)) return { status: 'rejected', reason: 'unknown_agent' };
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      core.setAgentHistory(agentIndex, messages);
      return { status: 'applied' };
    }

    // ── Log / usage ──────────────────────────────────────────────
    case 'action_log.appended': {
      const action = asNonEmptyString(payload.action);
      if (action === null) return { status: 'rejected', reason: 'missing_action' };
      core.addLogEntry({
        agentIndex: isKnownAgent(agentIndex) ? agentIndex : -1,
        action,
        taskId: taskId ?? undefined,
      });
      return { status: 'applied' };
    }

    case 'llm.usage': {
      if (!isKnownAgent(agentIndex)) return { status: 'rejected', reason: 'unknown_agent' };
      const promptTokens = Number(payload.promptTokens) || 0;
      const completionTokens = Number(payload.completionTokens) || 0;
      core.addResponseLog({
        agentIndex,
        agentName: typeof payload.agentName === 'string' ? payload.agentName : `Agent ${agentIndex}`,
        content: typeof payload.content === 'string' ? payload.content : '',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: Number(payload.totalTokens) || promptTokens + completionTokens,
        },
        raw: { model: payload.model },
        taskId: taskId ?? undefined,
      });
      return { status: 'applied' };
    }

    default:
      return { status: 'ignored', reason: 'unknown_type' };
  }
}

function normalizeTask(
  raw: unknown,
  validAgentIndices: number[],
): (RemoteTaskInput & { title: string; description: string; assignedAgentId: number; status: RemoteTaskStatus; requiresUserApproval: boolean }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const task = raw as Record<string, any>;

  const assignedAgentId = typeof task.assignedAgentId === 'number' ? task.assignedAgentId : task.agentIndex;
  // Agent identity is an integer index bound to the active team; events for agents
  // outside it are dropped rather than written into the store (§7.6).
  if (typeof assignedAgentId !== 'number' || !validAgentIndices.includes(assignedAgentId)) return null;

  const status = asStatus(task.status) ?? 'scheduled';
  const title = asNonEmptyString(task.title) ?? asNonEmptyString(task.id) ?? 'Untitled task';
  const description = typeof task.description === 'string' ? task.description : '';

  return {
    id: asNonEmptyString(task.id) ?? undefined,
    title,
    description,
    assignedAgentId,
    status,
    parentTaskId: asNonEmptyString(task.parentTaskId) ?? undefined,
    requiresUserApproval: Boolean(task.requiresUserApproval),
    draftOutput: typeof task.draftOutput === 'string' ? task.draftOutput : undefined,
    reviewComments: typeof task.reviewComments === 'string' ? task.reviewComments : undefined,
    output: typeof task.output === 'string' ? task.output : undefined,
    revisions: Array.isArray(task.revisions) ? task.revisions : [],
    createdAt: typeof task.createdAt === 'number' ? task.createdAt : undefined,
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : undefined,
  };
}

function normalizeAgentStatuses(
  raw: unknown,
  validAgentIndices: number[],
): Record<number, AgentState> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: Record<number, AgentState> = {};
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    const index = parseInt(key, 10);
    const status = asAgentState(value);
    if (Number.isFinite(index) && status && validAgentIndices.includes(index)) {
      result[index] = status;
    }
  });
  return result;
}
