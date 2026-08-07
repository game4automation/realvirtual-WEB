// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Page-wide lifecycle coordinator for every <rv-embed> instance in rv-embed.js.
 *
 * The manager serializes GLB loads, grants simulation ownership to exactly one
 * vignette, recycles offscreen WebGL contexts and applies scroll performance
 * hysteresis. Registration is tied to each element's existing AbortSignal.
 */

export const RV_EMBED_CONTEXT_RECYCLE_MS = 10_000;
export const RV_EMBED_SCROLL_IDLE_MS = 180;

export interface RVEmbedManagedVignette {
  setManagedSimulationActive(active: boolean, resetRegistries: boolean): void;
  setManagedScrollMode(active: boolean): void;
  suspendManagedContext(): boolean;
  resumeManagedContext(): boolean;
  isManagedContextSuspended(): boolean;
}

interface RVEmbedManagerRecord {
  readonly host: RVEmbedManagedVignette;
  readonly signal: AbortSignal;
  visible: boolean;
  visibilityOrder: number;
  offscreenSince: number | null;
  suspendTimer: ReturnType<typeof setTimeout> | null;
  contextSuspended: boolean;
}

export interface RVEmbedManagerState {
  readonly registeredCount: number;
  readonly visibleCount: number;
  readonly hasActiveSimulation: boolean;
  readonly scrolling: boolean;
  readonly queuedLoads: number;
  readonly activeLoads: number;
}

export class RVEmbedManager {
  private readonly records = new Map<RVEmbedManagedVignette, RVEmbedManagerRecord>();
  private activeHost: RVEmbedManagedVignette | null = null;
  private visibilitySequence = 0;
  private loadTail: Promise<void> = Promise.resolve();
  private queuedLoads = 0;
  private activeLoads = 0;
  private scrolling = false;
  private scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollListenerAttached = false;

  register(host: RVEmbedManagedVignette, signal: AbortSignal): void {
    if (this.records.has(host) || signal.aborted) return;
    const record: RVEmbedManagerRecord = {
      host,
      signal,
      visible: false,
      visibilityOrder: 0,
      offscreenSince: performance.now(),
      suspendTimer: null,
      contextSuspended: false,
    };
    this.records.set(host, record);
    signal.addEventListener('abort', () => this.unregister(host), { once: true });
    this.attachScrollListener();
    host.setManagedSimulationActive(false, false);
    host.setManagedScrollMode(this.scrolling);
    this.scheduleContextSuspend(record);
  }

  setVisible(host: RVEmbedManagedVignette, visible: boolean): void {
    const record = this.records.get(host);
    if (!record) return;
    if (record.visible === visible) {
      if (!visible && record.offscreenSince === null) {
        record.offscreenSince = performance.now();
        this.scheduleContextSuspend(record);
      }
      return;
    }

    record.visible = visible;
    if (visible) {
      record.visibilityOrder = ++this.visibilitySequence;
      record.offscreenSince = null;
      this.clearSuspendTimer(record);
      this.resumeContext(record);
      this.setActiveHost(host);
      return;
    }

    record.offscreenSince = performance.now();
    this.scheduleContextSuspend(record);
    if (this.activeHost === host) {
      this.setActiveHost(this.mostRecentlyVisibleHost());
    }
  }

  requestSimulation(host: RVEmbedManagedVignette): void {
    if (!this.records.has(host)) return;
    this.setActiveHost(host);
  }

  sync(host: RVEmbedManagedVignette): void {
    const record = this.records.get(host);
    if (!record) return;
    record.contextSuspended = host.isManagedContextSuspended();
    host.setManagedSimulationActive(this.activeHost === host, false);
    host.setManagedScrollMode(this.scrolling);
    if (record.visible) {
      this.resumeContext(record);
      return;
    }

    const elapsed = record.offscreenSince === null
      ? 0
      : performance.now() - record.offscreenSince;
    if (elapsed >= RV_EMBED_CONTEXT_RECYCLE_MS) {
      record.contextSuspended = host.suspendManagedContext();
    } else {
      this.scheduleContextSuspend(record);
    }
  }

  enqueueLoad<T>(
    host: RVEmbedManagedVignette,
    task: () => Promise<T>,
  ): Promise<T> {
    this.queuedLoads++;
    const run = async (): Promise<T> => {
      this.queuedLoads--;
      const record = this.records.get(host);
      if (!record || record.signal.aborted) {
        throw new DOMException('RVEmbed load aborted', 'AbortError');
      }
      this.activeLoads++;
      try {
        return await task();
      } finally {
        this.activeLoads--;
      }
    };
    const result = this.loadTail.then(run, run);
    this.loadTail = result.then(() => undefined, () => undefined);
    return result;
  }

