// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2030 F1 — hover through the REAL GenericTooltipController with the real registrations
 * (library `*Behavior` marker keys as measured on the PalletYard demo) and an active DES runner stub.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import { act, cleanup, render } from '@testing-library/react';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

let hoverState: any = null;
vi.mock('../src/hooks/use-hover', () => ({ useHoveredObject: () => hoverState }));
vi.mock('../src/hooks/use-drives', () => ({ useFocusedDrive: () => ({ drive: null, node: null }) }));
vi.mock('../src/hooks/use-selection', () => ({ useSelection: () => ({ selectedPaths: [] }) }));

await import('../src/core/engine/rv-source');
await import('../src/core/engine/rv-sink');
await import('../src/core/engine/rv-drive');
await import('../src/behaviors/Conveyor');
await import('../src/behaviors/Sink');
await import('../src/behaviors/Source');
await import('../src/behaviors/Agv');
const { GenericTooltipController } = await import('../src/core/hmi/tooltip/GenericTooltipController');
const { DESComponentTooltipContent } = await import('../src/plugins/des/hmi/DESComponentTooltip');

// Keep Drive's real capability registration, with deterministic data for the child hover.
tooltipRegistry.registerDataResolver('drive', (node) => ({ type: 'drive', driveName: node.name }));

afterEach(() => { cleanup(); tooltipStore.hideAll(); hoverState = null; });

function comp(node: Object3D, path: string) {
  return {
    node, path, MaxCapacity: 4,
    def: { kind: 'conveyor' },
    getStatistics: () => ({
      workingPercent: 40, setupPercent: 0, blockedPercent: 10, emptyPercent: 0, failurePercent: 0,
      currentLoad: 1, utilization: 40, outputPerHour: 123, totalProcessed: 7, currentState: 'Working',
    }),
  };
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ['Conveyor_V1', { NodeId: 'a', ConveyorBehavior: { Belt: 'b' }, PalletYardStation: { Station: 's' }, __BehaviorSignals: {} }],
  ['Sink_V2', { NodeId: 'a', SinkBehavior: {}, __BehaviorSignals: {}, LayoutObject: {} }],
  ['Source_V1', { NodeId: 'a', SourceBehavior: {}, LayoutObject: {} }],
  ['Stapler_1', { NodeId: 'a', Agv: {}, AgvBehavior: { Path: 'p' }, LayoutObject: {} }],
];

