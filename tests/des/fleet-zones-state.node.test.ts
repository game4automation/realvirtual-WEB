import { describe, expect, it, vi } from 'vitest';
import { ZoneRegistry, type ZoneDeclarantCodec, type ZoneRegistryState } from '../../src/core/engine/rv-zone-registry';

function codecFor(paths: Array<{ id: string }>): ZoneDeclarantCodec {
  return { idOf: d => paths.find(p => p === d)?.id ?? null,
    resolve: id => paths.find(p => p.id === id) ?? null };
}
function fixture() {
  const registry = new ZoneRegistry(), paths = [{ id: 'a' }, { id: 'b' }], codec = codecFor(paths);
  registry.declare('cross', paths[0], 2); registry.declare('cross', paths[1]);
  registry.claim('cross', 'v1'); registry.claim('cross', 'v2');
  registry.redeclare('cross', paths[0], 1);
  registry.define('legacy', 2); registry.ensureZone('undeclared'); registry.define('zero', 0);
  registry.claim('empty', 'gone'); registry.releaseAll('gone');
  return { registry, paths, codec };
}
describe('ZoneRegistry state', () => {
  it('round trips insertion order, legacy, reduced capacity and empty indexes into a fresh world', () => {
    const { registry, codec, paths } = fixture(), text = JSON.stringify(registry.exportState(codec));
    const fresh = new ZoneRegistry(), newPaths = [{ id: 'a' }, { id: 'b' }], newCodec = codecFor(newPaths);
    fresh.swapState(fresh.prepareState(JSON.parse(text), newCodec));
    expect(JSON.stringify(fresh.exportState(newCodec))).toBe(text);
    expect(fresh.isDeclaredBy('cross', newPaths[0])).toBe(true);
    expect(fresh.isDeclaredBy('cross', paths[0])).toBe(false);
    expect(fresh.claim('cross', 'waiting')).toBe(false);
    const wake = vi.fn(() => { fresh.claim('cross', 'waiting'); });
    fresh.onAvailabilityChanged(wake);
    const prepared = fresh.prepareState(JSON.parse(text), newCodec);
    fresh.clear(); fresh.swapState(prepared);
    expect(wake).not.toHaveBeenCalled();
    fresh.release('cross', 'v1'); fresh.release('cross', 'v2');
    expect(wake).toHaveBeenCalledTimes(2);
    expect(fresh.isHolder('cross', 'waiting')).toBe(true);
  });
  it('detaches export and preparation', () => {
    const { registry, codec } = fixture(), state = registry.exportState(codec), text = JSON.stringify(state);
    registry.releaseAll('v1'); expect(JSON.stringify(state)).toBe(text);
    const prepared = registry.prepareState(state, codec);
    state.zones[0].holders.reverse(); state.zones[0].declarations[0].capacity = 99;
    state.byHolder[0].held.push('bad');
    registry.swapState(prepared); expect(JSON.stringify(registry.exportState(codec))).toBe(text);
  });
  it('reserves legacy identity and refuses unknown export identities', () => {
    const registry = new ZoneRegistry(); registry.define('legacy', 1);
    const codec = { idOf: vi.fn(() => null), resolve: vi.fn(() => null) };
    const state = registry.exportState(codec);
    registry.swapState(registry.prepareState(state, codec));
    expect(codec.idOf).not.toHaveBeenCalled(); expect(codec.resolve).not.toHaveBeenCalled();
    registry.declare('other', {}, 1);
    expect(() => registry.exportState(codec)).toThrow('zones: unknown declarant identity');
    expect(() => registry.exportState({ ...codec, idOf: () => '$legacy' })).toThrow();
  });
  const cases: Array<[string, (s: ZoneRegistryState) => void]> = [
    ['root extra', s => Object.assign(s, { extra: 1 })],
    ['root missing', s => Reflect.deleteProperty(s, 'zones')],
    ['zones type', s => Object.assign(s, { zones: null })],
    ['index type', s => Object.assign(s, { byHolder: null })],
    ['zone extra', s => Object.assign(s.zones[0], { extra: 1 })],
    ['zone missing', s => Reflect.deleteProperty(s.zones[0], 'holders')],
    ['duplicate zone', s => s.zones.push(s.zones[0])],
    ['empty zone id', s => { s.zones[0].id = ''; }],
    ['zone id type', s => Object.assign(s.zones[0], { id: 1 })],
    ['negative capacity', s => { s.zones[0].capacity = -1; }],
    ['fraction capacity', s => { s.zones[0].capacity = 0.5; }],
    ['infinite capacity', s => { s.zones[0].capacity = Infinity; }],
    ['capacity mismatch', s => { s.zones[0].capacity = 4; }],
    ['declarations type', s => Object.assign(s.zones[0], { declarations: null })],
    ['declaration extra', s => Object.assign(s.zones[0].declarations[0], { extra: 1 })],
    ['declaration missing', s => Reflect.deleteProperty(s.zones[0].declarations[0], 'capacity')],
    ['duplicate declarant', s => s.zones[0].declarations.push(s.zones[0].declarations[0])],
    ['unknown declarant', s => { s.zones[0].declarations[0].declarant = 'unknown'; }],
    ['empty declarant', s => { s.zones[0].declarations[0].declarant = ''; }],
    ['negative declaration', s => { s.zones[0].declarations[0].capacity = -1; }],
    ['holders type', s => Object.assign(s.zones[0], { holders: null })],
    ['duplicate holder', s => s.zones[0].holders.push('v1')],
    ['empty holder', s => s.zones[0].holders.push('')],
    ['missing index link', s => { s.byHolder[0].held = []; }],
    ['index extra', s => Object.assign(s.byHolder[0], { extra: 1 })],
    ['index missing', s => Reflect.deleteProperty(s.byHolder[0], 'held')],
    ['duplicate index', s => s.byHolder.push(s.byHolder[0])],
    ['held type', s => Object.assign(s.byHolder[0], { held: null })],
    ['unknown zone', s => s.byHolder[0].held.push('missing')],
    ['duplicate held', s => s.byHolder[0].held.push('cross')],
    ['missing holder link', s => { s.zones[0].holders = []; }],
    ['empty index id', s => { s.byHolder[0].holder = ''; }],
  ];
  it.each(cases)('rejects %s without mutation', (_name, mutate) => {
    const { registry, codec } = fixture(), state = registry.exportState(codec), text = JSON.stringify(state);
    mutate(state);
    expect(ZoneRegistry.validateState(state, codec).length).toBeGreaterThan(0);
    expect(() => registry.prepareState(state, codec)).toThrow();
    expect(JSON.stringify(registry.exportState(codec))).toBe(text);
  });
});