  get state(): RVEmbedManagerState {
    let visibleCount = 0;
    for (const record of this.records.values()) {
      if (record.visible) visibleCount++;
    }
    return {
      registeredCount: this.records.size,
      visibleCount,
      hasActiveSimulation: this.activeHost !== null,
      scrolling: this.scrolling,
      queuedLoads: this.queuedLoads,
      activeLoads: this.activeLoads,
    };
  }

  private unregister(host: RVEmbedManagedVignette): void {
    const record = this.records.get(host);
    if (!record) return;
    this.clearSuspendTimer(record);
    this.records.delete(host);

    if (this.activeHost === host) {
      this.activeHost = null;
      // The removed viewer shares this AbortSignal and disposes later in the
      // same abort dispatch. Hand ownership over only after that terminal
      // dispose/reset has completed, otherwise it could clear the successor's
      // freshly selected registry state again.
      queueMicrotask(() => {
        if (this.activeHost !== null) return;
        const next = this.mostRecentlyVisibleHost();
        if (!next) return;
        this.activeHost = next;
        next.setManagedSimulationActive(true, true);
      });
    }

    if (this.records.size === 0) this.detachScrollListener();
  }

  private setActiveHost(next: RVEmbedManagedVignette | null): void {
    const previous = this.activeHost;
    if (previous === next) {
      next?.setManagedSimulationActive(true, false);
      return;
    }

    previous?.setManagedSimulationActive(false, false);
    this.activeHost = next;
    next?.setManagedSimulationActive(true, previous !== null);
  }

  private mostRecentlyVisibleHost(): RVEmbedManagedVignette | null {
    let newest: RVEmbedManagerRecord | null = null;
    for (const record of this.records.values()) {
      if (!record.visible) continue;
      if (!newest || record.visibilityOrder > newest.visibilityOrder) newest = record;
    }
    return newest?.host ?? null;
  }

  private scheduleContextSuspend(record: RVEmbedManagerRecord): void {
    this.clearSuspendTimer(record);
    if (record.visible || record.signal.aborted || record.contextSuspended) return;
    const elapsed = record.offscreenSince === null
      ? 0
      : performance.now() - record.offscreenSince;
    const delay = Math.max(0, RV_EMBED_CONTEXT_RECYCLE_MS - elapsed);
    record.suspendTimer = setTimeout(() => {
      record.suspendTimer = null;
      if (record.visible || record.signal.aborted || !this.records.has(record.host)) return;
      record.contextSuspended = record.host.suspendManagedContext();
    }, delay);
  }

  private resumeContext(record: RVEmbedManagerRecord): void {
    record.contextSuspended = record.host.isManagedContextSuspended();
    if (!record.contextSuspended) return;
    if (record.host.resumeManagedContext()) record.contextSuspended = false;
  }

  private clearSuspendTimer(record: RVEmbedManagerRecord): void {
    if (record.suspendTimer === null) return;
    clearTimeout(record.suspendTimer);
    record.suspendTimer = null;
  }

  private attachScrollListener(): void {
    if (this.scrollListenerAttached || typeof window === 'undefined') return;
    window.addEventListener('scroll', this.handleScroll, { passive: true });
    this.scrollListenerAttached = true;
  }

  private detachScrollListener(): void {
    if (this.scrollListenerAttached && typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.handleScroll);
    }
    this.scrollListenerAttached = false;
    if (this.scrollIdleTimer !== null) {
      clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = null;
    }
    if (this.scrolling) {
      this.scrolling = false;
      for (const record of this.records.values()) record.host.setManagedScrollMode(false);
    }
  }

  private readonly handleScroll = (): void => {
    if (!this.scrolling) {
      this.scrolling = true;
      for (const record of this.records.values()) record.host.setManagedScrollMode(true);
    }
    if (this.scrollIdleTimer !== null) clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = setTimeout(() => {
      this.scrollIdleTimer = null;
      if (!this.scrolling) return;
      this.scrolling = false;
      for (const record of this.records.values()) record.host.setManagedScrollMode(false);
    }, RV_EMBED_SCROLL_IDLE_MS);
  };
}

export const rvEmbedManager = new RVEmbedManager();
