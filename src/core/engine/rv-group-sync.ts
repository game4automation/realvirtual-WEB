// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-group-sync.ts — Keep the live GroupRegistry in sync with edited extras.
 *
 * The GroupRegistry is built once at scene load (buildGroups in
 * rv-scene-loader.ts). When the asset editor adds/removes/renames Group
 * components — or trashes/restores grouped subtrees — the registry must follow
 * so the Groups overlay reflects edits immediately. The asset-editor executor
 * (rv-asset-executors.ts) calls into this module after every Group-touching op,
 * on BOTH op directions, so undo/redo and draft replay stay consistent.
 *
 * Name resolution mirrors buildGroups: `_enabled === false` and missing
 * GroupName are skipped; GroupNamePrefix is a node path whose node NAME is
 * prepended to GroupName.
 */

import type { Object3D } from 'three';
import { GroupRegistry } from './rv-group-registry';

/** Matches Group component keys in userData.realvirtual: Group, Group_1, … */
export const GROUP_KEY_RE = /^Group(_\d+)?$/;

/** Minimal viewer surface needed for group syncing (test-friendly). */
export interface GroupSyncHost {
  groups: GroupRegistry | null;
  registry: { getNode(path: string): Object3D | null } | null;
}

/** All Group component keys present on an rv extras object. */
export function getGroupComponentKeys(rv: Record<string, unknown> | undefined): string[] {
  if (!rv) return [];
  return Object.keys(rv).filter(k => GROUP_KEY_RE.test(k));
}

/**
 * Resolve the effective group name of one Group component's data.
 * Returns null when the component is disabled or has no GroupName.
 * Mirrors buildGroups() in rv-scene-loader.ts.
 */
export function resolveGroupName(
  data: Record<string, unknown>,
  registry: GroupSyncHost['registry'],
): string | null {
  if (data['_enabled'] === false) return null;
  const groupName = data['GroupName'];
  if (typeof groupName !== 'string' || groupName.length === 0) return null;
  const prefix = data['GroupNamePrefix'];
  if (typeof prefix === 'string' && prefix.length > 0) {
    const prefixNode = registry?.getNode(prefix) ?? null;
    if (prefixNode) return prefixNode.name + groupName;
  }
  return groupName;
}

/**
 * Diff the node's desired group memberships (from its userData.realvirtual
 * Group* components) against the registry and apply additions/removals.
 * Lazily creates `host.groups` when the scene had no groups yet.
 * Returns true when anything changed.
 */
export function syncNodeGroups(host: GroupSyncHost, node: Object3D): boolean {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;

  const desired = new Set<string>();
  for (const key of getGroupComponentKeys(rv)) {
    const data = rv?.[key];
    if (!data || typeof data !== 'object') continue;
    const name = resolveGroupName(data as Record<string, unknown>, host.registry);
    if (name) desired.add(name);
  }

  const current = host.groups?.getGroupNamesForNode(node) ?? [];
  let changed = false;

  for (const name of current) {
    if (!desired.has(name)) {
      changed = host.groups!.unregister(name, node) || changed;
    }
  }

  if (desired.size > 0 && !host.groups) {
    host.groups = new GroupRegistry();
  }
  for (const name of desired) {
    if (!current.includes(name)) {
      host.groups!.register(name, node);
      changed = true;
    }
  }

  return changed;
}

/**
 * Sync group memberships for a whole subtree.
 * - 'detach': unregister every node from all groups (subtree was trashed).
 * - 'attach': re-derive memberships from extras (subtree was restored).
 * Returns true when anything changed.
 */
export function syncSubtreeGroups(
  host: GroupSyncHost,
  root: Object3D,
  mode: 'attach' | 'detach',
): boolean {
  let changed = false;
  root.traverse((node) => {
    if (mode === 'detach') {
      const names = host.groups?.getGroupNamesForNode(node) ?? [];
      for (const name of names) {
        changed = host.groups!.unregister(name, node) || changed;
      }
    } else {
      changed = syncNodeGroups(host, node) || changed;
    }
  });
  return changed;
}
