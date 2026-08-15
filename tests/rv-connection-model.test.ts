// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-model.test.ts — plan-259 §9.1.
 *
 * Connection data model: defensive extras parsing (old GLBs unchanged),
 * adjacency index incl. 1:n fan-out, fan-out dispatch, and the persistence
 * round-trip through the op log (materialise).
 */

import { describe, it, expect } from 'vitest';
import {
  RVConnectionRegistry,
  parseConnectionsExtras,
  parseConnection,
  parseConnectionType,
  validateConnectionParams,
  type RvConnection,
} from '../src/core/engine/rv-connection-registry';
import { materialise, inverseOp, type AddConnectionOp, type RemoveConnectionOp, type SetConnectionTypeOp } from '../src/core/hmi/scene/rv-scene-edits';
import { describeRvOp } from '../src/core/ops/rv-unified-ops';

const edge = (id: string, source: string, target: string, type = 'StopOnExit'): RvConnection =>
  ({ id, source, target, type });

describe('connections extras parsing (defensive, backward compatible)', () => {
  it('missing / malformed block yields the empty result (old GLBs unchanged)', () => {
    expect(parseConnectionsExtras(undefined)).toEqual({ connections: [], connectionTypes: [] });
    expect(parseConnectionsExtras(null)).toEqual({ connections: [], connectionTypes: [] });
    expect(parseConnectionsExtras(42)).toEqual({ connections: [], connectionTypes: [] });
    expect(parseConnectionsExtras([])).toEqual({ connections: [], connectionTypes: [] });
  });

  it('parses well-formed edges + types and skips malformed entries', () => {
    const parsed = parseConnectionsExtras({
      connections: [
        { id: 'c1', source: 'Line/Sensor', target: 'Cell/Scanner', type: 'StopOnExit', config: { ProcessTime: 3 } },
        { id: '', source: 'x', target: 'y', type: 'z' },          // missing id
        { source: 'x', target: 'y', type: 'z' },                  // no id
        'garbage',
      ],
      connectionTypes: [
        { type: 'QualityCheck', request: { partId: 'int' }, response: { pass: 'bool' } },
        { request: {} },                                          // no type name
        { type: 'Weird', request: { a: 'not-a-type' } },          // bad param type dropped
      ],
    });
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.connections[0].config).toEqual({ ProcessTime: 3 });
    expect(parsed.connectionTypes).toHaveLength(2);
    expect(parsed.connectionTypes[0].request).toEqual({ partId: 'int' });
    expect(parsed.connectionTypes[1].request).toBeUndefined();
  });

  it('parseConnection / parseConnectionType null on structural garbage', () => {
    expect(parseConnection(null)).toBeNull();
    expect(parseConnection({ id: 'a', source: 'b', target: 'c' })).toBeNull(); // no type
    expect(parseConnectionType({ type: '' })).toBeNull();
  });
});

describe('adjacency index (1:n)', () => {
  it('outOf/into reflect fan-out and fan-in', () => {
    const reg = new RVConnectionRegistry();
    reg.loadModel({
      connections: [
        edge('c1', 'A', 'S1'),
        edge('c2', 'A', 'S2'),   // 1:n fan-out from A
        edge('c3', 'B', 'S1'),   // n:1 fan-in on S1
      ],
      connectionTypes: [],
    });
    expect(reg.outOf('A').map((e) => e.id)).toEqual(['c1', 'c2']);
    expect(reg.into('S1').map((e) => e.id)).toEqual(['c1', 'c3']);
    expect(reg.outOf('S1')).toEqual([]);
    expect(reg.into('Unknown')).toEqual([]);
  });

  it('index self-heals after add/remove', () => {
    const reg = new RVConnectionRegistry();
    reg.addConnection(edge('c1', 'A', 'B'));
    expect(reg.outOf('A')).toHaveLength(1);
    reg.removeConnection('c1');
    expect(reg.outOf('A')).toHaveLength(0);
  });
});

