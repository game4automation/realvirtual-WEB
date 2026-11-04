// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.14 — Phase 1 persists NOTHING (F17, D4).
 *
 * Load → prepare → bake → inspection (every stored read, the audit, findNodeForUser)
 * → reading persistence outside the GLB (a layout file with an address-form
 * mapping, the binding manager migrating it on read) must not write anything:
 *  - no project-backend document write (`fake-document-project.ts` records them);
 *  - no `localStorage` / `sessionStorage` write that carries an identity or an
 *    address (`_rvNodeId`, `NodeId`, `componentAddress`, `#<uuid>`), and none to
 *    the layout autosave / layout registry / annotation keys;
 *  - no IndexedDB `put` / `add` / `delete`;
 *  - no `FileSystemFileHandle.createWritable`;
 *  - the decoded extras stay as the file wrote them (no `address` written into
 *    them) and the persisted mapping records are not mutated by the read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { buildStoredReadersGlb } from './helpers/migrate-769-fixtures';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  deserializeLayout, serializeLayout, type PlacedComponent, type SignalMapping,
} from '../src/plugins/layout-planner/rv-layout-store';

const IDENTITY_IN_TEXT = /_rvNodeId|"NodeId"|componentAddress|#[0-9a-f]{8}-[0-9a-f]{4}-/;
const PERSISTENCE_KEY = /layout|annotation|autosave/i;

interface WriteLog { storage: Array<[string, string]>; idb: string[]; handles: number }

function spyWrites(): { log: WriteLog; restore(): void } {
  const log: WriteLog = { storage: [], idb: [], handles: 0 };
  const spies: Array<{ mockRestore(): void }> = [];
  const setItem = Storage.prototype.setItem;
  spies.push(vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    log.storage.push([k, v]);
    return setItem.call(this, k, v);
  }));
  const removeItem = Storage.prototype.removeItem;
  spies.push(vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, k: string) {
    log.storage.push([k, '<removed>']);
    return removeItem.call(this, k);
  }));
  if (typeof IDBObjectStore !== 'undefined') {
    for (const m of ['put', 'add', 'delete'] as const) {
      const orig = IDBObjectStore.prototype[m] as (...a: unknown[]) => IDBRequest;
      spies.push(vi.spyOn(IDBObjectStore.prototype, m).mockImplementation(function (this: IDBObjectStore, ...a: unknown[]) {
        log.idb.push(`${this.name}.${m}`);
        return orig.apply(this, a);
      } as never));
    }
  }
  const FSH = (globalThis as { FileSystemFileHandle?: { prototype: { createWritable?: unknown } } }).FileSystemFileHandle;
  if (FSH?.prototype && typeof FSH.prototype.createWritable === 'function') {
    spies.push(vi.spyOn(FSH.prototype as { createWritable: () => unknown }, 'createWritable').mockImplementation(() => {
      log.handles++;
      throw new Error('9.14: no file write in Phase 1');
    }));
  }
  return { log, restore: () => { for (const s of spies) s.mockRestore(); } };
}

describe('plan-769 9.14 — load, inspection and reading persistence write nothing', () => {
  let h: TestViewerHandle | null = null;
  let project: FakeDocumentProject | null = null;
  afterEach(() => { h?.dispose(); h = null; project?.restore(); project = null; resetProblemsForTests(); vi.restoreAllMocks(); });

  it('0 writes after load + prepare + bake + inspection + mapping read', async () => {
    resetProblemsForTests();
    const bytes = await buildStoredReadersGlb();
    project = installFakeDocumentProject({ documents: [] });
    const spy = spyWrites();
    try {
      h = await createTestViewer('webgl');
      await h.viewer.loadModel('stored-readers.glb', { data: bytes.slice(0) });
      const reg = h.viewer.registry!;
      // Inspection: every stored read, the audit, path inputs.
      const extrasBefore = new Map<Object3D, string>();
      reg.forEachNode((_p, n) => {
        const rv = n.userData?.realvirtual;
        if (rv && !extrasBefore.has(n)) extrasBefore.set(n, JSON.stringify(rv));
      });
      const panel = reg.getNode('Cell/Panel')!;
      reg.readStoredRef(panel, 'CadB/Sep/Pin');
      reg.readStoredRef(panel, 'Sep/Pin');
      reg.findNodeForUser('CadB/Sep/Pin');
      auditReferences(reg);

      // Persistence outside the GLB, read: a layout record with an ADDRESS-form mapping.
      const slave = reg.getNode('Cell/Mount/Belt')!;
      const store = h.viewer.signalStore!;
      const slots = resolveBindableSlots(slave, store, reg).filter((s) => s.kind !== 'unavailable');
      expect(slots.length).toBeGreaterThan(0);
      const slot = slots[0]!;
      const target = slot.componentPath === '.' ? slave : reg.getNode(`${reg.getPathForNode(slave)}/${slot.componentPath}`)!;
      const persisted: SignalMapping = {
        kind: slot.kind, slot: slot.slot, componentAddress: `#${identityIdOf(target)}`,
        signal: 'Ext.Run', direction: 'plcOutput', enabled: true,
      };
      const layoutJson = JSON.stringify(serializeLayout('L', [{
        id: 'p1', catalogId: 'c', glbUrl: 'x.glb', label: 'P', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        signalMappings: [persisted],
      } as PlacedComponent], [], 100));
      const layout = deserializeLayout(layoutJson);
      const mappings = layout.components[0]!.signalMappings!;
      expect(mappings[0]!.componentAddress).toBe(persisted.componentAddress); // the reader keeps the address form
      const snapshot = JSON.stringify(mappings);
      const manager = h.viewer.signalBindingManager ?? new SignalBindingManager(store, reg);
      const applied = manager.previewMappings('p1', slave, mappings);
      // Migrated ON READ: the slot path came from the address …
      expect(applied.map((m) => m.componentPath)).toEqual([slot.componentPath]);
      // … in a copy — the persisted records are untouched.
      expect(JSON.stringify(mappings)).toBe(snapshot);
      expect(mappings[0]!.componentPath).toBeUndefined();

      // The decoded extras are what the file wrote: nothing migrated was written into them.
      for (const [n, before] of extrasBefore) expect(JSON.stringify(n.userData.realvirtual)).toBe(before);
    } finally {
      spy.restore();
    }
    expect(project.writes).toEqual([]);
    expect(spy.log.handles).toBe(0);
    expect(spy.log.idb).toEqual([]);
    expect(spy.log.storage.filter(([k, v]) => PERSISTENCE_KEY.test(k) || IDENTITY_IN_TEXT.test(v))).toEqual([]);
  });
});
