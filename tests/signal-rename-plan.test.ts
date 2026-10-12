// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 Phase 3 — `planSignalRename`: every reference kind of plan §2.3,
 * every blocker, the completeness scope, and the new usage-index kinds
 * (metadata, carrier anchor, historian, mirror literal). The plan is side
 * effect free: nothing in the scene, the store or the ports changes.
 */

import { describe, expect, it } from 'vitest';
import { RV_FMU_SIGNAL } from '../src/core/engine/rv-fmu';
import {
  SIGNAL_RENAME_SCOPE, planSignalRename, rewriteMetadataContent, rewriteOperatorPanelConfig,
  type SignalRenamePlan, type SignalRenameStep,
} from '../src/core/engine/rv-signal-rename';
import {
  buildSignalUsageIndex, collectConnectBridgeUsages, collectHistorianUsages, collectMetadataUsages,
  collectSignalLinkAnchorUsages, type SignalUsage,
} from '../src/core/engine/rv-signal-usage-index';
import { field, makeRenameFixture, node, plc, planIn, type RenameFixture } from './helpers/signal-rename-fixture';

const PANEL = JSON.stringify({
  title: 'Cell',
  buttons: [{ label: 'Start', signal: 'DB.Start' }, { label: 'Other', signal: 'DB.Other' }],
  status: [{ kind: 'run', when: { all: [{ signal: 'DB.Start' }, { not: { signal: 'DB.Other' } }] } }],
}, null, 2);

function build(opts: { connect?: boolean; plc?: boolean } = {}): RenameFixture {
  const f = makeRenameFixture((root) => {
    const cell = node('Cell', root);
    node('Start', cell, {
      ...plc('PLCInputBool', 'DB.Start'),
      SignalLinks: { Mappings: [{ signal: 'Remote.X', carrierSignalName: 'DB.Start', direction: 'plcOutput', enabled: true }] },
    });
    node('Other', cell, plc('PLCOutputBool', 'DB.Other'));
    node('Sensor', cell, { WebSensor: { SignalBool: 'DB.Start', SignalInt: 'DB.Other', Label: 'DB.Start' } });
    node('Bridge', cell, { ConnectSignal: { Name: 'DB.Start', Signal: 'DB.Start' } });
    node('Panel', root, { WebOperatorPanel: { Config: PANEL } });
    node('Info', root, { RuntimeMetadata: { content: '<name>Info</name><value label="Run"><signal>DB.Start</signal></value><signal> DB.Start </signal><signal>DB.Other</signal>' } });
    node('Lamp', root, { SignalLinks: { Mappings: [
      { sourceKind: 'internal', signal: 'DB.Start', direction: 'plcOutput', enabled: true },
      { sourceKind: 'connect', signal: 'DB.Start', interfaceId: 'S7', direction: 'plcOutput', enabled: true },
    ] } });
    node('PLC', root, { PLCProgram: { Name: 'Main', Code: 'PROGRAM Main\nVAR_EXTERNAL\n  DB_Start : BOOL; (* @signal: DB.Start *)\nEND_VAR\nEND_PROGRAM' } });
  }, { connectNames: opts.connect === false ? [] : ['DB.Start'], plc: opts.plc });
  f.connect.connected = opts.connect !== false;
  f.placed.placements = [
    { id: 'p1', label: 'Conveyor 1', signalMappings: [{ sourceKind: 'internal', signal: 'DB.Start', direction: 'plcInput', enabled: true }] },
    { id: 'p2', label: 'Conveyor 2', signalMappings: [{ sourceKind: 'internal', signal: 'DB.Other', direction: 'plcInput', enabled: true }] },
  ];
  f.historian.selection = ['DB.Start', 'DB.Other'];
  return f;
}

const byKind = (plan: SignalRenamePlan, kind: SignalRenameStep['kind']) => plan.steps.filter((s) => s.kind === kind);

