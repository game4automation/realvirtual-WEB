// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-owner — "which project does the *cached* scene body belong to?"
 *
 * ## Why this exists (plan-373)
 *
 * `createProjectFromScenes()` deliberately writes the same `sceneId` into more
 * than one project manifest — *"the scenes exist in both worlds"*. The cache
 * keyspace cannot express that: there is exactly one body key
 * `rv-scenes/<id>`, one index entry, and no origin field anywhere.
 *
 * The consequence was a silent data-loss path: opening project **B** while the
 * cache still held project **A**'s body made `ProjectStore.hydrateScene()`
 * short-circuit on `readScene(id)`, so B's own file was never read — and the
 * next save wrote A's body onto B's `.scene.json`.
 *
 * ## Shape
 *
 * ```
 * rv-scene-owner/<sceneId>  ->  { projectIds: string[], cachedFrom: string | null }
 * ```
 *
 *  - `projectIds` is **1:n** on purpose. Several legitimate owners are the
 *    normal case, not an anomaly, and a 1:1 marker would be order-dependent
 *    (opening A then B answers differently from B then A).
 *  - `cachedFrom` is the project the body **currently in the cache** came
 *    from. This is the field that closes the bug.
 *
 * ## Additive by construction
 *
 * This is a new key next to the existing ones. Nothing under `rv-scenes/…` is
 * renamed, rewritten or deleted by this module, and a missing record means
 * `cachedFrom === null` — "origin unknown", which every caller must treat as
 * the pre-fix behaviour. No backfill, no migration, fully roll-back-able.
 */

// ─── Storage key ────────────────────────────────────────────────────────

/**
 * Deliberately NOT under the `rv-scenes/` prefix: `clearAllScenes()` and the
 * draft enumerators walk that namespace, and an ownership record is metadata
 * about the cache rather than a part of it.
 */
export const LS_KEY_SCENE_OWNER_PREFIX = 'rv-scene-owner/';

function ownerKey(sceneId: string): string {
  return LS_KEY_SCENE_OWNER_PREFIX + sceneId;
}

// ─── Record ─────────────────────────────────────────────────────────────

export interface SceneOwnerRecord {
  /** Every project known to carry this scene id in its manifest. 1:n. */
  projectIds: string[];
  /** Project the body in `rv-scenes/<id>` came from. Null = unknown. */
  cachedFrom: string | null;
}

/** Read the record for one scene. Never throws; unknown reads as null. */
export function readSceneOwner(sceneId: string): SceneOwnerRecord | null {
  if (!sceneId) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(ownerKey(sceneId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SceneOwnerRecord> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const projectIds = Array.isArray(parsed.projectIds)
      ? parsed.projectIds.filter((p): p is string => typeof p === 'string' && p !== '')
      : [];
    const cachedFrom =
      typeof parsed.cachedFrom === 'string' && parsed.cachedFrom !== ''
        ? parsed.cachedFrom
        : null;
    return { projectIds, cachedFrom };
  } catch {
    return null;
  }
}

/**
 * Write the record verbatim. Quota failures are swallowed: an ownership
 * marker is a safety net, never a precondition for opening a scene.
 */
export function writeSceneOwner(sceneId: string, record: SceneOwnerRecord): void {
  if (!sceneId) return;
  const clean: SceneOwnerRecord = {
    projectIds: [...new Set(record.projectIds.filter(p => typeof p === 'string' && p !== ''))],
    cachedFrom: record.cachedFrom || null,
  };
  try {
    localStorage.setItem(ownerKey(sceneId), JSON.stringify(clean));
  } catch {
    /* quota / private mode */
  }
}

// ─── Maintenance ────────────────────────────────────────────────────────

/**
 * Record that `projectId` carries this scene, leaving `cachedFrom` alone.
 *
 * Used when a project is opened: its manifest proves membership but says
 * nothing about whose body sits in the cache. Writes only when something
 * actually changes, so re-opening a 50-scene project costs zero writes.
 */
export function noteSceneMembership(sceneId: string, projectId: string): void {
  if (!sceneId || !projectId) return;
  const current = readSceneOwner(sceneId);
  if (current?.projectIds.includes(projectId)) return;
  writeSceneOwner(sceneId, {
    projectIds: [...(current?.projectIds ?? []), projectId],
    cachedFrom: current?.cachedFrom ?? null,
  });
}

/**
 * Record that the cached body now comes from `projectId` — which also proves
 * membership. Called wherever a body enters the cache on a project's behalf:
 * hydration, an applied conflict resolution, and project creation.
 */
export function setCachedFrom(sceneId: string, projectId: string): void {
  if (!sceneId || !projectId) return;
  const current = readSceneOwner(sceneId);
  if (current?.cachedFrom === projectId && current.projectIds.includes(projectId)) return;
  writeSceneOwner(sceneId, {
    projectIds: [...(current?.projectIds ?? []), projectId],
    cachedFrom: projectId,
  });
}

// ─── Queries ────────────────────────────────────────────────────────────

/** Project the cached body came from, or null when the origin is unknown. */
export function cachedFromProject(sceneId: string): string | null {
  return readSceneOwner(sceneId)?.cachedFrom ?? null;
}

/**
 * True only when the cache is **known** to hold a different project's body.
 *
 * An unknown origin is never foreign. That asymmetry is the whole point of
 * the fix being additive: pre-existing caches keep behaving exactly as they
 * did, and only a body whose provenance was actually recorded can trigger the
 * stricter path.
 */
export function isCacheFromOtherProject(
  sceneId: string,
  activeProjectId: string | null | undefined,
): boolean {
  if (!activeProjectId) return false;
  const from = cachedFromProject(sceneId);
  return from !== null && from !== activeProjectId;
}

// ─── Housekeeping (tests / cleanup tools) ───────────────────────────────

/** Drop the record for one scene. */
export function clearSceneOwner(sceneId: string): void {
  if (!sceneId) return;
  try {
    localStorage.removeItem(ownerKey(sceneId));
  } catch {
    /* ignore */
  }
}

/** Every scene id that currently has an ownership record. */
export function listSceneOwnerIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_KEY_SCENE_OWNER_PREFIX)) {
      out.push(k.slice(LS_KEY_SCENE_OWNER_PREFIX.length));
    }
  }
  return out;
}

/** Drop every ownership record. Test/cleanup utility. */
export function clearAllSceneOwners(): void {
  for (const id of listSceneOwnerIds()) clearSceneOwner(id);
}
