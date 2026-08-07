// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-373 F1–F4 — one resolution marking, six surfaces, one answer.
 *
 * The bug this covers: the CONNECT embed ships AAS links but no `aasx/` folder,
 * so hovering any motor produced a red `AAS ID not found in index`. The fix hides
 * every AAS surface for the two states that mean "there is nothing to show"
 * (`unknown-id`, `index-missing`) while keeping `index-error` visible, so a broken
 * deployment is never silently swallowed.
 *
 * Structured as a state matrix rather than as one test per bug: the failure mode
 * that started this plan was ONE surface being forgotten.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import {
  AasDetailHeaderAction,
  AasLinkPlugin,
  AasTooltipContent,
  findGatedAasAtPoint,
  openDocModeDetailAtPoint,
} from '../src/plugins/aas-link-plugin';
import {
  AAS_RESOLUTION_KEY,
  beginAasLoadGeneration,
  classifyAas,
  currentAasLoadGeneration,
  getAasResolution,
  isAasUnresolvable,
  isAasVisible,
  resetAasResolution,
  resolveAasSubtree,
  type AasResolution,
} from '../src/plugins/aas-resolution';
import { resetIndex, resetCache } from '../src/plugins/aas-link-parser';
import { attachDriveDatasheets, SEW_DRIVE_AAS } from '../src/behaviors/_shared/aas-link';
import { OrderManagerPlugin, _resetOrderStore } from '../src/plugins/order-manager-plugin';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';

const AAS_ID = 'urn:test:motor';
const OTHER_ID = 'urn:test:other';
const INDEX = { [AAS_ID]: { file: 'motor.aasx', idShort: 'Motor' } };

/** Every state a resolution can be in, with the visibility the plan mandates. */
const STATES: Array<{ state: AasResolution; visible: boolean }> = [
  { state: 'resolved', visible: true },
  { state: 'unknown-id', visible: false },
  { state: 'index-missing', visible: false },
  { state: 'index-error', visible: true },
  { state: 'pending', visible: false },
];

const HIDDEN_STATES = STATES.filter(s => !s.visible).map(s => s.state);

// ─── Fixtures ───────────────────────────────────────────────────────────

function aasNode(resolution: AasResolution, opts: { gated?: boolean; aasId?: string } = {}): Object3D {
  const node = new Object3D();
  node.name = 'Motor';
  node.userData._rvAasLink = {
    aasId: opts.aasId ?? AAS_ID,
    description: 'Test Motor',
    gated: opts.gated ?? false,
  };
  node.userData[AAS_RESOLUTION_KEY] = resolution;
  return node;
}

/** A gated motor with real geometry so the doc-mode bbox search can hit it. */
function gatedMotorScene(resolution: AasResolution): { root: Object3D; motor: Object3D } {
  const motor = aasNode(resolution, { gated: true });
  motor.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  motor.position.set(10, 0, 0);
  const root = new Object3D();
  root.add(motor);
  root.updateMatrixWorld(true);
  return { root, motor };
}

function viewerWithScene(root: Object3D): any {
  return {
    scene: root,
    highlighter: { clear: vi.fn(), highlightMultiple: vi.fn() },
    on: () => () => undefined,
    getPlugin: () => undefined,
    registry: { getNode: (path: string) => (path === 'Motor' ? root.children[0] : null) },
  };
}

function mockIndexFetch(body: BodyInit | null, init: ResponseInit): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, init));
}