describe('planSignalRename — reference kinds (plan §2.3)', () => {
  it('lists every write with the exact value it would write, and changes nothing', async () => {
    const f = build({ plc: true });
    const before = JSON.stringify(f.root.toJSON());
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');

    expect(plan.blockers).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.oldName).toBe('DB.Start');
    expect(plan.signalType).toBe('PLCInputBool');
    expect(plan.owners).toEqual(['Asset/Cell/Start']);

    // rv_extras.<PLC*>.Name
    expect(byKind(plan, 'signal-name')).toEqual([expect.objectContaining({
      doc: 'model', nodePath: 'Asset/Cell/Start', componentType: 'PLCInputBool', field: 'Name', value: 'DB.Go', prev: 'DB.Start',
    })]);
    // legacy string fields — only where value === old and only real signal fields
    expect(byKind(plan, 'string-field').map((s) => `${s.nodePath}|${s.componentType}.${s.field}`).sort()).toEqual([
      'Asset/Cell/Bridge|ConnectSignal.Signal', 'Asset/Cell/Sensor|WebSensor.SignalBool',
    ]);
    // operator panel: text config keeps its format, both signal keys rewritten
    const [panel] = byKind(plan, 'operator-panel');
    expect(panel.detail).toBe('2 panel fields');
    expect(panel.value).toBe(PANEL.split('"DB.Start"').join('"DB.Go"'));
    // metadata: both <signal> tags of DB.Start, the DB.Other tag untouched
    const [meta] = byKind(plan, 'metadata');
    expect(meta.value).toBe('<name>Info</name><value label="Run"><signal>DB.Go</signal></value><signal> DB.Go </signal><signal>DB.Other</signal>');
    // node mappings: carrierSignalName anchor + internal AND connect mapping (CONNECT renames too)
    const links = byKind(plan, 'signal-link');
    expect(links.map((s) => s.nodePath).sort()).toEqual(['Asset/Cell/Start', 'Asset/Lamp']);
    expect(links.every((s) => s.doc === 'overlay')).toBe(true);
    const lamp = links.find((s) => s.nodePath === 'Asset/Lamp')!.value as Array<{ signal: string }>;
    expect(lamp.map((m) => m.signal)).toEqual(['DB.Go', 'DB.Go']);
    const carrier = links.find((s) => s.nodePath === 'Asset/Cell/Start')!.value as Array<{ carrierSignalName: string; signal: string }>;
    expect(carrier[0]).toMatchObject({ signal: 'Remote.X', carrierSignalName: 'DB.Go' });
    // ST program through the seam
    expect(byKind(plan, 'plc-program')).toHaveLength(0); // the fake only knows `old : BOOL;` declarations
    // planner placement, historian
    expect(byKind(plan, 'placed-mapping')).toEqual([expect.objectContaining({ placedId: 'p1', label: 'Conveyor 1' })]);
    expect(byKind(plan, 'historian')[0].value).toEqual(['DB.Go', 'DB.Other']);
    expect(plan.warnings.some((w) => w.startsWith('Historian:'))).toBe(true);
    // CONNECT
    expect(byKind(plan, 'connect')).toHaveLength(1);
    expect(plan.connect.state).toBe('rename');
    expect(plan.renameRevision).toBe('r1');
    // completeness scope
    expect(plan.scope).toBe(SIGNAL_RENAME_SCOPE);
    expect(plan.scope).toContain('not loaded');

    // side-effect free
    expect(JSON.stringify(f.root.toJSON())).toBe(before);
    expect(f.store.get('DB.Start')).toBeDefined();
    expect(f.connect.names.has('DB.Start')).toBe(true);
    expect(f.connect.calls.every((c) => c.preview)).toBe(true);
    expect(f.asset.opCount).toBe(0);
    expect(f.placed.placements[0].signalMappings![0].signal).toBe('DB.Start');
    expect(f.historian.selection).toEqual(['DB.Start', 'DB.Other']);
    expect(field(f, 'Asset/Cell/Start', 'PLCInputBool', 'Name')).toBe('DB.Start');
  });

  it('takes ST edits from the PLC seam and counts path references from the usage index', async () => {
    const f = build({ plc: true });
    (f.registry.getNode('Asset/PLC')!.userData.realvirtual as Record<string, Record<string, unknown>>).PLCProgram.Code =
      'PROGRAM Main\nVAR_EXTERNAL\n  DB.Start : BOOL;\nEND_VAR\nEND_PROGRAM';
    const usages: SignalUsage[] = [
      { kind: 'component-field', signal: 'DB.Start', label: 'Drive', resolved: true, nodePath: 'Asset/Drive' },
      { kind: 'logic-step', signal: 'DB.Start', label: 'Step', resolved: true, nodePath: 'Asset/Step' },
      { kind: 'component-field', signal: 'DB.Start', label: 'Sensor', resolved: true, byName: true },
    ];
    const plan = await planSignalRename({ ...f.viewer, signalUsage: { usages: () => usages } } as never,
      'Asset/Cell/Start', 'DB.Go', { ...f.env });
    const [st] = byKind(plan, 'plc-program');
    expect(st).toMatchObject({ nodePath: 'Asset/PLC', programName: 'Main', componentType: 'PLCProgram', field: 'Code', doc: 'model' });
    expect(String(st.value)).toContain('(* @signal: DB.Go *)');
    const [refs] = byKind(plan, 'path-reference');
    expect(refs).toMatchObject({ write: false, count: 2 });
    expect(plan.counts['path-reference']).toBe(2);
  });

  it('does not rewrite a CONNECT mapping when CONNECT is not connected (warning instead)', async () => {
    const f = build({ connect: false });
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    expect(plan.connect.state).toBe('not-connected');
    expect(plan.warnings.some((w) => w.includes('CONNECT is not connected'))).toBe(true);
    const lamp = byKind(plan, 'signal-link').find((s) => s.nodePath === 'Asset/Lamp')!.value as Array<{ signal: string }>;
    expect(lamp.map((m) => m.signal)).toEqual(['DB.Go', 'DB.Start']);
    expect(plan.renameRevision).toBeNull();
    expect(plan.ok).toBe(true);
  });

  it('marks wire effects, which then need the confirmation', async () => {
    const f = build();
    f.connect.wire = [{ interfaceId: 'MQTT', topic: 'plant/io', kind: 'json-key', detail: 'key "DB.Start" → "DB.Go"' }];
    f.connect.inactiveProfiles = ['Night shift'];
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    expect(plan.wireChanges).toHaveLength(1);
    expect(plan.requiresWireConfirmation).toBe(true);
    expect(plan.warnings.some((w) => w.includes('Night shift'))).toBe(true);
  });
});

