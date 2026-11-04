// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2030 F1 — the DES hover tooltip: data resolver + `ui.tooltip` capability on the
 * material-flow registrations (schema adapter AND the Source/Sink engine factories).
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import '../src/core/engine/rv-source';
import '../src/core/engine/rv-sink';
import '../src/behaviors/Agv';
import { registerMaterialFlow } from '../src/core/material-flow/registry';
import { AGV_DEF } from './helpers/agv-harness';
import '../src/plugins/des/hmi/DESComponentTooltip';

function viewerWith(instances: Array<{ adapter: unknown }>, mode: 'des' | 'other' = 'des'): any {
  return {
    simulationKernel: { mode, activeExecutor: { liveInstances: instances, instances: () => instances } },
  };
}

describe('des-component tooltip data resolver', () => {
  const node = new Object3D();
  const other = new Object3D();
  const adapter = { node, path: 'Yard/Stapler_1' };

  it('is registered', () => {
    expect(tooltipRegistry.getDataResolver('des-component')).toBeTypeOf('function');
  });

  it('returns null without an active DES runner', () => {
    const resolve = tooltipRegistry.getDataResolver('des-component')!;
    expect(resolve(node, { simulationKernel: null } as any)).toBeNull();
    expect(resolve(node, viewerWith([{ adapter }], 'other'))).toBeNull();
  });

  it('returns null for a node without a DES instance', () => {
    const resolve = tooltipRegistry.getDataResolver('des-component')!;
    expect(resolve(other, viewerWith([{ adapter }]))).toBeNull();
  });

  it('returns the component path for a DES node', () => {
    const resolve = tooltipRegistry.getDataResolver('des-component')!;
    expect(resolve(node, viewerWith([{ adapter: { node: other, path: 'x' } }, { adapter }])))
      .toEqual({ type: 'des-component', componentPath: 'Yard/Stapler_1' });
  });
});

describe('ui.tooltip capability', () => {
  it('Source and Sink (engine factories) carry the tooltip and keep their capabilities', () => {
    const src = getCapabilities('Source');
    expect(src.ui.tooltip).toBe('des-component');
    expect(src.ui.badge).toBe('#ab47bc');
    expect(src.bake).toBe('keep');
    const sink = getCapabilities('Sink');
    expect(sink.ui.tooltip).toBe('des-component');
    expect(sink.ui.badge).toBe('#ef5350');
    expect(sink.bake).toBe('merge');
  });

  it('a schema-adapter material-flow type (Agv) carries the tooltip', () => {
    registerMaterialFlow(AGV_DEF);
    const agv = getCapabilities('Agv');
    expect(agv.ui.tooltip).toBe('des-component');
    expect(agv.ui.filter).toBe('MaterialFlow');
  });
});
