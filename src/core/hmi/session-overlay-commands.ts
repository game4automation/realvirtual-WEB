// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandArgType, type CommandDescriptor, type CommandImpl, type CommandRegistry } from './rv-command-registry';
import type { RVViewer } from '../rv-viewer';
import type { Object3D } from 'three';
import { loadGroupVisibilitySettings, saveGroupVisibilitySettings } from './group-visibility-store';
import { toCollisionRole } from '../engine/rv-collision-role';
import type { TraceRange } from '../engine/rv-path-trace';
import type { PathTracePlugin } from '../../plugins/path-trace-plugin';
import { isOverlayVisible, setOverlayVisible } from '../overlay-visibility-store';
import { getTraceSettings, setTraceRange, setTraceWindowSec } from '../trace-settings-store';

interface WatchEntry { path: string; role: string }

// Session state belongs to the viewer, shared by commands and the retained status tool.
const watches = new WeakMap<RVViewer, Map<Object3D, string>>();
function watchedFor(viewer: RVViewer): Map<Object3D, string> {
  let watched = watches.get(viewer);
  if (!watched) { watched = new Map(); watches.set(viewer, watched); }
  return watched;
}

function parseRange(v: unknown): TraceRange | null {
  const s = String(v).trim().toLowerCase();
  return s === 'window' || s === 'start' ? s : null;
}

function readTraceState(viewer: RVViewer | undefined): Record<string, unknown> {
  const p = viewer?.getPlugin<PathTracePlugin>('path-trace');
  const s = getTraceSettings();
  return {
    blocked: isOverlayVisible('trace-blocked'),
    utilization: isOverlayVisible('trace-utilization'),
    range: s.range, windowSec: s.windowSec,
    simTime: p ? Math.round(p.trace.simTime * 10000) / 10000 : 0,
    kernel: p?.attachedTo ?? null,
  };
}

export const traceState: CommandImpl = {
  enabled: () => true,
  run: ({ viewer }) => readTraceState(viewer),
};

export const groupSetVisible: CommandImpl<{ name: string; visible: boolean }> = {
  enabled: ({ viewer }) => !viewer ? { reason: 'No viewer' } : !viewer.groups ? { reason: 'No group registry (no model loaded)' } : true,
  run: async ({ viewer }, { name, visible }) => {
    const v = viewer;
    if (!v) return { error: 'No viewer' };
    const groups = v.groups;
    if (!groups) return { error: 'No group registry (no model loaded)' };
    const info = groups.get(name);
    if (!info) return { error: `Unknown group "${name}"`, known: groups.getGroupNames() };
    groups.setVisible(name, visible);
    // Exactly what the panel's eye does (GroupsListContent.handleToggle): an
    // active auto-filter isolation is dropped, both isolates are cleared in
    // the store, hidden names are persisted, so the state survives the next
    // model load (editor ↔ HMI). The store write refreshes an open panel.
    if (v.autoFilters?.isIsolateActive) v.autoFilters.showAll();
    v.markShadowsDirty();
    v.markRenderDirty();
    const settings = loadGroupVisibilitySettings();
    saveGroupVisibilitySettings({
      ...settings,
      hiddenGroups: groups.getAll().filter(g => !g.visible).map(g => g.name),
      isolatedGroup: null,
      isolatedAutoFilter: null,
    });
    return { ok: true, name, visible: groups.get(name)?.visible ?? visible, members: info.nodes.length };
  },
};

export const groupSetListed: CommandImpl<{ name: string; listed: boolean }> = {
  enabled: () => true,
  run: async (_ctx, { name, listed }) => {
    const settings = loadGroupVisibilitySettings();
    const excluded = new Set(settings.excludedFromOverlay ?? []);
    const auto = new Set(settings.autoExcludedKinematic ?? []);
    // Either direction is a MANUAL decision: the name leaves the auto-owned
    // set, so a later load neither re-adds nor releases it on its own.
    auto.delete(name);
    if (listed) excluded.delete(name); else excluded.add(name);
    settings.excludedFromOverlay = [...excluded];
    settings.autoExcludedKinematic = [...auto];
    saveGroupVisibilitySettings(settings);
    return { ok: true, name, listed, excluded: settings.excludedFromOverlay };
  },
};

