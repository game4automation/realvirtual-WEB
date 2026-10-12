// realvirtual WEB — SEW MOVI-C catalog preset (plan-457 follow-up).
//
// SEW is not a worker of its own but the MQTT worker in Json topic mode. The Add-Interface
// catalog still lists it as a product feature: a preset row of type MQTT whose defaults carry the
// two Json topics of a SEW station with exactly the symbol-table import defaults, so a later
// import replaces those topics by name instead of appending a second pair.
import { describe, expect, it } from 'vitest';
import { CONNECT_INTERFACE_TYPES, nextInterfaceId } from '../src/core/hmi/connect-store';
import {
  buildJsonTopicsFromRows,
  SEW_DEFAULT_PUBLISH_TOPIC,
  SEW_DEFAULT_RECEIVE_TOPIC,
  type SewSymbolRow,
} from '../src/core/import/sew-symbol-table';

describe('SEW MOVI-C catalog preset', () => {
  const sew = CONNECT_INTERFACE_TYPES.find((d) => d.preset === 'SEW');

  it('is an MQTT row with a preset marker and a distinct label', () => {
    expect(sew).toBeDefined();
    expect(sew!.type).toBe('MQTT');
    expect(sew!.label).toBe('SEW MOVI-C (MQTT Json)');
    const plainMqtt = CONNECT_INTERFACE_TYPES.filter((d) => d.type === 'MQTT' && !d.preset);
    expect(plainMqtt).toHaveLength(1);
  });

  it('keeps type+preset unique across the static registry', () => {
    const keys = CONNECT_INTERFACE_TYPES.map((d) => `${d.type}:${d.preset ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pre-fills the two Json topics with the import defaults, signals empty', () => {
    const rows: SewSymbolRow[] = [
      { name: 'ControlWord1', type: 'INT', direction: 'PLC_OUT', line: 1 },
      { name: 'StatusWord1', type: 'INT', direction: 'PLC_IN', line: 2 },
    ];
    const fromImport = buildJsonTopicsFromRows(rows).map(({ signals: _s, ...rest }) => rest);
    const fromPreset = (sew!.defaults.topics as Array<Record<string, unknown>>)
      .map(({ signals, ...rest }) => { expect(signals).toEqual([]); return rest; });
    expect(fromPreset).toEqual(fromImport);
    expect(fromPreset.map((t) => t.topic)).toEqual([SEW_DEFAULT_RECEIVE_TOPIC, SEW_DEFAULT_PUBLISH_TOPIC]);
  });

  it('names the generated interface id after the preset, not the worker type', () => {
    expect(nextInterfaceId('MQTT', 'SEW')).toBe('sew-1');
    expect(nextInterfaceId('MQTT')).toBe('mqtt-1');
  });
});
