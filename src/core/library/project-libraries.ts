// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-libraries — `project.json.libraries[]` read/write (plan-372 §2.6.3,
 * plan-778).
 *
 * The project level of the two-level library SSOT. Three rules govern this file,
 * all inherited from `rv-project-types`:
 *
 *  - **Defensive parse.** A malformed or future-shaped `libraries[]` yields an
 *    empty list, never a throw — the posture every reader in this layer takes
 *    for a field it does not own.
 *  - **Field-level read-modify-write.** Rewriting the list must not drop
 *    unknown keys on an entry a newer client wrote. Entries are matched by
 *    their KEY and merged, not replaced.
 *  - **One key per entry: `projectId ?? url`** (plan-778). A library project is
 *    named by identity; a catalog URL keeps naming an external catalog. Before
 *    plan-778 the writer matched by `url` alone and silently dropped every
 *    entry that had none — which is exactly the shape a library project has.
 *    Every writer goes through {@link withLibraryRefs} so that cannot recur.
 */

import type { RvProject, RvProjectLibraryRef } from '../project/rv-project-types';

/** The key of a library entry: its project id, else its URL; '' for an unusable entry. */
export function libraryRefKey(ref: Pick<RvProjectLibraryRef, 'projectId' | 'url'> | null | undefined): string {
  const projectId = typeof ref?.projectId === 'string' ? ref.projectId.trim() : '';
  if (projectId) return projectId;
  const url = typeof ref?.url === 'string' ? ref.url.trim() : '';
  return url;
}

/** One entry of `libraries[]` as a typed ref, or null. Bare strings are URL refs. */
function refOf(item: unknown): RvProjectLibraryRef | null {
  if (typeof item === 'string') {
    const url = item.trim();
    return url ? { url } : null;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const raw = item as RvProjectLibraryRef;
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!projectId && !url) return null;
  // Every key the entry carries survives (unknown ones included); the two keys
  // are normalised to their trimmed form, an unusable one is left out.
  const out: RvProjectLibraryRef = { ...raw };
  if (projectId) out.projectId = projectId; else delete out.projectId;
  if (url) out.url = url; else delete out.url;
  return out;
}

/**
 * Every library entry of a project, typed, de-duplicated by key and in manifest
 * order (plan-778 F2). `{projectId}` and `{url}` entries alike, bare strings as
 * `{url}`; an entry with neither key is skipped.
 */
export function readLibraryRefs(project: RvProject | null | undefined): RvProjectLibraryRef[] {
  const raw = project?.libraries as unknown;
  if (!Array.isArray(raw)) return [];
  const out: RvProjectLibraryRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = refOf(item);
    if (!ref) continue;
    const key = libraryRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** The library PROJECT refs only (entries with a `projectId`), in manifest order. */
export function readLibraryProjectRefs(project: RvProject | null | undefined): RvProjectLibraryRef[] {
  return readLibraryRefs(project).filter((r) => typeof r.projectId === 'string' && r.projectId !== '');
}

/**
 * Return a manifest whose `libraries[]` is exactly `refs` (keyed by
 * `projectId ?? url`).
 *
 * An existing entry with the same key keeps every field it had — the given ref
 * is merged OVER it, so a caller that passes `{projectId}` does not erase the
 * stored `label`/`hint` or an unknown key a newer client wrote. Entries whose
 * key is not in `refs` drop out; new ones are appended as given. An empty list
 * removes the section rather than writing `[]`, so a project that never had
 * libraries stays byte-identical.
 */
export function withLibraryRefs(project: RvProject, refs: readonly RvProjectLibraryRef[]): RvProject {
  const existing = new Map<string, RvProjectLibraryRef>();
  for (const ref of readLibraryRefs(project)) existing.set(libraryRefKey(ref), ref);

  const next: RvProjectLibraryRef[] = [];
  const seen = new Set<string>();
  for (const given of refs) {
    const ref = refOf(given);
    if (!ref) continue;
    const key = libraryRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const before = existing.get(key);
    next.push(before ? { ...before, ...ref } : ref);
  }

  if (next.length === 0) {
    if (project.libraries === undefined) return project;
    const { libraries: _dropped, ...rest } = project;
    return rest as RvProject;
  }
  return { ...project, libraries: next };
}

/**
 * The library URLs a project subscribes to, de-duplicated and in manifest order.
 *
 * A URL-only VIEW of {@link readLibraryRefs} for the catalog half of the
 * library layer (`LibraryStore.applyProjectLibraries`, the dashboard's "is this
 * catalog attached" checks). `{projectId}` entries are not URLs and are not in it.
 */
export function readProjectLibraries(project: RvProject | null | undefined): string[] {
  const out: string[] = [];
  for (const ref of readLibraryRefs(project)) {
    if (ref.projectId || !ref.url) continue;
    if (!out.includes(ref.url)) out.push(ref.url);
  }
  return out;
}

/**
 * Return a manifest whose URL entries are exactly `urls` — every
 * `{projectId}` entry is KEPT in place (plan-778 F2).
 *
 * The URL-only writer of the catalog half, now a thin view over
 * {@link withLibraryRefs}: existing URL entries keep every field they had,
 * removed URLs drop out, new ones are appended as `{url}`. With no URLs left
 * and no project refs the section is removed.
 */
export function withProjectLibraries(project: RvProject, urls: readonly string[]): RvProject {
  const wanted: string[] = [];
  for (const u of urls) {
    const trimmed = (u ?? '').trim();
    if (trimmed && !wanted.includes(trimmed)) wanted.push(trimmed);
  }
  const refs = readLibraryRefs(project);
  const out: RvProjectLibraryRef[] = [];
  for (const ref of refs) {
    if (ref.projectId) { out.push(ref); continue; }
    if (ref.url && wanted.includes(ref.url)) out.push(ref);
  }
  for (const url of wanted) {
    if (!refs.some((r) => !r.projectId && r.url === url)) out.push({ url });
  }
  // Order: the URL entries follow `urls`, project refs keep their slots.
  const urlOrder = new Map(wanted.map((u, i) => [u, i] as const));
  const urlSlots = out.map((r, i) => (r.projectId ? -1 : i)).filter((i) => i >= 0);
  const urlRefs = urlSlots.map((i) => out[i]).sort((a, b) => (urlOrder.get(a.url ?? '') ?? 0) - (urlOrder.get(b.url ?? '') ?? 0));
  urlSlots.forEach((slot, k) => { out[slot] = urlRefs[k]; });
  return withLibraryRefs(project, out);
}

/** Signature of every ref (projectId + url + hint) — what `main.ts` re-syncs on (plan-778). */
export function libraryRefsSignature(project: RvProject | null | undefined): string {
  return JSON.stringify(readLibraryRefs(project).map((r) => [r.projectId ?? '', r.url ?? '', r.hint ?? '']));
}
