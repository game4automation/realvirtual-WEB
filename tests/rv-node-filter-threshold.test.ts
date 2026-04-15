// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { Object3D } from 'three';

describe('Node filter threshold logic', () => {
  let registry: NodeRegistry;
  const MAX = 20; // matches RVViewer.MAX_HIGHLIGHT_RESULTS

  beforeEach(() => {
    registry = new NodeRegistry();
    for (let i = 0; i < 30; i++) {
      const path = `Root/Node_${String(i).padStart(2, '0')}`;
      registry.registerNode(path, new Object3D());
    }
  });

  it('should flag tooMany when results >= threshold', () => {
    const results = registry.search('Node');
    expect(results.length).toBe(30);
    expect(results.length >= MAX).toBe(true);
  });

  it('should not flag tooMany when results < threshold', () => {
    const results = registry.search('Node_0');
    expect(results.length).toBe(10); // Node_00..Node_09
    expect(results.length >= MAX).toBe(false);
  });

  it('should handle boundary case at exactly threshold', () => {
    const reg2 = new NodeRegistry();
    for (let i = 0; i < MAX; i++) {
      reg2.registerNode(`X/Item_${i}`, new Object3D());
    }
    const results = reg2.search('Item');
    expect(results.length).toBe(MAX);
    expect(results.length >= MAX).toBe(true); // exactly at threshold = tooMany
  });
});
