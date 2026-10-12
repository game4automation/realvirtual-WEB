// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.10 — `useCommandView` through the OPEN primitive `ActionSegment`.
 *
 * Label and reason come from the command; the tooltip IS the command's reason
 * while it refuses (a disabled ButtonBase needs the span wrapper to show it);
 * one click → exactly one `execute` with origin 'ui'; the button key of every
 * variant (Rotate X/Y/Z) equals the key the MCP binding computes for
 * `web_editor_rotate90 axis=x|y|z`; an MCP touch leaves the afterglow + marker
 * on THIS segment; `command` and `onClick` together is a type error.
 * Runs in both editions (`VITE_PUBLIC_BUILD=1` → the reason is ERR_EDITOR_UNAVAILABLE).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000 });
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { RVViewer } from '../src/core/rv-viewer';
import { ActionSegment } from '../src/core/hmi/action-group';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { buildCallContext } from '../src/core/hmi/rv-command-context';
import { ensureEditorCommandsRegistered, NEEDS_TARGET } from '../src/core/hmi/editor-command-descriptors';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { _resetButtonSimStateForTest, touchAfterglow } from '../src/core/hmi/button-sim-state';

const viewer = {
  modes: { activeMode: 'editor' },
  selectionManager: { getSnapshot: () => ({ selectedPaths: [] as string[] }) },
  registry: { getNode: (p: string) => (p === 'A' ? { isObject3D: true, children: [], userData: {} } : null) },
} as unknown as RVViewer;

beforeEach(async () => {
  ensureEditorCommandsRegistered();
  commandRegistry._resetForTest();
  // The first load of the (lazy) implementation module can take longer than a
  // waitFor window; mounting preloads too, the test just does not race it.
  await commandRegistry.preload(['editor.toGround', 'editor.rotate90']);
  setActiveAssetContext({
    viewer,
    doc: { id: 'doc-1', whenIdle: async () => {}, lockOwner: null } as unknown as ActiveAssetContext['doc'],
  });
  _resetButtonSimStateForTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setActiveAssetContext(null);
  _resetButtonSimStateForTest();
});

function segment(path: string | null) {
  return render(
    <ActionSegment title="To Ground" command={{ id: 'editor.toGround', args: () => ({ path }) }} />,
  );
}

const btn = (c: HTMLElement, id = 'editor.toGround') =>
  c.querySelector(`[data-rv-command-id="${id}"]`) as HTMLButtonElement;

describe('useCommandView via ActionSegment', () => {
  it('tooltip == the command reason while disabled', async () => {
    const { container } = segment(null);
    const expected = __RV_HAS_PRIVATE__ ? NEEDS_TARGET : ERR_EDITOR_UNAVAILABLE;
    await waitFor(() => expect(btn(container).parentElement?.getAttribute('aria-label')).toBe(expected));
    expect(btn(container).disabled).toBe(true);
    expect(btn(container).getAttribute('data-rv-button-id')).toBe('qe.to-ground');
    // Same answer the registry (and therefore the MCP tool) gives.
    expect(commandRegistry.enabled('editor.toGround', { path: null })).toEqual({ reason: expected });
  });

  it('one click → exactly one execute, origin ui, on the command button key', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: the segment is disabled (asserted above)
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: { path: 'A' } });
    const { container } = segment('A');
    await waitFor(() => expect(btn(container).disabled).toBe(false));
    fireEvent.click(btn(container));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('editor.toGround', { path: 'A' }, { origin: 'ui', buttonKey: 'qe.to-ground' });
  });

  it('a UI-local gate keeps its own reason while the command would accept', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    const { container } = render(
      <ActionSegment title="To Ground" disabled disabledReason="Busy"
        command={{ id: 'editor.toGround', args: () => ({ path: 'A' }) }} />,
    );
    await waitFor(() => expect(btn(container).parentElement?.getAttribute('aria-label')).toBe('Busy'));
  });

  it('Rotate X/Y/Z: the rendered button key == desc.buttonKey(args) == the MCP binding key', () => {
    const { container } = render(
      <>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <ActionSegment key={axis} title={axis}
            command={{ id: 'editor.rotate90', args: () => ({ path: 'A', axis, sign: 1 }) }} />
        ))}
      </>,
    );
    const rendered = [...container.querySelectorAll('[data-rv-command-id="editor.rotate90"]')]
      .map((el) => el.getAttribute('data-rv-button-id'));
    const fromDescriptor = (['x', 'y', 'z'] as const).map((axis) => commandRegistry.buttonKeyOf('editor.rotate90', { axis }));
    const fromBinding = (['x', 'y', 'z'] as const).map((axis) =>
      buildCallContext('editor.rotate90', { path: 'A', axis, sign: 1 }, viewer).bound?.buttonKey);
    expect(rendered).toEqual(['qe.rotate-x', 'qe.rotate-y', 'qe.rotate-z']);
    expect(fromDescriptor).toEqual(rendered);
    expect(fromBinding).toEqual(rendered);
  });

  it('an MCP touch shows the afterglow + AI marker on THIS segment, without a transform', () => {
    const { container } = segment('A');
    expect(btn(container).getAttribute('data-rv-sim-phase')).toBeNull();
    act(() => { touchAfterglow('qe.to-ground', 'editor.toGround'); });
    expect(btn(container).getAttribute('data-rv-sim-phase')).toBe('afterglow');
    expect(btn(container).getAttribute('aria-description')).toBe('Triggered by AI');
    expect(getComputedStyle(btn(container)).transform).toBe('none');
    expect(getComputedStyle(btn(container), '::after').content).toContain('AI');
  });

  it('command and onClick together is a type error (no double execution)', () => {
    const el = (
      // @ts-expect-error — a command view has no second click path
      <ActionSegment title="x" command={{ id: 'editor.toGround' }} onClick={() => {}} />
    );
    expect(el).toBeTruthy();
  });
});
