// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Unified CAD import facade tests (plan-238 §8.1 / §8.4).
 *
 * Covers the provider registry, the safe-resolve wrapper, the additive
 * `importObject` sink (never touches loadModel/clearModel — the core F3
 * guarantee), the local-folder persistence conventions, and the op-level
 * undo/redo roundtrip for AddPlacementOp.
 *
 * There is no replace sink any more: editor mode edits ONE asset (no scene, so
 * an import is always an addition — see rv-import-asset.ts), and planner mode
 * places into the scene. `openImportAsNewScene` was deleted along with the
 * `object3d` result kind — every provider now resolves to GLB bytes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ImportProviderRegistry,
  resolveProviderSafe,
  type CadImportProvider,
  type ImportProgress,
  type ImportProviderResult,
} from '../src/core/import/rv-import-provider';
import {
  importObject,
  type ImportPlannerLike,
} from '../src/core/import/rv-import-object';
import {
  localEntryIdForPath,
  localEntryNameForFile,
  persistImportedGlb,
} from '../src/core/import/rv-import-persistence';
import { inverseOp, freshOpId, type AddPlacementOp } from '../src/core/hmi/scene/rv-scene-edits';
import type { LibraryCatalogEntry, PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<CadImportProvider> & { id: string }): CadImportProvider {
  return {
    label: overrides.id,
    availability: () => 'ready',
    onAvailabilityChange: () => () => undefined,
    renderConfigTab: () => null,
    resolve: async () => ({ ok: [], failed: [] }),
    ...overrides,
  } as CadImportProvider;
}

interface FakePlacement {
  entry: LibraryCatalogEntry;
  position: [number, number, number];
  opts?: { skipAutoAlign?: boolean };
}

function makeFakePlanner(): ImportPlannerLike & { placements: FakePlacement[] } {
  const placements: FakePlacement[] = [];
  return {
    placements,
    placeComponent: async (entry, position, opts) => {
      placements.push({ entry, position, opts });
      return `placed-${placements.length}`;
    },
  };
}

function makeFakeViewer(planner: ImportPlannerLike | undefined) {
  const loadModel = vi.fn();
  const clearModel = vi.fn();
  return {
    viewer: {
      getPlugin: <T,>(id: string): T | undefined =>
        (id === 'layout-planner' ? planner as T : undefined),
      loadModel,
      clearModel,
    },
    loadModel,
    clearModel,
  };
}

const ENTRY: LibraryCatalogEntry = {
  id: 'cat-entry-1',
  name: 'Belt Conveyor',
  category: 'conveyor',
  glbUrl: 'https://example.com/belt.glb',
};

// ─── Registry (§8.1 registry_RegisterAndList / §8.4 registry_DuplicateId) ──