beforeEach(() => {
  resetIndex();
  resetCache();
  resetAasResolution();
  _resetOrderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── The contract itself ────────────────────────────────────────────────

describe('resolution contract', () => {
  it.each(STATES)('$state decides visibility as the plan mandates', ({ state, visible }) => {
    expect(isAasVisible(state)).toBe(visible);
  });

  it('hides exactly the two "nothing to show" states, never the error state', () => {
    expect(isAasUnresolvable('unknown-id')).toBe(true);
    expect(isAasUnresolvable('index-missing')).toBe(true);
    expect(isAasUnresolvable('index-error')).toBe(false);
    expect(isAasUnresolvable('resolved')).toBe(false);
  });

  it('treats an unmarked AAS node as pending, never as resolved', () => {
    const node = new Object3D();
    node.userData._rvAasLink = { aasId: AAS_ID };
    expect(getAasResolution(node)).toBe('pending');
  });

  it('classifies each index outcome', () => {
    expect(classifyAas({ kind: 'available', index: INDEX }, AAS_ID)).toBe('resolved');
    expect(classifyAas({ kind: 'available', index: INDEX }, OTHER_ID)).toBe('unknown-id');
    expect(classifyAas({ kind: 'missing' }, AAS_ID)).toBe('index-missing');
    expect(classifyAas({ kind: 'error', reason: 'boom' }, AAS_ID)).toBe('index-error');
  });
});

// ─── Surface 1: tooltip data resolver (hover + pinned + its cart button) ──

describe('surface: tooltip', () => {
  const resolver = tooltipRegistry.getDataResolver('aas')!;

  it('resolves tooltip data for a resolvable link', () => {
    const node = aasNode('resolved');
    expect(resolver(node, viewerWithScene(node))).toMatchObject({ type: 'aas', aasId: AAS_ID });
  });

  it('keeps the tooltip for a visible index error — a broken deploy must not be masked', () => {
    const node = aasNode('index-error');
    expect(resolver(node, viewerWithScene(node))).toMatchObject({ type: 'aas' });
  });

  it.each(HIDDEN_STATES)('opens no tooltip at all when the resolution is %s', (state) => {
    const node = aasNode(state);
    expect(resolver(node, viewerWithScene(node))).toBeNull();
  });

  it('renders nothing — header, error text and Add to Cart alike — when hidden', () => {
    const viewer = { getPlugin: () => ({ addItem: vi.fn() }), selectionManager: { clear: vi.fn() } };
    const { container } = render(
      <ThemeProvider theme={rvDarkTheme}>
        <AasTooltipContent
          data={{ type: 'aas', aasId: AAS_ID, description: 'Test Motor', resolution: 'index-missing' } as never}
          isPinned
          viewer={viewer as never}
        />
      </ThemeProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Add to Cart' })).not.toBeInTheDocument();
  });

  it('never shows a loading placeholder while the resolution is pending', () => {
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <AasTooltipContent
          data={{ type: 'aas', aasId: AAS_ID, description: 'Test Motor', resolution: 'pending' } as never}
          isPinned={false}
          viewer={{ getPlugin: () => null } as never}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText(/Loading AAS/)).not.toBeInTheDocument();
  });
});

// ─── Surface 2 + 4: doc-mode hover and doc-mode detail panel ─────────────

describe('surface: doc mode (hover target + detail panel)', () => {
  it('hits the gated motor when it resolves', () => {
    const { root, motor } = gatedMotorScene('resolved');
    expect(findGatedAasAtPoint(root, new Vector3(10, 0, 0))).toBe(motor);
    expect(openDocModeDetailAtPoint(viewerWithScene(root), [10, 0, 0])).toBe(true);
  });

  it.each(HIDDEN_STATES)('is not a hit target and opens no panel when %s', (state) => {
    const { root } = gatedMotorScene(state);
    expect(findGatedAasAtPoint(root, new Vector3(10, 0, 0))).toBeNull();
    expect(openDocModeDetailAtPoint(viewerWithScene(root), [10, 0, 0])).toBe(false);
  });
});

// ─── Surface 3: property-inspector detail button ────────────────────────

describe('surface: inspector detail button', () => {
  function renderAction(resolution: AasResolution) {
    const { root } = gatedMotorScene(resolution);
    return render(
      <ThemeProvider theme={rvDarkTheme}>
        <AasDetailHeaderAction
          viewer={viewerWithScene(root)}
          nodePath="Motor"
          data={{ AASId: AAS_ID, Description: 'Test Motor' }}
        />
      </ThemeProvider>,
    );
  }

  it('offers the detail panel for a resolvable link', () => {
    const { container } = renderAction('resolved');
    expect(container.querySelector('button')).not.toBeNull();
  });

  it.each(HIDDEN_STATES)('is not offered when %s', (state) => {
    const { container } = renderAction(state);
    expect(container.querySelector('button')).toBeNull();
  });
});

// ─── Surface 5: sidebar AAS button (counter + highlight) ────────────────

describe('surface: sidebar AAS button', () => {
  function renderSidebar(resolution: AasResolution) {
    const root = new Object3D();
    root.add(aasNode(resolution));
    const viewer = viewerWithScene(root);
    const AasButton = new AasLinkPlugin().slots[0].component;
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}>
          <AasButton viewer={viewer as never} />
        </RVViewerProvider>
      </ThemeProvider>,
    );
    return viewer;
  }

  it('counts a resolvable link', () => {
    renderSidebar('resolved');
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it.each(HIDDEN_STATES)('neither counts nor highlights when %s', (state) => {
    const viewer = renderSidebar(state);
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    screen.getByRole('button').click();
    expect(viewer.highlighter.highlightMultiple).not.toHaveBeenCalled();
  });
});

// ─── Surface 6: "Add to Cart" context action ────────────────────────────

describe('surface: Add to Cart context action', () => {
  function cartCondition(resolution: AasResolution) {
    const node = aasNode(resolution);
    let registered: any = null;
    const viewer = {
      contextMenu: { register: (r: unknown) => { registered = r; } },
      getPlugin: () => undefined,
    };
    new OrderManagerPlugin().onModelLoaded({} as never, viewer as never);
    const item = registered.items.find((i: { id: string }) => i.id === 'order-manager.add-to-cart');
    return () => item.condition({ node, path: 'Motor' });
  }

  it('offers the action for a resolvable AAS', () => {
    expect(cartCondition('resolved')()).toBe(true);
  });

  it.each(HIDDEN_STATES)('does not offer the action when %s', (state) => {
    expect(cartCondition(state)()).toBe(false);
  });

  it('keeps cart items added before the model was reloaded (sessionStorage is a user act)', () => {
    const plugin = new OrderManagerPlugin();
    plugin.addItem(AAS_ID, 'Test Motor', 'ACME', 'A-1', 'Motor');
    expect(plugin.getItems()).toHaveLength(1);
    // A later load that cannot resolve the AAS must not retro-empty the cart.
    resetAasResolution();
    expect(plugin.getItems()).toHaveLength(1);
  });
});

// ─── resolveAasSubtree — marking, basePath, staleness ───────────────────

describe('resolveAasSubtree', () => {
  it('marks unknown ids and known ids from one available index', async () => {
    mockIndexFetch(JSON.stringify(INDEX), { status: 200 });
    const root = new Object3D();
    const known = aasNode('pending');
    const unknown = aasNode('pending', { aasId: OTHER_ID });
    root.add(known, unknown);

    await resolveAasSubtree(root, undefined, beginAasLoadGeneration());

    expect(getAasResolution(known)).toBe('resolved');
    expect(getAasResolution(unknown)).toBe('unknown-id');
  });

  it('marks index-missing when the index was not shipped at all (the CONNECT embed case)', async () => {
    mockIndexFetch(null, { status: 404 });
    const root = new Object3D();
    const node = aasNode('pending');
    root.add(node);

    await resolveAasSubtree(root, undefined, beginAasLoadGeneration());

    expect(getAasResolution(node)).toBe('index-missing');
    expect(isAasVisible(getAasResolution(node))).toBe(false);
  });

  it('keeps the visible error state when the index failed to load', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const root = new Object3D();
    const node = aasNode('pending');
    root.add(node);

    await resolveAasSubtree(root, undefined, beginAasLoadGeneration());

    expect(getAasResolution(node)).toBe('index-error');
    expect(isAasVisible(getAasResolution(node))).toBe(true);
  });

  it('resolves against the project assetsBasePath, not the default index', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(INDEX), { status: 200 }));
    const root = new Object3D();
    root.add(aasNode('pending'));

    await resolveAasSubtree(root, '/private-assets/customer/', beginAasLoadGeneration());

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/private-assets/customer/aasx/index.json');
    expect(getAasResolution(root.children[0])).toBe('resolved');
  });

  it('marks links attached after the model load (attachDriveDatasheets)', async () => {
    mockIndexFetch(JSON.stringify({ [SEW_DRIVE_AAS.aasId]: { file: 'sew.aasx', idShort: 'SEW' } }), { status: 200 });
    const root = new Object3D();
    const motor = new Object3D();
    motor.name = 'Motor';
    root.add(motor);

    attachDriveDatasheets(root);
    expect(getAasResolution(motor)).toBe('pending'); // never unmarked

    await resolveAasSubtree(root, undefined, beginAasLoadGeneration());
    expect(getAasResolution(motor)).toBe('resolved');
  });

  it('marks links added by a layout-planner placement (layout-content-added root)', async () => {
    mockIndexFetch(null, { status: 404 });
    const placed = new Object3D();
    const motor = new Object3D();
    motor.name = 'DriveMesh';
    placed.add(motor);
    attachDriveDatasheets(placed);

    await resolveAasSubtree(placed, undefined, currentAasLoadGeneration());

    expect(getAasResolution(motor)).toBe('index-missing');
  });

  it('ignores a stale resolution when the model was switched while the index loaded', async () => {
    mockIndexFetch(JSON.stringify(INDEX), { status: 200 });
    const rootA = new Object3D();
    const nodeA = aasNode('pending');
    rootA.add(nodeA);

    const generationA = beginAasLoadGeneration();
    const pending = resolveAasSubtree(rootA, undefined, generationA);
    beginAasLoadGeneration(); // model B started loading meanwhile
    await pending;

    expect(getAasResolution(nodeA)).toBe('pending'); // stale result dropped
  });
});