export const traceSet: CommandImpl<{ blocked?: boolean; utilization?: boolean; range?: string; windowSec?: number }> = {
  enabled: () => true,
  run: async ({ viewer }, { blocked, utilization, range, windowSec }) => {
    let r: TraceRange | null = null;
    if (range !== undefined && range !== null && range !== '') {
      r = parseRange(range);
      if (!r) return { error: `Unknown range "${range}" — use window or start` };
    }
    if (windowSec !== undefined && windowSec !== null && !Number.isFinite(Number(windowSec))) {
      return { error: `windowSec must be a number (3600 or 86400), got "${windowSec}"` };
    }
    if (typeof blocked === 'boolean') setOverlayVisible('trace-blocked', blocked);
    if (typeof utilization === 'boolean') setOverlayVisible('trace-utilization', utilization);
    if (r) setTraceRange(r);
    if (windowSec !== undefined && windowSec !== null) setTraceWindowSec(Number(windowSec));
    viewer?.markRenderDirty?.();
    return readTraceState(viewer);
  },
};

export const collisionWatch: CommandImpl<{ assignmentsJson: string }> = {
  enabled: ({ viewer }) => viewer ? true : { reason: 'No viewer' },
  run: async ({ viewer }, { assignmentsJson }) => {
    const v = viewer;
    if (!v) return { error: 'No viewer' };
    let entries: WatchEntry[];
    try {
      entries = JSON.parse(assignmentsJson) as WatchEntry[];
      if (!Array.isArray(entries)) throw new Error('not an array');
    } catch (e) {
      return { error: `assignmentsJson must be a JSON array: ${String(e)}` };
    }
    const registered: { path: string; role: string }[] = [];
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const { path, role } of entries) {
      const r = toCollisionRole(role);
      if (r === 'None') { invalid.push(`${path} (${role})`); continue; }
      const node = v.registry?.getNode(path) ?? null;
      if (!node) { missing.push(path); continue; }
      v.collisionManager.register(node, r);
      watchedFor(v).set(node, r);
      registered.push({ path, role: r });
    }
    v.collisionManager.invalidate();
    return {
      registered, missing, invalid,
      note: 'Bodies are rebuilt on the next simulation tick; check web_query("collision.status", {}) while the simulation runs.',
    };
  },
};

export const collisionReset: CommandImpl<{ clearWatch?: boolean }> = {
  enabled: ({ viewer }) => viewer ? true : { reason: 'No viewer' },
  run: async ({ viewer }, { clearWatch }) => {
    const v = viewer;
    if (!v) return { error: 'No viewer' };
    const m = v.collisionManager;
    m.reset();
    let removed = 0;
    if (clearWatch) {
      for (const node of watchedFor(v).keys()) { m.unregister(node); removed++; }
      watchedFor(v).clear();
      m.invalidate();
    }
    return { ok: true, removedWatch: removed, remainingWatch: watchedFor(v).size };
  },
};

export const workspaceSetMode: CommandImpl<{ mode: string }> = {
  enabled: ({ viewer }) => viewer?.modes ? true : { reason: 'No viewer' },
  run: async ({ viewer }, { mode }) => {
    const modes = viewer?.modes;
    if (!modes) return { error: 'No viewer' };
    if (!modes.has(mode)) {
      return { error: `Unknown mode "${mode}"`, available: modes.available().map(m => m.id) };
    }
    // The open document may restrict its modes (`documents[].modes`): a refusal
    // is an answer with its reason, never a silent no-op.
    const refusal = modes.refusalReason(mode);
    if (refusal !== null) {
      return { error: refusal, mode: modes.activeMode, available: modes.available().map(m => m.id) };
    }
    // Awaited (plan-652): a mode with an on-demand feature switches after its code loaded,
    // and this answer reports the mode the workspace is actually in.
    await modes.setModeAsync(mode);
    return { mode: modes.activeMode, available: modes.available().map(m => m.id) };
  },
};