describe('fan-out dispatch (1:n)', () => {
  it('call reaches every connected endpoint of the type', () => {
    const reg = new RVConnectionRegistry();
    reg.setConnectionType({ type: 'Ping', request: { n: 'int' } });
    reg.loadModel({
      connections: [edge('c1', 'A', 'S1', 'Ping'), edge('c2', 'A', 'S2', 'Ping'), edge('c3', 'A', 'S3', 'Other')],
      connectionTypes: [{ type: 'Ping', request: { n: 'int' } }],
    });
    const got: string[] = [];
    reg.registerEndpoint('S1', { onRequest: (t, p) => got.push(`S1:${t}:${p.n}`) });
    reg.registerEndpoint('S2', { onRequest: (t, p) => got.push(`S2:${t}:${p.n}`) });
    const delivered = reg.call('A', 'Ping', { n: 7 }, null);
    expect(delivered).toBe(2);
    expect(got).toEqual(['S1:Ping:7', 'S2:Ping:7']);
  });

  it('unresolved target (no endpoint) is inactive — request dropped, no throw', () => {
    const reg = new RVConnectionRegistry();
    reg.addConnection(edge('c1', 'A', 'Missing', 'Ping'));
    expect(reg.call('A', 'Ping', {}, null)).toBe(0);
  });
});

describe('parameter validation', () => {
  it('fills missing params with defaults and coerces type mismatches', () => {
    const out = validateConnectionParams(
      { partId: 'int', label: 'string', ok: 'bool', ratio: 'float' },
      { partId: 'nope', ratio: 1.5 },
      'test',
    );
    expect(out).toEqual({ partId: 0, label: '', ok: false, ratio: 1.5 });
  });

  it('passes params through untouched without a schema', () => {
    expect(validateConnectionParams(undefined, { anything: 1 }, 'test')).toEqual({ anything: 1 });
  });
});

describe('persistence round-trip (op log → materialise)', () => {
  const base = { ts: Date.now(), schemaV: 1 as const };

  it('add / remove / setConnectionType fold into the materialised arrays', () => {
    const add1: AddConnectionOp = { ...base, id: 'op1', kind: 'addConnection', connection: edge('c1', 'A', 'B') };
    const add2: AddConnectionOp = { ...base, id: 'op2', kind: 'addConnection', connection: edge('c2', 'A', 'C') };
    const rem: RemoveConnectionOp = { ...base, id: 'op3', kind: 'removeConnection', connectionId: 'c1', connection: edge('c1', 'A', 'B') };
    const setT: SetConnectionTypeOp = {
      ...base, id: 'op4', kind: 'setConnectionType',
      connectionType: { type: 'QC', request: { partId: 'int' } }, prev: undefined,
    };

    const mat = materialise([add1, add2, rem, setT]);
    expect(mat.connections.map((c) => c.id)).toEqual(['c2']);
    expect(mat.connectionTypes).toEqual([{ type: 'QC', request: { partId: 'int' } }]);
    // Existing shapes untouched (backward compat).
    expect(mat.overlay.nodes).toEqual({});
    expect(mat.placements).toEqual([]);
  });

  it('inverseOp round-trips add↔remove and set↔remove type', () => {
    const add: AddConnectionOp = { ...base, id: 'op1', kind: 'addConnection', connection: edge('c1', 'A', 'B') };
    const inv = inverseOp(add);
    expect(inv.kind).toBe('removeConnection');
    const invInv = inverseOp(inv);
    expect(invInv.kind).toBe('addConnection');

    const setNew: SetConnectionTypeOp = {
      ...base, id: 'op2', kind: 'setConnectionType', connectionType: { type: 'QC' }, prev: undefined,
    };
    expect(inverseOp(setNew).kind).toBe('removeConnectionType');
    const setEdit: SetConnectionTypeOp = {
      ...base, id: 'op3', kind: 'setConnectionType',
      connectionType: { type: 'QC', request: { a: 'int' } }, prev: { type: 'QC' },
    };
    const invEdit = inverseOp(setEdit);
    expect(invEdit.kind).toBe('setConnectionType');
  });

  it('describeRvOp yields readable labels', () => {
    const add: AddConnectionOp = { ...base, id: 'op1', kind: 'addConnection', connection: edge('c1', 'Line/Sensor', 'Cell/Scanner') };
    expect(describeRvOp(add)).toContain('Sensor');
    expect(describeRvOp(add)).toContain('Scanner');
    expect(describeRvOp(add)).toContain('StopOnExit');
  });
});
