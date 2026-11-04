// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** "+ Add KPI" offers numeric fields of material-flow instances and the runtime counters, nothing else. */
import { expect, it } from 'vitest';
import { kpiPropertyOptions, type KpiPropertyCandidate } from '../../src/plugins/sim-controller/des-kpi-defs';

const field = (address: string, component: string, f: string, value: number | boolean | null): KpiPropertyCandidate =>
  ({ address, path: address.slice(1), component, field: f, value });
const fields = [
  field('#sink1', 'Sink', 'Capacity', 4), field('#sink2', 'Sink', 'Capacity', 4),
  field('#sink1', 'Sink', 'Active', true),                       // boolean
  field('#agv', 'Agv', 'Speed', 1.2), field('#agv', 'Agv', 'Active', false),
  field('#sink1', 'LayoutObject', 'Locked', 0), field('#path', 'Path', 'version', 2), field('#sink1', 'NodeId', 'Seed', 3),
  field('#sink1', 'Sink', 'version', 1), field('#sink1', 'Sink', 'id', 7), field('#sink1', 'Sink', 'TargetId', 9),
  field('#lamp', 'Lamp', 'Intensity', 5),                         // not a material-flow instance
  field('#sink1', 'Sink', 'Name', null),
];
const runtime = [
  { address: '#sink1', path: 'sink1', component: 'Sink', field: 'TotalProcessed', value: 0 },
  { address: '#sink2', path: 'sink2', component: 'Sink', field: 'TotalProcessed', value: 0 },
  { address: '#sink1', path: 'sink1', component: 'Sink', field: 'Capacity', value: 4 },   // also a field: listed once
  { address: '#agv', path: 'agv', component: 'Agv', field: 'TotalProcessed', value: 0 },
  { address: '#agv', path: 'agv', component: 'Agv', field: 'routeId', value: 3 },
];
const keys = (list: KpiPropertyCandidate[]) => list.map(p => `${p.address} ${p.component}.${p.field}`).sort();

it('keeps numeric fields of running DES instances plus their runtime counters', () => {
  expect(keys(kpiPropertyOptions(fields, runtime, () => false))).toEqual([
    '#agv Agv.Speed', '#agv Agv.TotalProcessed', '#sink1 Sink.Capacity', '#sink1 Sink.TotalProcessed',
    '#sink2 Sink.Capacity', '#sink2 Sink.TotalProcessed',
  ]);
});
it('without a running DES model the registered material-flow types decide', () => {
  expect(keys(kpiPropertyOptions(fields, [], c => c === 'Sink' || c === 'Agv'))).toEqual([
    '#agv Agv.Speed', '#sink1 Sink.Capacity', '#sink2 Sink.Capacity',
  ]);
});
