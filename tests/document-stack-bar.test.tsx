// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The descend UI — breadcrumb chips, Back, status line (plan-703 §3.2).
 *
 * Renderer-free, after `hierarchy-virtualized.test.tsx`: the bar reads a
 * `RvDocumentStack` snapshot through `useSyncExternalStore`, so a real stack
 * over stub documents and a two-method viewer double is the whole environment.
 * No `WebGLRenderer`, no GLB, no `loadModel`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { Object3D } from 'three';
import { RvDocumentStack, describeSuppressedOverrides, countInstanceOverrides } from '../src/core/ops/rv-document-stack';
import { setAssetOverrides } from '../src/core/engine/rv-asset-reference';
import { DocumentStackBar, statusLine } from '@rv-private/plugins/asset-editor/DocumentStackBar';
import {
  setActiveDocumentStack,
  getDocumentStack,
  getDocumentStackSnapshot,
  EMPTY_STACK_SNAPSHOT,
  subscribeDocumentStack,
} from '@rv-private/plugins/asset-editor/document-stack-store';
import type { RvDescendController } from '../src/core/ops/rv-document-recompose';

// ─── Doubles ────────────────────────────────────────────────────────────

/** A document that satisfies `RvStackDocument` and nothing more. */
function stubDoc(id: string, dirty = false) {
  const listeners = new Set<() => void>();
  return {
    id,
    document: {
      dirty,
      inTransaction: false,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      abortTransaction: async () => {},
    },
    setDraftFrame: vi.fn(),
    dispose: vi.fn(),
    _wake: () => { for (const fn of listeners) fn(); },
  };
}

function stubViewer() {
  return { isolateNodes: vi.fn(), exitIsolate: vi.fn() };
}

function buildStack(names: string[]) {
  const viewer = stubViewer();
  const stack = new RvDocumentStack({ viewer, projectId: 'p1' });
  const docs = names.map((n, i) => stubDoc(`doc${i}`));
  stack.pushRoot({ doc: docs[0] as never, assetId: 'asset:root', name: names[0] });
  for (let i = 1; i < names.length; i++) {
    stack.push({
      doc: docs[i] as never,
      assetId: `asset:${names[i]}`,
      name: names[i],
      referenceNodeId: `ref-${i}`,
      // Decision (b): a child loaded from its own bytes isolates nothing.
      isolatedRoots: [],
      suppressedOverrides: 0,
    });
  }
  return { stack, docs, viewer };
}

function mount(stack: RvDocumentStack, controller?: Partial<RvDescendController>) {
  setActiveDocumentStack({ stack, controller: (controller ?? {}) as RvDescendController });
  return render(<DocumentStackBar />);
}

afterEach(() => {
  cleanup();
  setActiveDocumentStack(null);
});

// ─── The store seam ─────────────────────────────────────────────────────

describe('document-stack-store', () => {
  it('answers with ONE stable empty snapshot when nothing is open', () => {
    setActiveDocumentStack(null);
    expect(getDocumentStackSnapshot()).toBe(EMPTY_STACK_SNAPSHOT);
    // Referential stability is load-bearing: useSyncExternalStore loops
    // forever on a fresh object per read.
    expect(getDocumentStackSnapshot()).toBe(getDocumentStackSnapshot());
    expect(getDocumentStack()).toBeNull();
  });

  it('forwards the stack’s own notifications', () => {
    const { stack, docs } = buildStack(['MyPlant.glb']);
    setActiveDocumentStack({ stack, controller: {} as RvDescendController });
    const seen = vi.fn();
    const unsub = subscribeDocumentStack(seen);
    docs[0]._wake();
    expect(seen).toHaveBeenCalled();
    unsub();
  });
});

// ─── The bar ────────────────────────────────────────────────────────────

