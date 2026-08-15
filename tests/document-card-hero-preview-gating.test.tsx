// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentCard hero preview gating — the fix for the ~20 s dashboard freeze.
 *
 * The dashboard host stays mounted while hidden (`display:none`), and the
 * hero's preview effect re-runs on every model load/clear — i.e. on every
 * project switch. Before the `previewVisible` gate that meant an offscreen
 * render of the whole live model for a card nobody could see. These tests pin
 * the three behaviours that keep the gate honest:
 *   - hidden ⇒ `renderLiveNow` is NEVER called;
 *   - visible ⇒ called exactly once, and a hide/show round-trip with the same
 *     document and model does NOT render again (reopen is free);
 *   - a model load while hidden defers the render to the next open instead of
 *     doing it eagerly.
 *
 * Renderer-free like `document-card.test.tsx`: the card reaches the renderer
 * only through `viewer.thumbnails`, so a spy double is the whole environment.
 * rAF is stubbed synchronous — the double-rAF deferral is a paint-ordering
 * concern, not part of the call-count contract under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Group } from 'three';
import { DocumentCard } from '../src/core/hmi/scene/DocumentCard';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';

// ─── Doubles ────────────────────────────────────────────────────────────

function makeView(over: Partial<ActiveDocumentView> = {}): ActiveDocumentView {
  return {
    name: 'Conveyor',
    crumbs: [{
      index: 0, label: 'Conveyor', occurrence: '', referenceNodeId: null,
      dirty: false, stale: false, current: true,
    }],
    dirty: false,
    busy: false,
    stackDirty: false,
    stale: false,
    saveVerb: 'save',
    sourceMode: 'planner',
    actions: { save: async () => ({ status: 'saved' }) },
    ...over,
  };
}

/** The minimal viewer the hero preview path touches: events, the model root
 *  and the thumbnail service. Everything else on the card is seam-driven. */
function makeViewerDouble() {
  const handlers = new Map<string, Set<() => void>>();
  const renderLiveNow = vi.fn(() => 'data:image/png;base64,stub');
  const viewer = {
    on(event: string, cb: () => void) {
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    currentModelRoot: new Group(),
    lastLoadResult: null,
    thumbnails: { renderLiveNow },
  } as unknown as RVViewer;
  const emit = (event: string) => {
    for (const cb of handlers.get(event) ?? []) cb();
  };
  return { viewer, renderLiveNow, emit };
}

function mountHero(viewer: RVViewer, previewVisible: boolean) {
  return render(
    <RVViewerProvider value={viewer}>
      <DocumentCard variant="hero" previewVisible={previewVisible} />
    </RVViewerProvider>,
  );
}

function rerenderHero(r: ReturnType<typeof render>, viewer: RVViewer, previewVisible: boolean) {
  r.rerender(
    <RVViewerProvider value={viewer}>
      <DocumentCard variant="hero" previewVisible={previewVisible} />
    </RVViewerProvider>,
  );
}

beforeEach(() => {
  setActiveDocumentView(makeView());
  // Synchronous rAF: the double-rAF deferral must not hide calls from the
  // assertions below; what is under test is IF a render happens, not when.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  vi.unstubAllGlobals();
});

// ─── The gate ───────────────────────────────────────────────────────────

describe('DocumentCard hero preview gating', () => {
  it('never renders while the dashboard is hidden', () => {
    const { viewer, renderLiveNow, emit } = makeViewerDouble();
    mountHero(viewer, false);
    // Even a project switch behind the hidden overlay must not trigger it.
    act(() => { emit('model-cleared'); });
    act(() => { emit('model-loaded'); });
    expect(renderLiveNow).not.toHaveBeenCalled();
  });

  it('renders once when visible, and a reopen with the same model is free', () => {
    const { viewer, renderLiveNow } = makeViewerDouble();
    const r = mountHero(viewer, true);
    expect(renderLiveNow).toHaveBeenCalledTimes(1);
    expect(renderLiveNow).toHaveBeenCalledWith(viewer.currentModelRoot, 512);

    // Close and reopen the dashboard — same document, same model tick.
    rerenderHero(r, viewer, false);
    rerenderHero(r, viewer, true);
    expect(renderLiveNow).toHaveBeenCalledTimes(1);
  });

  it('defers a model load while hidden to the next open', () => {
    const { viewer, renderLiveNow, emit } = makeViewerDouble();
    const r = mountHero(viewer, true);
    expect(renderLiveNow).toHaveBeenCalledTimes(1);

    rerenderHero(r, viewer, false);
    act(() => { emit('model-loaded'); });        // project switch while hidden
    expect(renderLiveNow).toHaveBeenCalledTimes(1);

    rerenderHero(r, viewer, true);               // dashboard opened again
    expect(renderLiveNow).toHaveBeenCalledTimes(2);
  });

  it('renders again when the model changes while visible', () => {
    const { viewer, renderLiveNow, emit } = makeViewerDouble();
    mountHero(viewer, true);
    expect(renderLiveNow).toHaveBeenCalledTimes(1);
    act(() => { emit('model-loaded'); });
    expect(renderLiveNow).toHaveBeenCalledTimes(2);
  });
});
