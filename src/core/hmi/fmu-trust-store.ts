// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fmu-trust-store — the open trust questions of the FMU consent dialog
 * (plan-498 Phase 3).
 *
 * The provisioning plugin runs outside React; it asks here and awaits a
 * promise. `FmuTrustDialog` (mounted once in the `overlay` slot) renders every
 * open question in ONE modal list — several FMUs that need consent at the same
 * moment are decided together, each with its own checkbox. Questions are keyed
 * by package SHA: two instances of the same package ask once and share the
 * answer. There is deliberately no "always trust" state here — a decision
 * answers exactly the questions that are open.
 */

/** Where one instance of the package lives (shown as "Quelle" in the dialog). */
export interface FmuTrustSource {
  /** Node path in the scene (placement paths included). */
  nodePath: string;
  /** `RVFmu.instanceKey` — the document part names the document. */
  instanceKey: string;
}

/** One open question: may this package run in CONNECT? */
export interface FmuTrustRequest {
  sha256: string;
  modelName: string;
  guid: string;
  generationTool: string;
  fileName: string;
  byteLength: number;
  sources: FmuTrustSource[];
}

interface Pending {
  request: FmuTrustRequest;
  waiters: Array<(approved: boolean) => void>;
}

const _pending = new Map<string, Pending>();
const _listeners = new Set<() => void>();
let _snapshot: readonly FmuTrustRequest[] = [];

function emit(): void {
  _snapshot = [..._pending.values()].map((p) => p.request);
  for (const l of _listeners) {
    try { l(); } catch (e) { console.warn('[fmu-trust] listener failed:', e); }
  }
}

/**
 * Ask whether `request.sha256` may run. Resolves true when the person approved
 * this package in the dialog, false when it was left unchecked or the dialog
 * was cancelled. A question for a SHA that is already open joins it (its
 * sources are merged); an `AbortSignal` withdraws only this caller's source.
 */
export function requestFmuTrust(request: FmuTrustRequest, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    let entry = _pending.get(request.sha256);
    if (!entry) {
      entry = { request: { ...request, sources: [...request.sources] }, waiters: [] };
      _pending.set(request.sha256, entry);
    } else {
      for (const s of request.sources) {
        if (!entry.request.sources.some((x) => x.instanceKey === s.instanceKey)) {
          entry.request = { ...entry.request, sources: [...entry.request.sources, s] };
        }
      }
    }
    const pending = entry;
    const waiter = (approved: boolean): void => resolve(approved);
    pending.waiters.push(waiter);
    signal?.addEventListener('abort', () => {
      const i = pending.waiters.indexOf(waiter);
      if (i < 0) return;
      pending.waiters.splice(i, 1);
      const keys = new Set(request.sources.map((s) => s.instanceKey));
      pending.request = { ...pending.request, sources: pending.request.sources.filter((s) => !keys.has(s.instanceKey)) };
      if (pending.waiters.length === 0) _pending.delete(request.sha256);
      resolve(false);
      emit();
    }, { once: true });
    emit();
  });
}

/**
 * The person's answer to every open question: packages in `approved` resolve
 * true, all others false. "Abbrechen" is `decideFmuTrust(new Set())`.
 */
export function decideFmuTrust(approved: ReadonlySet<string>): void {
  const entries = [..._pending.values()];
  _pending.clear();
  emit();
  for (const e of entries) {
    const ok = approved.has(e.request.sha256);
    for (const w of e.waiters) w(ok);
  }
}

/** Open questions (stable between changes — `useSyncExternalStore` snapshot). */
export function getFmuTrustRequests(): readonly FmuTrustRequest[] {
  return _snapshot;
}

/** Subscribe to open-question changes. Returns the unsubscribe. */
export function subscribeFmuTrust(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Test seam: drop every open question (their promises resolve false). */
export function resetFmuTrustForTests(): void {
  decideFmuTrust(new Set());
}
