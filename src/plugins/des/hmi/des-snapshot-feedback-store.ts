// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export interface SnapshotFeedback { text: string; severity: 'success' | 'warning'; }
let current: SnapshotFeedback | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
export function clear(): void {
  clearTimeout(timer);
  timer = undefined;
  current = null;
  for (const listener of listeners) listener();
}
export function post(text: string, severity: SnapshotFeedback['severity']): void {
  clearTimeout(timer);
  current = { text, severity };
  timer = setTimeout(clear, 8000);
  for (const listener of listeners) listener();
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getSnapshot(): SnapshotFeedback | null { return current; }
