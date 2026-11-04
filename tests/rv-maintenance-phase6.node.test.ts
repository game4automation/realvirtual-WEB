// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-522 Phase 6 §9.13 — document link per step, mileage / operating-hours
 * trigger and the message tiles of the MaintenancePlugin.
 */

import { describe, expect, test, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { parseMaintenanceProcedures } from '../src/core/maintenance-parser';
import {
  buildDocumentHref,
  documentButtonLabel,
  pickAasDocument,
  resolveMaintenanceDocument,
} from '../src/core/hmi/maintenance-document-link';
import { maintenanceTileSubtitle } from '../src/core/hmi/MaintenanceMessages';
import { MaintenancePlugin } from '../src/plugins/demo/maintenance-plugin';
import { EventEmitter } from '../src/core/rv-events';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { AasDocument } from '../src/plugins/aas-link-parser';

const ref = (path: string, componentType = '') => ({ type: 'ComponentReference', path, componentType });

function node(name: string, rv?: Record<string, unknown>): Object3D {
  const o = new Object3D();
  o.name = name;
  if (rv) o.userData = { realvirtual: rv };
  return o;
}

/** A scene with one procedure (trigger on drive `Axis`) and two steps. */
function sceneWith(procedureData: Record<string, unknown>, stepData: Record<string, unknown> = {}): Scene {
  const scene = new Scene();
  const root = node('Cell');
  scene.add(root);
  const proc = node('Maintenance', { LogicStep_MaintenanceProcedure: { ProcedureName: 'Schlitten schmieren', ...procedureData } });
  root.add(proc);
  proc.add(node('01 Stop', { LogicStep_MaintenanceStep: { Title: 'Stop', ...stepData } }));
  proc.add(node('02 Lube', { LogicStep_MaintenanceStep: { Title: 'Lube' } }));
  return scene;
}

describe('parser — document link and trigger', () => {
  test('reads DocumentTitle/Page/Url/Keyword/Source of a step', () => {
    const [p] = parseMaintenanceProcedures(sceneWith({}, {
      DocumentTitle: 'Betriebsanleitung', DocumentPage: 18, DocumentUrl: '',
      DocumentSource: ref('Cell/DGC'), DocumentKeyword: 'Bedienungsanleitung | Operating instructions',
    }));
    expect(p.steps[0].document).toEqual({
      title: 'Betriebsanleitung', page: 18, url: '', sourcePath: 'Cell/DGC',
      keywords: ['bedienungsanleitung', 'operating instructions'],
    });
    expect(p.steps[1].document).toBeUndefined();
  });

  test('reads message mode and the trigger; no trigger without interval', () => {
    const [p] = parseMaintenanceProcedures(sceneWith({
      Message: 'Always', TriggerDrive: ref('Cell/Axis', 'Drive'), TriggerUnit: 'km', TriggerInterval: 5000, TriggerAcceleration: 200000,
    }));
    expect(p.message).toBe('Always');
    expect(p.trigger).toMatchObject({ unit: 'km', interval: 5000, acceleration: 200000, drivePath: 'Cell/Axis' });
    const [q] = parseMaintenanceProcedures(sceneWith({ TriggerDrive: ref('Cell/Axis'), TriggerInterval: 0 }));
    expect(q.trigger).toBeUndefined();
    expect(q.message).toBeUndefined();
  });
});

describe('document link', () => {
  test('buildDocumentHref replaces {lang} and sets the page fragment', () => {
    expect(buildDocumentHref('https://x.test/a/{lang}/1', 18, 'de')).toBe('https://x.test/a/de/1#page=18');
    expect(buildDocumentHref('https://x.test/a.pdf#zoom=50', 3, 'en')).toBe('https://x.test/a.pdf#page=3');
    expect(buildDocumentHref('https://x.test/a.pdf', 0, 'en')).toBe('https://x.test/a.pdf');
  });

  test('pickAasDocument: keyword, then UI language, then de/en', () => {
    const docs: AasDocument[] = [
      { title: 'Datenblatt', mimeType: 'application/pdf', zipPath: '', url: 'https://f/de/1', language: 'DE', kind: 'Data sheet' },
      { title: 'Bedienungsanleitung', mimeType: 'application/pdf', zipPath: '', url: 'https://f/de/2', language: 'DE', kind: 'Operating instructions' },
      { title: 'Operating instructions', mimeType: 'application/pdf', zipPath: '', url: 'https://f/en/2', language: 'EN', kind: 'Operating instructions' },
    ];
    expect(pickAasDocument(docs, ['operating instructions'], 'en')?.url).toBe('https://f/en/2');
    expect(pickAasDocument(docs, ['operating instructions'], 'de')?.url).toBe('https://f/de/2');
    expect(pickAasDocument(docs, ['operating instructions'], 'fr')?.url).toBe('https://f/de/2');
    expect(pickAasDocument(docs, ['wartungsplan'], 'de')).toBeNull();
  });

  test('resolveMaintenanceDocument: AAS first, explicit URL as fallback, unsafe schemes refused', async () => {
    const link = { title: 'BA', page: 18, url: 'https://f/{lang}/2', sourcePath: '', keywords: [] };
    expect(await resolveMaintenanceDocument(link, {}, 'de')).toEqual({ kind: 'external', href: 'https://f/de/2#page=18' });
    expect(await resolveMaintenanceDocument({ ...link, url: 'javascript:alert(1)' }, {}, 'de')).toBeNull();
    const aasNode = { userData: { _rvAasLink: { aasId: 'urn:dgc' } } };
    const host = { registry: { getNode: (p: string) => (p === 'Cell/DGC' ? aasNode : null) } };
    const load = vi.fn(async () => ({ documents: [
      { title: 'Bedienungsanleitung', mimeType: 'application/pdf', zipPath: 'docs/ba.pdf', language: 'DE', kind: 'Operating instructions' },
    ] as AasDocument[] }));
    const r = await resolveMaintenanceDocument({ ...link, url: '', sourcePath: 'Cell/DGC', keywords: ['operating'] }, host, 'de', load);
    expect(load).toHaveBeenCalledWith('urn:dgc');
    expect(r).toEqual({ kind: 'aas-blob', aasId: 'urn:dgc', zipPath: 'docs/ba.pdf', page: 18 });
    // no match in the AAS (or a failing index) -> the explicit URL
    const r2 = await resolveMaintenanceDocument({ ...link, sourcePath: 'Cell/DGC', keywords: ['wartungsplan'] }, host, 'en', load);
    expect(r2).toEqual({ kind: 'external', href: 'https://f/en/2#page=18' });
    const failing = vi.fn(async () => { throw new Error('AAS ID not found in index'); });
    const r3 = await resolveMaintenanceDocument({ ...link, sourcePath: 'Cell/DGC', keywords: ['operating'] }, host, 'de', failing);
    expect(r3).toEqual({ kind: 'external', href: 'https://f/de/2#page=18' });
  });

  test('button label', () => {
    expect(documentButtonLabel({ title: 'Betriebsanleitung', page: 18, url: '', sourcePath: '', keywords: [] }, 'de')).toBe('Betriebsanleitung, S. 18');
    expect(documentButtonLabel({ title: 'Manual', page: 0, url: '', sourcePath: '', keywords: [] }, 'en')).toBe('Manual');
  });
});

// ─── Plugin: trigger counter + tiles ────────────────────────────────────

function viewerFor(scene: Scene, drive: { currentPosition: number } | null) {
  const emitter = new EventEmitter();
  const registered: string[] = [];
  const viewer = {
    scene,
    registry: {
      getNode: () => null,
      resolve: (r: { path?: string }) => ({ drive: r.path === 'Cell/Axis' ? drive : null }),
    },
    uiRegistry: {
      register: (p: { id: string }) => { registered.push(p.id); },
      unregister: (id: string) => { const i = registered.indexOf(id); if (i >= 0) registered.splice(i, 1); },
    },
    setSimulationPaused: vi.fn(),
    getPlugin: () => undefined,
    getPlugins: () => [],
    clearHighlight: vi.fn(),
    highlighter: { setAuxEmphasis: vi.fn(), flash: vi.fn(), clearFlash: vi.fn() },
    markRenderDirty: vi.fn(),
    animateCameraTo: vi.fn(),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
  return { viewer, registered, emitter };
}

describe('MaintenancePlugin — trigger and tiles', () => {
  test('km counter with acceleration becomes due at the interval; completion resets it', () => {
    const drive = { currentPosition: 0 };
    const scene = sceneWith({ TriggerDrive: ref('Cell/Axis', 'Drive'), TriggerUnit: 'km', TriggerInterval: 2, TriggerAcceleration: 10000 });
    const { viewer, registered } = viewerFor(scene, drive);
    const plugin = new MaintenancePlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(registered).toEqual(['maintenance-messages']);
    expect(plugin.getMessageEntries()).toEqual([]); // WhenDue, not yet due

    // 100 mm back and forth = 200 mm travel per cycle × 10000 = 2 km per cycle
    drive.currentPosition = 100; plugin.onFixedUpdatePost(0.02);
    expect(plugin.getMessageEntries()).toEqual([]);
    drive.currentPosition = 0; plugin.onFixedUpdatePost(0.02);
    const [e] = plugin.getMessageEntries();
    expect(e.due).toBe(true);
    expect(e.value).toBeCloseTo(2, 6);
    expect(maintenanceTileSubtitle(e)).toMatch(/^2 \/ 2 km$/);

    // the tile opens exactly this procedure; completing it step by step resets the counter
    viewer.emit('enter-maintenance' as never, { procedure: 'Schlitten schmieren' } as never);
    expect(plugin.getState().mode).toBe('dialog');
    plugin.startScenario(null, 'stepbystep');
    plugin.nextStep(); plugin.nextStep();
    expect(plugin.getState().mode).toBe('completed');
    expect(plugin.getMessageEntries()).toEqual([]);
    plugin.exitMaintenance();

    plugin.onModelCleared(viewer);
    expect(registered).toEqual([]);
  });

  test('h counts only while the drive moves; Message Always lists it before it is due', () => {
    const drive = { currentPosition: 0 };
    const scene = sceneWith({ Message: 'Always', TriggerDrive: ref('Cell/Axis', 'Drive'), TriggerUnit: 'h', TriggerInterval: 1, TriggerAcceleration: 3600 });
    const { viewer } = viewerFor(scene, drive);
    const plugin = new MaintenancePlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(plugin.getMessageEntries()).toHaveLength(1);
    expect(plugin.getMessageEntries()[0].due).toBe(false);
    plugin.onFixedUpdatePost(0.5); // standing still: nothing
    expect(plugin.getMessageEntries()[0].value).toBe(0);
    drive.currentPosition = 5; plugin.onFixedUpdatePost(0.5); // 0.5 s × 3600 = 0.5 h
    expect(plugin.getMessageEntries()[0].value).toBeCloseTo(0.5, 6);
    drive.currentPosition = 10; plugin.onFixedUpdatePost(0.5);
    expect(plugin.getMessageEntries()[0].due).toBe(true);
  });

  test('without trigger and Message WhenDue (the demo) no tiles are registered', () => {
    const { viewer, registered } = viewerFor(sceneWith({}), null);
    const plugin = new MaintenancePlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(registered).toEqual([]);
  });
});

describe('step symbols and symbol markers', () => {
  test('parser reads the step Symbol (None = none) and LogicStep_Arrow Type Symbol with Label', () => {
    const scene = sceneWith({}, { Symbol: 'Lubricate' });
    const step = scene.getObjectByName('01 Stop')!;
    step.add(node('Grease', { LogicStep_Arrow: { Type: 'Symbol', Symbol: 'Lubricate', Label: 'LUB-E1', Size: 0.04, Animate: true } }));
    const [p] = parseMaintenanceProcedures(scene);
    expect(p.steps[0].symbol).toBe('Lubricate');
    expect(p.steps[1].symbol).toBeUndefined();
    expect(p.steps[0].arrows).toEqual([expect.objectContaining({ type: 'Symbol', symbol: 'Lubricate', label: 'LUB-E1', size: 0.04 })]);
    const [q] = parseMaintenanceProcedures(sceneWith({}, { Symbol: 'None' }));
    expect(q.steps[0].symbol).toBeUndefined();
  });
});
