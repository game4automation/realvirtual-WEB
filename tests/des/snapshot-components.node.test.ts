// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESComponent } from '../../src/plugins/des/rv-des-component';
import { lineFixture } from './runner-fixture';

function world() {
  const f = lineFixture();
  const owner = new DESComponent(f.station.node);
  f.manager.registerComponent(owner);
  const off = f.runner.registerSnapshotComponents('test.owner', ({ addressOf }) =>
    new Map([[`${addressOf(owner.node)}@Owner`, owner]]));
  return { ...f, owner, off };
}

describe('extra snapshot components', () => {
  it('uses stable addresses across worlds without changing model identity', () => {
    const a = world(), b = world();
    const saved = a.snapshot();
    expect(saved.parts.map(p => p.key)).toEqual(b.snapshot().parts.map(p => p.key));
    expect(saved.parts.some(p => p.key === '#Station@Owner')).toBe(true);
    b.restore(JSON.parse(JSON.stringify(saved)));
    const identity = a.runner.desIdentity();
    a.off(); a.off();
    expect(a.runner.desIdentity()).toEqual(identity);
    expect(() => a.restore(saved)).toThrow();
  });
  it('refuses duplicate provider and component ids', () => {
    const f = world();
    expect(() => f.runner.registerSnapshotComponents('test.owner', () => new Map())).toThrow(/duplicate/);
    f.runner.registerSnapshotComponents('other', () => new Map([['#Station@Owner', new DESComponent(new Object3D())]]));
    expect(() => f.snapshot()).toThrow(/duplicate/);
  });
  it('refuses unaddressable nodes', () => {
    const f = lineFixture();
    const missing = new Object3D();
    const original = f.host.desAddresses.getAddressForNode;
    f.host.desAddresses.getAddressForNode = node => node === missing ? null! : original(node);
    f.runner.registerSnapshotComponents('missing', ({ addressOf }) => {
      addressOf(missing);
      return new Map();
    });
    expect(() => f.snapshot()).toThrow(/des-snapshot-unaddressable/);
  });
  it('detects hidden owner state rather than silently dropping it', () => {
    const f = world();
    Object.defineProperty(f.owner, 'hidden', { value: 42 });
    expect(() => f.snapshot()).toThrow(/hidden|not.declared|unclassified/);
  });
});
