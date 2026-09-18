import { KanbanEventEnvelope } from './types';

export type WsConnectionState = 'connecting' | 'online' | 'offline';

export interface KanbanWsClientOptions {
  url: string;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  /** Called for every non-keepalive message (parsed JSON object). */
  onEvent: (event: KanbanEventEnvelope) => void;
  onStateChange: (state: WsConnectionState) => void;
  /** Called after a re-connect (the first connect does not trigger it) → resync trigger. */
  onReconnected?: () => void;
  onError?: (message: string) => void;
}

const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Minimal, dependency-free WebSocket client for the external kanban bridge.
 *
 * - exponential backoff with jitter on failure/disconnect,
 * - ping/pong keepalive (a silent socket is closed so the backoff kicks in),
 * - outbound commands with a `commandId` for correlation.
 *
 * It knows nothing about the stores: `KanbanTransport` owns the mapping.
 */
export class KanbanWsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private disposed = false;
  private hasConnectedOnce = false;
  private lastPongAt = 0;
  private state: WsConnectionState = 'offline';

  constructor(private readonly options: KanbanWsClientOptions) {}

  public get connectionState(): WsConnectionState {
    return this.state;
  }

  public get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public connect(): void {
    if (this.disposed) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.options.onError?.(`invalid WebSocket URL: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (this.disposed) {
        socket.close();
        return;
      }
      this.attempt = 0;
      this.lastPongAt = Date.now();
      this.setState('online');
      this.startHeartbeat();

      if (this.hasConnectedOnce) this.options.onReconnected?.();
      this.hasConnectedOnce = true;
    };

    socket.onmessage = (message: MessageEvent) => {
      let parsed: any;
      try {
        parsed = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
      } catch {
        this.options.onError?.('received non-JSON payload');
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;

      // Keepalive frames are handled here; everything else goes to the transport.
      if (parsed.type === 'pong') {
        this.lastPongAt = Date.now();
        return;
      }
      if (parsed.type === 'ping') {
        this.sendRaw({ type: 'pong', ts: Date.now() });
        return;
      }

      this.options.onEvent(parsed as KanbanEventEnvelope);
    };

    socket.onerror = () => {
      this.options.onError?.('websocket error');
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      if (this.socket === socket) this.socket = null;
      if (this.disposed) return;
      this.setState('offline');
      this.scheduleReconnect();
    };
  }

  /** Sends a command (or request) upstream. Returns false when the socket is not usable. */
  public sendCommand(type: string, payload: Record<string, any> = {}): boolean {
    return this.sendRaw({
      v: 1,
      id: uid(),
      type,
      ts: Date.now(),
      payload,
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    this.setState('offline');
  }

  private sendRaw(payload: Record<string, any>): boolean {
    if (!this.isOpen) return false;
    try {
      this.socket!.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.options.onError?.(`send failed: ${String(error)}`);
      return false;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isOpen) return;
      if (Date.now() - this.lastPongAt > this.options.heartbeatTimeoutMs) {
        // Dead socket: close it so `onclose` schedules a reconnect.
        this.options.onError?.('heartbeat timeout');
        try {
          this.socket?.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.sendRaw({ type: 'ping', ts: Date.now() });
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const { reconnectMinDelayMs, reconnectMaxDelayMs } = this.options;
    const exponential = Math.min(reconnectMinDelayMs * 2 ** this.attempt, reconnectMaxDelayMs);
    // Jitter avoids a thundering herd when several clients reconnect together.
    const delay = exponential / 2 + Math.random() * (exponential / 2);
    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: WsConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state);
  }
}