describe('planSignalRename — blockers (fail closed)', () => {
  it('generated, FMU and placement signals', async () => {
    const f = makeRenameFixture((root) => {
      node('Gen', root, plc('PLCOutputBool', 'Gen.Sig', { Generated: true }));
      const fmu = node('Fmu', root, plc('PLCOutputFloat', 'Fmu.Out'));
      fmu.userData[RV_FMU_SIGNAL] = true;
      const placement = node('Conveyor_1', root, { LayoutObject: { Id: 'x' } });
      node('Run', placement, plc('PLCInputBool', 'Conv.Run'));
    });
    expect(RV_FMU_SIGNAL).toBe('_rvFmuSignal'); // the planner reads the marker by its literal
    const gen = await planIn(f, 'Asset/Gen', 'X');
    expect(gen.blockers.join(' ')).toContain('generated');
    const fmu = await planIn(f, 'Asset/Fmu', 'X');
    expect(fmu.blockers.join(' ')).toContain('FMU');
    const placed = await planIn(f, 'Asset/Conveyor_1/Run', 'X');
    expect(placed.blockers.join(' ')).toContain('placement');
    expect([gen, fmu, placed].every((p) => !p.ok)).toBe(true);
  });

  it('invalid, unchanged and taken names; not a signal', async () => {
    const f = build();
    expect((await planIn(f, 'Asset/Cell/Start', '')).blockers[0]).toContain('empty');
    expect((await planIn(f, 'Asset/Cell/Start', ' DB.Go')).blockers[0]).toContain('white space');
    expect((await planIn(f, 'Asset/Cell/Start', 'DB.Start')).blockers[0]).toContain('current name');
    expect((await planIn(f, 'Asset/Cell/Start', 'DB.Other')).blockers[0]).toContain('already exists');
    expect((await planIn(f, 'Asset/Panel', 'X')).blockers[0]).toContain('not a PLC signal');
  });

  it('old CONNECT: blocked when its configuration uses the name, a warning otherwise', async () => {
    const f = build();
    f.connect.unsupported = true;
    const used = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    expect(used.blockers.join(' ')).toContain('update CONNECT');
    f.connect.names.clear();
    const unused = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    expect(unused.ok).toBe(true);
    expect(unused.warnings.join(' ')).toContain('cannot rename signals');
  });

  it('CONNECT name collision and unreachable CONNECT', async () => {
    const f = build();
    f.connect.names.add('DB.Go');
    expect((await planIn(f, 'Asset/Cell/Start', 'DB.Go')).blockers.join(' ')).toContain('CONNECT already has');
    f.connect.names.delete('DB.Go');
    f.connect.renameSignal = async () => ({ kind: 'error', message: 'offline' });
    expect((await planIn(f, 'Asset/Cell/Start', 'DB.Go')).blockers.join(' ')).toContain('not reachable');
  });

  it('ST blockers from the PLC seam (unsaved buffer, several declarations, "*)") are passed through', async () => {
    const f = build();
    const plan = await planSignalRename(f.viewer, 'Asset/Cell/Start', 'DB.Go', {
      ...f.env,
      plc: {
        planRename: () => ({ edits: [], blockers: [
          'PLC program "Main" has unsaved changes in the editor — save or discard them first.',
          'PLC program "Main": line 3 declares several signals — put "A" on its own line first.',
          'PLC program "Main": the new name contains "*)", which cannot be written into an ST pragma.',
        ] }),
        writePlcCode: async () => {},
      },
    });
    expect(plan.blockers).toHaveLength(3);
    expect(plan.ok).toBe(false);
  });

  it('an unparsable operator panel that mentions the name blocks; one that does not is ignored', async () => {
    const f = makeRenameFixture((root) => {
      node('Start', root, plc('PLCInputBool', 'DB.Start'));
      node('Broken', root, { WebOperatorPanel: { Config: '{ "buttons": [ { "signal": "DB.Start" ' } });
      node('Unrelated', root, { WebOperatorPanel: { Config: '{ not json' } });
    });
    const plan = await planIn(f, 'Asset/Start', 'DB.Go');
    expect(plan.blockers).toEqual(['Operator panel "Asset/Broken": the operator panel config is not valid JSON.']);
  });
});