describe('DES hover tooltip through GenericTooltipController', () => {
  for (const depth of [1, 2, 4, 5]) {
    for (const withKey of [false, true]) {
      it(`falls back for a child ${depth} levels below DES only within four ancestors (key: ${withKey})`, () => {
        const node = new Object3D(); node.name = 'Conveyor';
        node.userData.realvirtual = { ConveyorBehavior: {} };
        let hovered = node;
        for (let i = 0; i < depth; i++) {
          const child = new Object3D(); child.name = `Part${i}`;
          hovered.add(child); hovered = child;
        }
        if (withKey) {
          expect(getCapabilities('LayoutObject').ui.tooltip).toBeNull();
          hovered.userData.realvirtual = { LayoutObject: {} };
        }
        const instances = [{ adapter: comp(node, 'Yard/Conveyor') }];
        const viewer = { simulationKernel: { mode: 'des', activeExecutor: { liveInstances: instances, instances: () => instances } } } as unknown as RVViewer;
        hoverState = { node: hovered, nodeType: 'x', nodePath: `Yard/Conveyor/Part${depth - 1}`, pointer: { x: 1, y: 2 }, hitPoint: null, mesh: hovered };
        render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);

        const entries = tooltipStore.getSnapshot().visible.flatMap((b) => b.contentEntries);
        if (depth > 4) {
          expect(entries).toEqual([]);
        } else {
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            id: 'tooltip-hover:des-component',
            lifecycle: 'hover',
            targetPath: hoverState.nodePath,
            mode: 'cursor',
            cursorPos: { x: 1, y: 2 },
            priority: getCapabilities('ConveyorBehavior').ui.priority,
            data: { type: 'des-component', componentPath: 'Yard/Conveyor' },
          });
        }
      });
    }
  }

  it('keeps a child Drive tooltip without adding its DES ancestor tooltip', () => {
    const node = new Object3D(); node.userData.realvirtual = { ConveyorBehavior: {} };
    const child = new Object3D(); child.name = 'Drive'; child.userData.realvirtual = { Drive: {} };
    node.add(child);
    expect(getCapabilities('Drive').ui.tooltip).toBe('drive');
    const instances = [{ adapter: comp(node, 'Yard/Conveyor') }];
    const viewer = { simulationKernel: { mode: 'des', activeExecutor: { liveInstances: instances, instances: () => instances } } } as unknown as RVViewer;
    hoverState = { node: child, nodeType: 'x', nodePath: 'Yard/Conveyor/Drive', pointer: { x: 1, y: 2 }, hitPoint: null, mesh: child };
    render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);

    const ids = tooltipStore.getSnapshot().visible.flatMap((b) => b.contentEntries.map((e) => e.id));
    expect(ids).toContain('tooltip-hover:drive');
    expect(ids).not.toContain('tooltip-hover:des-component');
  });

  for (const [name, rv] of CASES) {
    for (const via of ['node', 'child'] as const) {
      it(`${name} (${via} hovered) shows state and Output/h`, async () => {
        const node = new Object3D(); node.name = name; node.userData.realvirtual = rv;
        const hovered = via === 'node' ? node : (() => {
          const c = new Object3D(); c.name = 'Part'; c.userData.realvirtual = { Sink: {} }; node.add(c); return c;
        })();
        // a child hover must resolve via the nearest DES ancestor; its own key is irrelevant for Conveyor
        if (via === 'child') hovered.userData.realvirtual = { Sink: {} };
        const instances = [{ adapter: comp(node, `Yard/${name}`) }];
        const viewer = { simulationKernel: { mode: 'des', activeExecutor: { liveInstances: instances, instances: () => instances } } } as unknown as RVViewer;
        hoverState = { node: hovered, nodeType: 'x', nodePath: `Yard/${name}`, pointer: { x: 1, y: 2 }, hitPoint: null, mesh: hovered };
        render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);

        const ids = tooltipStore.getSnapshot().visible.flatMap((b) => b.contentEntries.map((e) => e.id));
        expect(ids).toContain('tooltip-hover:des-component');
        const entry = tooltipStore.getSnapshot().visible.flatMap((b) => b.contentEntries)
          .find((e) => e.id === 'tooltip-hover:des-component')!;
        expect(entry.data.type).toBe('des-component');

        const out = render(<DESComponentTooltipContent data={entry.data as any} viewer={viewer} />);
        await act(async () => {});
        expect(out.container.textContent).toContain('Working');
        expect(out.container.textContent).toContain('Output');
        expect(out.container.textContent).toContain('123 /h');
      });
    }
  }

  for (const via of ['node', 'child'] as const) {
    it(`shows nothing outside DES mode (${via} hovered)`, () => {
      const node = new Object3D(); node.userData.realvirtual = CASES[0][1];
      const hovered = via === 'node' ? node : new Object3D();
      if (via === 'child') node.add(hovered);
      const instances = [{ adapter: comp(node, 'Yard/x') }];
      const viewer = { simulationKernel: { mode: 'other', activeExecutor: { liveInstances: instances, instances: () => instances } } } as unknown as RVViewer;
      hoverState = { node: hovered, nodeType: 'x', nodePath: 'Yard/x', pointer: { x: 1, y: 2 }, hitPoint: null, mesh: hovered };
      render(<RVViewerProvider value={viewer}><GenericTooltipController /></RVViewerProvider>);
      expect(tooltipStore.getSnapshot().visible).toEqual([]);
    });
  }
});
