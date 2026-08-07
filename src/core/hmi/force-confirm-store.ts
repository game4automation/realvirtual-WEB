// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * force-confirm-store — one-time-per-session gate for signal forcing.
 *
 * Forcing overrides live signal values and holds them against PLC/interface
 * updates, so the very first force in a session raises an "are you sure?"
 * confirmation. Once confirmed it stays allowed until the page reloads (the
 * flag is in-memory only — a reload clears it).
 *
 * Usage:
 *   if (await requestForceConfirm()) { ...do the force... }
 *
 * The confirmation UI is rendered once globally by `ForceConfirmDialog`
 * (mounted in HMIShell), which calls `resolveForceConfirm()`.
 */

let confirmed = false;
let open = false;
let resolver: ((ok: boolean) => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

/** True once the user has confirmed forcing for this session. */
export function isForceConfirmed(): boolean {
  return confirmed;
}

/**
 * Ask permission to force. Resolves true if forcing is allowed (already
 * confirmed this session, or the user confirms now), false if cancelled.
 */
export function requestForceConfirm(): Promise<boolean> {
  if (confirmed) return Promise.resolve(true);
  // If a prompt is already open, chain onto the same decision.
  if (open && resolver) {
    const prev = resolver;
    return new Promise<boolean>((res) => {
      resolver = (ok) => { prev(ok); res(ok); };
    });
  }
  open = true;
  notify();
  return new Promise<boolean>((res) => { resolver = res; });
}

/** Resolve the open confirmation (called by the dialog). */
export function resolveForceConfirm(ok: boolean): void {
  if (ok) confirmed = true;
  open = false;
  const r = resolver;
  resolver = null;
  notify();
  r?.(ok);
}

/** Subscribe to open-state changes (for the dialog). Returns an unsubscribe fn. */
export function subscribeForceConfirm(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Whether the confirmation dialog is currently open. */
export function getForceConfirmOpen(): boolean {
  return open;
}

/** Reset the gate (testing only). */
export function resetForceConfirm(): void {
  confirmed = false;
  open = false;
  resolver = null;
}