describe('rewrites', () => {
  it('operator panel: object configs, unchanged configs and unusual escaping', () => {
    const obj = { buttons: [{ signal: 'A' }], stackLight: [{ signal: 'B' }] };
    const r = rewriteOperatorPanelConfig(obj, 'A', 'Z');
    expect(r).toEqual({ kind: 'changed', value: { buttons: [{ signal: 'Z' }], stackLight: [{ signal: 'B' }] }, count: 1 });
    expect(obj.buttons[0].signal).toBe('A');
    expect(rewriteOperatorPanelConfig('{"buttons":[{"signal":"B"}]}', 'A', 'Z')).toEqual({ kind: 'unchanged' });
    expect(rewriteOperatorPanelConfig('{"buttons":[{"signal":"\\u0041"}]}', 'A', 'Z').kind).toBe('error');
  });

  it('metadata keeps white space and tag spelling', () => {
    expect(rewriteMetadataContent('<SIGNAL>  A </SIGNAL><signal>AB</signal>', 'A', 'Z'))
      .toEqual({ value: '<SIGNAL>  Z </SIGNAL><signal>AB</signal>', count: 1 });
  });
});

describe('usage index — plan-590 kinds (F6)', () => {
  it('metadata, carrier anchors, historian and literal mirror patterns are indexed', () => {
    const f = build();
    const index = buildSignalUsageIndex([
      { collect: (sink) => collectMetadataUsages(f.viewer, sink) },
      { collect: (sink) => collectSignalLinkAnchorUsages(f.viewer, sink) },
      { collect: (sink) => collectHistorianUsages(['DB.Start'], sink) },
      { collect: (sink) => collectConnectBridgeUsages({
        mappings: [],
        mirrors: [
          { enabled: true, sourceInterfaceId: 'S7', targetInterfaceId: 'MQTT', signalPattern: 'DB.Start' },
          { enabled: true, sourceInterfaceId: 'S7', targetInterfaceId: 'MQTT', signalPattern: 'DB.*' },
        ],
      }, [{ id: 'S7', signals: [] }], sink) },
    ]);
    const kinds = index.get('DB.Start').map((u) => `${u.kind}:${u.detail}`);
    expect(kinds).toEqual([
      'metadata:RuntimeMetadata <signal>',
      'binding:carrier anchor of a binding',
      'connect-mapping:literal pattern',
      'historian:selected trend series',
    ]);
    expect(index.get('DB.Other').map((u) => u.kind)).toEqual(['metadata']);
  });
});

describe('placement detection follows nested placement roots', () => {
  it('a nested placement root (_layoutNestedOf) blocks too', async () => {
    const f = makeRenameFixture((root) => {
      const nested = node('Inner', root);
      nested.userData._layoutNestedOf = 'outer';
      node('Sig', nested, plc('PLCInputBool', 'In.Sig'));
      node('Free', root, plc('PLCInputBool', 'Free.Sig'));
    });
    expect((await planIn(f, 'Asset/Inner/Sig', 'X')).blockers.join(' ')).toContain('placement');
    expect((await planIn(f, 'Asset/Free', 'X')).ok).toBe(true);
  });
});