describe('DocumentStackBar', () => {
  it('renders NOTHING for a session that never descended', () => {
    const { stack } = buildStack(['MyPlant.glb']);
    mount(stack);
    expect(screen.queryByTestId('document-stack-bar')).toBeNull();
  });

  it('renders one chip per frame once a descend happened', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler', 'Gripper']);
    mount(stack);
    expect(screen.getByTestId('document-stack-bar')).toBeTruthy();
    const labels = screen.getAllByTestId(/^stack-crumb/).map((el) => el.textContent);
    expect(labels).toEqual(['MyPlant.glb', 'Filler', 'Gripper']);
  });

  it('marks the deepest frame as the current one', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler', 'Gripper']);
    mount(stack);
    expect(screen.getByTestId('stack-crumb-current').textContent).toBe('Gripper');
  });

  it('the crumbs ARE the breadcrumb — same labels, same order', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler', 'Gripper']);
    mount(stack);
    expect(screen.getAllByTestId(/^stack-crumb/).map((el) => el.textContent))
      .toEqual(stack.breadcrumb().map((c) => c.label));
  });

  it('shows the §3.2 status line for the open document', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler', 'Gripper']);
    mount(stack);
    expect(screen.getByTestId('stack-status-line').textContent)
      .toBe('editing Gripper — isolated');
  });

  it('names the hidden instance overrides when the frame suppresses any', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler']);
    stack.top!.suppressedOverrides = 3;
    mount(stack);
    expect(screen.getByTestId('stack-status-line').textContent)
      .toBe('editing Filler — isolated — 3 Overrides dieser Instanz sind ausgeblendet');
  });

  it('offers Back, and Back pops one frame', async () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler']);
    const back = vi.fn(async () => {
      stack.pop();
      return { status: 'ok' as const, frame: stack.top!, staleReason: null };
    });
    mount(stack, { back } as unknown as Partial<RvDescendController>);

    screen.getByRole('button', { name: /back/i }).click();
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('document-stack-bar')).toBeNull());
  });

  it('a dirty frame renders its dot in the chip', () => {
    const { stack, docs } = buildStack(['MyPlant.glb', 'Filler']);
    docs[1].document.dirty = true;
    docs[1]._wake();
    mount(stack);
    const crumb = screen.getByTestId('stack-crumb-current');
    expect(crumb.textContent).toBe('Filler');
    // The shared mark, not a bullet glued to the label: the same element the
    // asset card and the ActivityBar render (`rv-dirty-dot.tsx`).
    expect(crumb.querySelector('[data-testid="dirty-dot"]')).not.toBeNull();
  });

  it('a clean frame renders no dot', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler']);
    mount(stack);
    expect(screen.getByTestId('stack-crumb-current').querySelector('[data-testid="dirty-dot"]')).toBeNull();
  });

  it('a stale frame says so in the status line', () => {
    const { stack } = buildStack(['MyPlant.glb', 'Filler']);
    stack.markStale(stack.top!, 'saved-below');
    mount(stack);
    expect(screen.getByTestId('stack-status-line').textContent).toContain('the file changed below');
  });
});

// ─── The sentence itself ────────────────────────────────────────────────

describe('statusLine', () => {
  it('names the document and that it stands alone', () => {
    expect(statusLine('Gripper.glb', false, null)).toBe('editing Gripper.glb — isolated');
  });

  it('appends the suppression notice when there is one', () => {
    expect(statusLine('Gripper.glb', false, describeSuppressedOverrides(3)))
      .toBe('editing Gripper.glb — isolated — 3 Overrides dieser Instanz sind ausgeblendet');
  });

  it('counts one override in the singular', () => {
    const ref = new Object3D();
    setAssetOverrides(ref, { byNodeId: { n1: { Drive: { TargetSpeed: 1 } } } });
    expect(countInstanceOverrides(ref)).toBe(1);
    expect(describeSuppressedOverrides(1)).toBe('1 Override dieser Instanz ist ausgeblendet');
  });

  it('says nothing extra when nothing is hidden', () => {
    expect(describeSuppressedOverrides(0)).toBeNull();
    expect(statusLine('X', false, null)).not.toContain('ausgeblendet');
  });
});
