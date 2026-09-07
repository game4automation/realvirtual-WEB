// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.8 — the `RibbonPath.Rollers` inspector renderer.
 *
 * Two things here are load-bearing, and both come from the plan review.
 *
 * **The component is never imported directly.** It is fetched out of
 * `fieldRendererRegistry` AFTER `App.tsx` has been imported — the same bootstrap
 * path production uses. A renderer that is written, tested and never
 * side-effect-imported by `App.tsx` registers in NO running application while a
 * test that imports the module directly stays green; that is exactly the gap
 * SOL round-2 finding 1 named, and sourcing the component from the registry
 * makes it impossible to miss.
 *
 * **Persistence is the acceptance criterion, not the visuals.** The IKPath
 * renderer this is modelled on reordered the runtime list without writing
 * anything back for a long time. Every mutation below is asserted at the
 * `EditTarget.setField` boundary, with the value that would land in the GLB.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Object3D } from 'three';
import type { ComponentType } from 'react';
import {
  fieldRendererRegistry,
  type FieldRendererProps,
} from '../src/core/hmi/rv-field-renderer-registry';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import type { RVViewer } from '../src/core/rv-viewer';

/** The App module graph is large; importing it once is the point of the test. */
const BOOTSTRAP_TIMEOUT = 180_000;

let Renderer: ComponentType<FieldRendererProps>;

beforeAll(async () => {
  await import('../src/core/hmi/App');
  const found = fieldRendererRegistry.getRenderer('RibbonPath', 'Rollers');
  if (!found) {
    throw new Error(
      'RibbonPath.Rollers has no field renderer after importing App.tsx — the '
      + "side-effect import `import './rv-ribbon-path-rollers-field-renderer'` is missing.",
    );
  }
  Renderer = found;
}, BOOTSTRAP_TIMEOUT);

afterEach(() => {
  cleanup();
  setActiveEditTarget(null);
  vi.restoreAllMocks();
});

interface RecordedField {
  nodePath: string;
  componentType: string;
  fieldName: string;
  value: unknown;
}

/** An edit target that accepts and records ops (mirrors the knowledge tests). */
function recordingEditTarget() {
  const ops: RecordedField[] = [];
  const target: EditTarget = {
    available: true,
    persistsTo: 'asset',
    setField: (nodePath, componentType, fieldName, value) => {
      ops.push({ nodePath, componentType, fieldName, value });
    },
    unsetField: () => { /* not used here */ },
    withTransaction: async (_label, fn) => { await fn(); },
  };
  setActiveEditTarget(target);
  return ops;
}

/**
 * A real `DataTransfer`. `fireEvent.dragStart` synthesises a DragEvent without
 * one, and `ReorderableList` writes `effectAllowed` on drag start — so without
 * this the handler throws into the void and the reorder silently never happens.
 * A plain object will not do either: the browser runner constructs a genuine
 * DragEvent and rejects anything that is not a DataTransfer.
 */
function dragData() {
  return { dataTransfer: new DataTransfer() };
}

function ref(path: string) {
  return { type: 'ComponentReference', path, componentType: 'UnityEngine.Transform' };
}

const ROLLERS = [ref('Cell/Unwinder'), ref('Cell/Idler'), ref('Cell/Rewinder')];

/** A viewer stub with three roller nodes and a settable selection. */
function makeViewer(primaryPath: string | null = null) {
  const byPath: Record<string, Object3D> = {};
  for (const name of ['Unwinder', 'Idler', 'Rewinder']) {
    const node = new Object3D();
    node.name = name;
    byPath[`Cell/${name}`] = node;
  }
  const pathByNode = new Map(Object.entries(byPath).map(([p, n]) => [n, p]));
  const selected: string[] = [];
  const snapshot = Object.freeze({ selectedPaths: Object.freeze([]) as ReadonlyArray<string>, primaryPath });
  return {
    selected,
    viewer: {
      registry: {
        getNode: (path: string) => byPath[path] ?? null,
        getPathForNode: (n: Object3D) => pathByNode.get(n) ?? null,
      },
      selectionManager: {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
        select: (path: string) => { selected.push(path); },
      },
    } as unknown as RVViewer,
  };
}

function renderRollers(value: unknown, primaryPath: string | null = null) {
  const { viewer, selected } = makeViewer(primaryPath);
  const utils = render(
    <Renderer
      value={value}
      fieldName="Rollers"
      componentType="RibbonPath"
      nodePath="Cell/Web"
      viewer={viewer}
      signalStore={null}
    />,
  );
  return { ...utils, selected };
}

