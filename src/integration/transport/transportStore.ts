import { create } from 'zustand';
import { useUiStore } from '../store/uiStore';
import { resolveTransportConfig } from './config';
import { ConnectionState, MapResult, TransportConfig, TransportMode } from './types';

/**
 * Transport store — runtime flag for how the board is driven.
 *
 * It intentionally lives outside `coreStore` so it is not wiped by `resetProject()`
 * (which fires whenever the active team changes). `connectionState` is mirrored into
 * `uiStore` for the header badge.
 */
export const transportConfig: TransportConfig = resolveTransportConfig();

interface TransportState {
  mode: TransportMode;
  url: string | null;
  connectionState: ConnectionState;
  lastEventAt: number | null;
  lastSeq: number | null;
  receivedEvents: number;
  appliedEvents: number;
  ignoredEvents: number;
  rejectedEvents: number;
  snapshotRequests: number;
  /** `snapshot` answers that were applied as a `board.snapshot` (the counterpart of a request). */
  snapshotReplies: number;
  /** Resyncs whose reply never arrived after `snapshotMaxAttempts` (peer does not answer). */
  snapshotUnanswered: number;
  /** Negative acknowledgements sent for dropped bridge events (unmapped assignee, …). */
  nackedEvents: number;
  lastError: string | null;
  setConnectionState: (state: ConnectionState) => void;
  recordEvent: (result: MapResult, seq?: number) => void;
  noteSnapshotRequest: () => void;
  noteSnapshotReply: () => void;
  noteSnapshotUnanswered: () => void;
  noteNack: () => void;
  setLastError: (message: string | null) => void;
  resetCounters: () => void;
}

export const useTransportStore = create<TransportState>()((set) => ({
  mode: transportConfig.mode,
  url: transportConfig.url,
  connectionState: transportConfig.mode === 'remote' ? 'connecting' : 'disabled',
  lastEventAt: null,
  lastSeq: null,
  receivedEvents: 0,
  appliedEvents: 0,
  ignoredEvents: 0,
  rejectedEvents: 0,
  snapshotRequests: 0,
  snapshotReplies: 0,
  snapshotUnanswered: 0,
  nackedEvents: 0,
  lastError: null,

  setConnectionState: (connectionState) => {
    // Single writer for both the transport store and the UI badge.
    useUiStore.getState().setConnectionState(connectionState);
    set({ connectionState });
  },

  recordEvent: (result, seq) =>
    set((s) => ({
      receivedEvents: s.receivedEvents + 1,
      appliedEvents: s.appliedEvents + (result.status === 'applied' ? 1 : 0),
      ignoredEvents: s.ignoredEvents + (result.status === 'ignored' ? 1 : 0),
      rejectedEvents: s.rejectedEvents + (result.status === 'rejected' ? 1 : 0),
      lastEventAt: Date.now(),
      lastSeq: typeof seq === 'number' ? seq : s.lastSeq,
    })),

  noteSnapshotRequest: () => set((s) => ({ snapshotRequests: s.snapshotRequests + 1 })),
  noteSnapshotReply: () => set((s) => ({ snapshotReplies: s.snapshotReplies + 1 })),
  noteSnapshotUnanswered: () => set((s) => ({ snapshotUnanswered: s.snapshotUnanswered + 1 })),
  noteNack: () => set((s) => ({ nackedEvents: s.nackedEvents + 1 })),
  setLastError: (lastError) => set({ lastError }),
  resetCounters: () =>
    set({ receivedEvents: 0, appliedEvents: 0, ignoredEvents: 0, rejectedEvents: 0 }),
}));

/** Runtime mode: `remote` means the external board owns the state, Gemini loop is disarmed. */
export const getTransportMode = (): TransportMode => useTransportStore.getState().mode;

/** True when the app should not run its own agent loop / LLM calls. */
export const isRemoteMode = (): boolean => getTransportMode() === 'remote';
