// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 1b — a path-only registry fake that speaks the stored-read API.
 *
 * Readers of stored references ask `registry.readStoredRef` / `storedNode` /
 * `storedComponent` first (the file's verdict). A fake built from a plain path map
 * has no documents and no identity records, so every stored read is `legacy`
 * (`no-document`) — exactly what the real `NodeRegistry` answers for a tree that
 * never went through a decode — and the reader's own path lookup (`getNode`) runs.
 */
import type { Object3D } from 'three';

type PathOf = (ref: unknown) => string;

const pathOf: PathOf = (ref) => {
  if (typeof ref === 'string') return ref;
  const p = (ref as { path?: unknown } | null | undefined)?.path;
  return typeof p === 'string' ? p : '';
};

/** `{ getNode }` plus the stored-read methods, all answering `legacy`. */
export function legacyRegistry<T extends object = Record<string, never>>(
  getNode: (path: string) => Object3D | null,
  extra?: T,
): T & {
  getNode(path: string): Object3D | null;
  readStoredRef(referrer: unknown, ref: unknown): { status: 'legacy'; path: string; reason: 'no-document' };
  storedNode(referrer: unknown, ref: unknown, opts?: { legacy?: (path: string) => Object3D | null }): Object3D | null;
} {
  return {
    ...(extra ?? ({} as T)),
    getNode,
    readStoredRef: (_referrer: unknown, ref: unknown) => ({ status: 'legacy' as const, path: pathOf(ref), reason: 'no-document' as const }),
    storedNode: (_referrer: unknown, ref: unknown, opts?: { legacy?: (path: string) => Object3D | null }) => {
      const p = pathOf(ref);
      if (!p) return null;
      return opts?.legacy ? opts.legacy(p) : getNode(p);
    },
  };
}
