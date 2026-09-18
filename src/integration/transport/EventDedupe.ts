/**
 * Event id dedupe + `seq` gap detection for the external board stream.
 *
 * - Duplicate `id`s are dropped (at-least-once delivery is assumed).
 * - A `seq` gap marks the local view as incomplete → the transport asks for a
 *   fresh snapshot instead of silently diverging.
 */
export interface DedupeVerdict {
  /** Event id was already processed. */
  duplicate: boolean;
  /** `seq` jumped forward: one or more events were missed. */
  gap: boolean;
  /** `seq` was lower than the highest seen sequence (out-of-order arrival). */
  outOfOrder: boolean;
}

export class EventDedupe {
  private readonly seen = new Map<string, true>();
  private highestSeq: number | null = null;

  constructor(private readonly maxSize: number = 500) {}

  public check(event: { id?: string; seq?: number }): DedupeVerdict {
    const duplicate = typeof event.id === 'string' && event.id.length > 0 && this.seen.has(event.id);

    let gap = false;
    let outOfOrder = false;

    if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
      if (this.highestSeq === null) {
        this.highestSeq = event.seq;
      } else if (event.seq > this.highestSeq) {
        gap = event.seq > this.highestSeq + 1;
        this.highestSeq = event.seq;
      } else if (event.seq < this.highestSeq) {
        outOfOrder = true;
      }
    }

    if (duplicate) return { duplicate, gap, outOfOrder };

    if (typeof event.id === 'string' && event.id.length > 0) {
      this.seen.set(event.id, true);
      // Map preserves insertion order → evict the oldest entry first (LRU-ish bound).
      while (this.seen.size > this.maxSize) {
        const oldest = this.seen.keys().next();
        if (oldest.done) break;
        this.seen.delete(oldest.value);
      }
    }

    return { duplicate: false, gap, outOfOrder };
  }

  /** Called after a snapshot resync so a stale `seq` window does not re-trigger gaps. */
  public reset(): void {
    this.seen.clear();
    this.highestSeq = null;
  }

  public get lastSequence(): number | null {
    return this.highestSeq;
  }
}