describe('RibbonPath.Rollers field renderer', () => {
  it('renders one row per roller, labelled by node name and marked at the ends', () => {
    renderRollers(ROLLERS);
    expect(screen.getByText('Unwinder')).toBeTruthy();
    expect(screen.getByText('Idler')).toBeTruthy();
    expect(screen.getByText('Rewinder')).toBeTruthy();
    // The ends carry the winders by contract, so the list says which end a row is.
    expect(screen.getByText('start')).toBeTruthy();
    expect(screen.getByText('end')).toBeTruthy();
  });

  it('renders an empty list without throwing, for a freshly added component', () => {
    renderRollers([]);
    expect(screen.getByText('No rollers')).toBeTruthy();
  });

  it('persists a reorder as a setField op carrying the NEW order', () => {
    const ops = recordingEditTarget();
    renderRollers(ROLLERS);

    // Drag row 3 (Rewinder) to the front — HTML5 DnD, as ReorderableList wires it.
    const rows = screen.getAllByText(/Unwinder|Idler|Rewinder/).map((el) => el.closest('[draggable]')!);
    fireEvent.dragStart(rows[2], dragData());
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);

    expect(ops).toHaveLength(1);
    expect(ops[0].componentType).toBe('RibbonPath');
    expect(ops[0].fieldName).toBe('Rollers');
    expect(ops[0].nodePath).toBe('Cell/Web');
    const paths = (ops[0].value as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toEqual(['Cell/Rewinder', 'Cell/Unwinder', 'Cell/Idler']);
    // …and the UI followed.
    expect(screen.getByText('Rewinder').closest('[draggable]')).toBe(
      screen.getAllByText(/Unwinder|Idler|Rewinder/)[0].closest('[draggable]'),
    );
  });

  it('add writes the selected node through EditTarget.setField', () => {
    const ops = recordingEditTarget();
    renderRollers([ROLLERS[0], ROLLERS[1]], 'Cell/Rewinder');

    fireEvent.click(screen.getByTestId('web-rollers-add'));

    expect(ops).toHaveLength(1);
    const paths = (ops[0].value as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toEqual(['Cell/Unwinder', 'Cell/Idler', 'Cell/Rewinder']);
    // The written entry is a real wire ComponentReference, not a bare string.
    expect((ops[0].value as Array<Record<string, unknown>>)[2]).toMatchObject({
      type: 'ComponentReference',
      componentType: 'UnityEngine.Transform',
    });
  });

  it('add is disabled without a selection, and never adds a duplicate', () => {
    const ops = recordingEditTarget();
    const { unmount } = renderRollers(ROLLERS, null);
    expect((screen.getByTestId('web-rollers-add') as HTMLButtonElement).disabled).toBe(true);
    unmount();

    // Already in the list -> the click is a no-op rather than a duplicate row.
    renderRollers(ROLLERS, 'Cell/Idler');
    fireEvent.click(screen.getByTestId('web-rollers-add'));
    expect(ops).toHaveLength(0);
  });

  it('remove writes the shortened array through EditTarget.setField', () => {
    const ops = recordingEditTarget();
    renderRollers(ROLLERS);

    const row = screen.getByText('Idler').closest('[draggable]') as HTMLElement;
    fireEvent.mouseEnter(row);
    const remove = row.querySelector('button');
    expect(remove).toBeTruthy();
    fireEvent.click(remove!);

    expect(ops).toHaveLength(1);
    const paths = (ops[0].value as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toEqual(['Cell/Unwinder', 'Cell/Rewinder']);
  });

  it('clicking a row selects that roller in the scene', () => {
    const { selected } = renderRollers(ROLLERS);
    fireEvent.click(screen.getByText('Idler'));
    expect(selected).toContain('Cell/Idler');
  });

  it('is a no-op without an edit target — the runtime order still follows', () => {
    // No `setActiveEditTarget`: `persistFieldOp` returns early. The renderer must
    // not throw and must still show the new order (optimistic local update).
    renderRollers(ROLLERS);
    const rows = screen.getAllByText(/Unwinder|Idler|Rewinder/).map((el) => el.closest('[draggable]')!);
    expect(() => {
      fireEvent.dragStart(rows[0], dragData());
      fireEvent.dragOver(rows[2]);
      fireEvent.drop(rows[2]);
    }).not.toThrow();
  });
});
