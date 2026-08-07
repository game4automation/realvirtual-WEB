// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-libraries — `project.json.libraries[]` read/write (plan-372 §2.6.3).
 *
 * The project level of the two-level library SSOT. Two rules govern this file,
 * both inherited from `rv-project-types`:
 *
 *  - **Defensive parse.** A malformed or future-shaped `libraries[]` yields an
 *    empty list, never a throw — the same posture `isValidSceneV2` takes.
 *  - **Field-level read-modify-write.** Rewriting the list must not drop
 *    unknown keys on an entry a newer client wrote. Entries are matched by
 *    `url` and merged, not replaced.
 */

import type { RvProject, RvProjectLibraryRef } from '../project/rv-project-types';

/**
 * The library URLs a project subscribes to, de-duplicated and in manifest order.
 *
 * Accepts both the object form (`{url, label}`) and a bare string, because a
 * hand-edited manifest is a first-class authoring path for a git project.
 */
export function readProjectLibraries(project: RvProject | null | undefined): string[] {
  const raw = project?.libraries;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const url = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' && typeof (item as RvProjectLibraryRef).url === 'string'
        ? (item as RvProjectLibraryRef).url
        : '');
    const trimmed = url.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Return a manifest whose `libraries[]` is exactly `urls`.
 *
 * Existing entries keep every field they had (label, and anything a newer
 * client added); removed URLs drop out; new ones are appended as `{url}`.
 * Passing an empty list removes the section rather than writing `[]`, so a
 * project that never had libraries stays byte-identical.
 */
export function withProjectLibraries(project: RvProject, urls: readonly string[]): RvProject {
  const wanted: string[] = [];
  for (const u of urls) {
    const trimmed = (u ?? '').trim();
    if (trimmed && !wanted.includes(trimmed)) wanted.push(trimmed);
  }

  const byUrl = new Map<string, RvProjectLibraryRef>();
  // `unknown` on purpose: a hand-edited manifest may hold bare strings, which
  // the declared type does not admit but the reader above accepts.
  for (const item of (project.libraries ?? []) as unknown[]) {
    if (typeof item === 'string') {
      byUrl.set(item.trim(), { url: item.trim() });
    } else if (item && typeof item === 'object'
      && typeof (item as RvProjectLibraryRef).url === 'string') {
      const ref = item as RvProjectLibraryRef;
      byUrl.set(ref.url.trim(), ref);
    }
  }

  if (wanted.length === 0) {
    if (project.libraries === undefined) return project;
    const { libraries: _dropped, ...rest } = project;
    return rest as RvProject;
  }

  return {
    ...project,
    libraries: wanted.map(url => byUrl.get(url) ?? { url }),
  };
}