describe('ImportProviderRegistry', () => {
  it('registers providers and lists them sorted by order', () => {
    const reg = new ImportProviderRegistry();
    reg.register(makeProvider({ id: 'b', order: 30 }));
    reg.register(makeProvider({ id: 'a', order: 10 }));
    expect(reg.list().map(p => p.id)).toEqual(['a', 'b']);
    expect(reg.get('a')?.id).toBe('a');
  });

  it('duplicate id has defined behavior: replaces the previous provider', () => {
    const reg = new ImportProviderRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reg.register(makeProvider({ id: 'step', label: 'old' }));
    reg.register(makeProvider({ id: 'step', label: 'new' }));
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('step')?.label).toBe('new');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('notifies onChange for register and unregister', () => {
    const reg = new ImportProviderRegistry();
    const cb = vi.fn();
    const off = reg.onChange(cb);
    reg.register(makeProvider({ id: 'x' }));
    reg.unregister('x');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    reg.register(makeProvider({ id: 'y' }));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

// ─── Safe resolve (§8.4 provider_ResolveThrows_ShowsError / PartialSuccess) ──

describe('resolveProviderSafe', () => {
  it('normalizes a throwing resolve() into a failed entry (no silent loss)', async () => {
    const p = makeProvider({
      id: 'boom',
      resolve: async () => { throw new Error('parse failed'); },
    });
    const res = await resolveProviderSafe(p, { kind: 'custom', data: null });
    expect(res.ok).toEqual([]);
    expect(res.failed).toEqual([{ id: 'boom', error: 'parse failed' }]);
  });

  it('passes through partial success (n ok + m failed)', async () => {
    const partial: ImportProviderResult = {
      ok: [{ kind: 'catalog', entries: [ENTRY] }],
      failed: [{ id: 'part-2', error: 'no GLB export' }],
    };
    const p = makeProvider({ id: 'partial', resolve: async () => partial });
    const res = await resolveProviderSafe(p, { kind: 'custom', data: null });
    expect(res.ok).toHaveLength(1);
    expect(res.failed).toHaveLength(1);
  });

  it('forwards the progress listener to the provider (drives the dialog bar)', async () => {
    const seen: ImportProgress[] = [];
    const p = makeProvider({
      id: 'slow',
      resolve: async (_input, onProgress) => {
        onProgress?.({ percent: null, label: 'Starting CAD engine' });
        onProgress?.({ percent: 0.34, label: 'Tessellating', detail: '~1 min 20 s remaining' });
        return { ok: [], failed: [] };
      },
    });

    await resolveProviderSafe(p, { kind: 'custom', data: null }, (u) => seen.push(u));

    expect(seen).toHaveLength(2);
    // `percent: null` = "no honest number to give" → the bar stays indeterminate.
    expect(seen[0].percent).toBeNull();
    expect(seen[1].percent).toBeCloseTo(0.34);
  });

  it('a provider that ignores onProgress still resolves (bar stays indeterminate)', async () => {
    const p = makeProvider({ id: 'quiet', resolve: async () => ({ ok: [], failed: [] }) });
    const onProgress = vi.fn();
    const res = await resolveProviderSafe(p, { kind: 'custom', data: null }, onProgress);
    expect(res.ok).toEqual([]);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('forwards the abort signal and treats a cancel as empty (not a failure)', async () => {
    const controller = new AbortController();
    const p = makeProvider({
      id: 'cancellable',
      resolve: async (_input, _onProgress, _signal) => {
        controller.abort();                 // user hits Cancel mid-resolve
        throw new DOMException('Aborted', 'AbortError'); // provider honours the signal
      },
    });
    const res = await resolveProviderSafe(p, { kind: 'custom', data: null }, undefined, controller.signal);
    // Cancel is not an error: nothing ok, nothing failed → dialog just resets.
    expect(res.ok).toEqual([]);
    expect(res.failed).toEqual([]);
  });
});

// ─── Additive sink (§8.1 importObject_Additive_NoClearModel + op path) ────

describe('importObject (additive sink)', () => {
  it('never calls loadModel or clearModel', async () => {
    const planner = makeFakePlanner();
    const { viewer, loadModel, clearModel } = makeFakeViewer(planner);

    await importObject(viewer, { kind: 'catalog', entries: [ENTRY] });

    expect(loadModel).not.toHaveBeenCalled();
    expect(clearModel).not.toHaveBeenCalled();
    expect(planner.placements).toHaveLength(1);
    expect(planner.placements[0].entry).toBe(ENTRY);
  });

  it('routes placements through placeComponent (the AddPlacementOp path) and returns ids', async () => {
    const planner = makeFakePlanner();
    const { viewer } = makeFakeViewer(planner);

    const outcome = await importObject(viewer, {
      kind: 'catalog',
      entries: [ENTRY, { ...ENTRY, id: 'cat-entry-2' }],
    });

    expect(outcome.placedIds).toEqual(['placed-1', 'placed-2']);
  });

  it('forwards skipAutoAlign to placeComponent (multi-part CAD, §8.4 NoAutoAlign)', async () => {
    const planner = makeFakePlanner();
    const { viewer } = makeFakeViewer(planner);

    await importObject(viewer, { kind: 'catalog', entries: [ENTRY] }, { skipAutoAlign: true });
    expect(planner.placements[0].opts).toEqual({ skipAutoAlign: true });

    await importObject(viewer, { kind: 'catalog', entries: [ENTRY] });
    expect(planner.placements[1].opts).toBeUndefined();
  });

  it('GLB bytes without a working folder fall back to a blob entry and flag persisted=false', async () => {
    const planner = makeFakePlanner();
    const { viewer, loadModel, clearModel } = makeFakeViewer(planner);
    const bytes = new TextEncoder().encode('glTF-fake').buffer as ArrayBuffer;

    const outcome = await importObject(viewer, { kind: 'glb', bytes, suggestedName: 'MyPart' });

    expect(outcome.placedIds).toHaveLength(1);
    expect(outcome.persisted).toBe(false);
    expect(outcome.warnings.length).toBeGreaterThan(0);
    const entry = planner.placements[0].entry;
    expect(entry.glbUrl?.startsWith('blob:')).toBe(true);
    expect(entry.id.startsWith('import-')).toBe(true);
    expect(loadModel).not.toHaveBeenCalled();
    expect(clearModel).not.toHaveBeenCalled();
  });

  it('throws a visible error when the layout planner is missing', async () => {
    const { viewer } = makeFakeViewer(undefined);
    await expect(
      importObject(viewer, { kind: 'catalog', entries: [ENTRY] }),
    ).rejects.toThrow(/layout-planner/);
  });
});

// ─── Persistence conventions (§2.2a — reload-stable catalog ids) ─────────

describe('import persistence conventions', () => {
  it('localEntryIdForPath matches the local-folder scanner id convention', () => {
    // Scanner: `local-${prefixedPath.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`
    expect(localEntryIdForPath('imports/My Part_v2.glb')).toBe('local-imports-my-part-v2-glb');
    expect(localEntryIdForPath('conveyor/belt.glb')).toBe('local-conveyor-belt-glb');
  });

  it('localEntryNameForFile matches the scanner display-name convention', () => {
    expect(localEntryNameForFile('roll_conveyor-2m.glb')).toBe('roll conveyor 2m');
  });

  it('persistImportedGlb without a writable project degrades visibly (warning, persisted=false)', async () => {
    // plan-372 Phase 11: imports target the active project, not a work folder.
    // The degradation contract is unchanged — the import still works for this
    // session, it just says plainly that it will not survive a reload.
    const res = await persistImportedGlb('Gearbox', new ArrayBuffer(8));
    expect(res.persisted).toBe(false);
    expect(res.warning).toMatch(/no writable project/i);
    expect(res.warning).toMatch(/will NOT survive a reload/i);
    expect(res.entry.glbUrl?.startsWith('blob:')).toBe(true);
  });
});

// ─── Op-level undo/redo roundtrip (§8.4 import_UndoRedo_Roundtrip) ───────

describe('AddPlacementOp undo/redo roundtrip', () => {
  it('inverseOp(add) = remove, inverseOp(remove) = add with identical placement', () => {
    const placement: PlacedComponent = {
      id: 'p1',
      catalogId: 'local-imports-gearbox-glb',
      glbUrl: 'blob:fake',
      label: 'Gearbox',
      position: [1, 0, 2],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    };
    const add: AddPlacementOp = {
      id: freshOpId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement,
    };
    const undo = inverseOp(add);
    expect(undo.kind).toBe('removePlacement');
    if (undo.kind === 'removePlacement') {
      expect(undo.placementId).toBe('p1');
      const redo = inverseOp(undo);
      expect(redo.kind).toBe('addPlacement');
      if (redo.kind === 'addPlacement') {
        expect(redo.placement).toEqual(placement);
      }
    }
  });
});