export const collisionStatus: CommandImpl<{ includeBodies?: boolean }> = {
  enabled: ({ viewer }) => viewer ? true : { reason: 'No viewer' },
  run: async ({ viewer }, { includeBodies }) => {
    const v = viewer;
    if (!v) return { error: 'No viewer' };
    const m = v.collisionManager;
    const byRole: Record<string, number> = {};
    for (const b of m.bodies) byRole[b.role] = (byRole[b.role] ?? 0) + 1;
    const pairs = m.activePairs.map((p) => ({
      a: p.aPath, aRole: p.aRole, b: p.bPath, bRole: p.bRole, since: p.since,
    }));
    return {
      bodies: m.bodies.length,
      bodiesByRole: byRole,
      checkedPairs: m.pairs.length,
      sessionWatched: watchedFor(v).size,
      collisions: pairs.length,
      pairs,
      ...(includeBodies ? {
        bodyList: m.bodies.map((b) => ({ path: b.key, role: b.role, meshes: b.meshes.length, aabbOnly: b.aabbOnly })),
      } : {}),
    };
  },
};

const SPECS = [
  { id: 'group.setVisible', label: 'Group visibility', readOnly: false, argsSchema: { name: 'string', visible: 'boolean' } as Readonly<Record<string, CommandArgType>>, impl: groupSetVisible as CommandImpl<never, unknown> },
  { id: 'group.setListed', label: 'List group', readOnly: false, argsSchema: { name: 'string', listed: 'boolean' } as Readonly<Record<string, CommandArgType>>, impl: groupSetListed as CommandImpl<never, unknown> },
  { id: 'trace.set', label: 'Trace settings', readOnly: false, toolClass: 'sim' as const, argsSchema: { blocked: 'boolean', utilization: 'boolean', range: 'string', windowSec: 'number' } as Readonly<Record<string, CommandArgType>>, impl: traceSet as CommandImpl<never, unknown> },
  { id: 'collision.watch', label: 'Watch collisions', readOnly: false, argsSchema: { assignmentsJson: 'string' } as Readonly<Record<string, CommandArgType>>, impl: collisionWatch as CommandImpl<never, unknown> },
  { id: 'collision.reset', label: 'Reset collisions', readOnly: false, argsSchema: { clearWatch: 'boolean' } as Readonly<Record<string, CommandArgType>>, impl: collisionReset as CommandImpl<never, unknown> },
  { id: 'workspace.setMode', label: 'Workspace mode', readOnly: false, argsSchema: { mode: 'string' } as Readonly<Record<string, CommandArgType>>, impl: workspaceSetMode as CommandImpl<never, unknown> },
  { id: 'collision.status', label: 'Collision status', readOnly: true, argsSchema: { includeBodies: 'boolean' } as Readonly<Record<string, CommandArgType>>, impl: collisionStatus as CommandImpl<never, unknown> },
  { id: 'trace.state', label: 'Trace state', readOnly: true, argsSchema: {} as Readonly<Record<string, CommandArgType>>, impl: traceState as CommandImpl<never, unknown> },
];

export function createSessionOverlayCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [
    {
      id: 'trace.top', label: 'trace.top', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { view: 'string', range: 'string', n: 'number' },
      impl: async () => {
        const { TraceQueries } = await import('../../plugins/mcp-bridge/rv-mcp-trace-tools');
        const impl: CommandImpl<{ view?: string; range?: string; n?: number }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new TraceQueries(() => ctx.viewer).queryTraceTop(a?.view, a?.range, a?.n)),
        };
        return impl;
      },
    },
    {
      id: 'group.list', label: 'group.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { GroupQueries } = await import('../../plugins/mcp-bridge/rv-mcp-groups-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new GroupQueries(() => ctx.viewer).queryGroupList()),
        };
        return impl;
      },
    },
    ...SPECS.map((s) => ({
    id: s.id, label: s.label, readOnly: s.readOnly,
    ...('toolClass' in s ? { toolClass: s.toolClass } : {}),
    scope: 'none', available: true, unavailableReason: 'Not available',
    argsSchema: s.argsSchema, eagerImpl: s.impl, impl: () => Promise.resolve(s.impl),
  }))] as CommandDescriptor<never, unknown>[];
}

const registered = new WeakSet<CommandRegistry>();
export function ensureSessionOverlayCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createSessionOverlayCommandDescriptors()) registry.register(d);
}
