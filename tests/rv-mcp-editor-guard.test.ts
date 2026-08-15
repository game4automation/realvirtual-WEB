// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** requireEditor gate: uniform errors outside editor mode / without a document. */

import { describe, it, expect, afterEach } from 'vitest';
import { requireEditor, isGuardError } from '../src/plugins/mcp-bridge/rv-mcp-editor-guard';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ActiveAssetContext } from '../src/core/editor/active-asset-store';

const viewerInMode = (mode: string): RVViewer =>
  ({ modes: { activeMode: mode } } as unknown as RVViewer);

afterEach(() => setActiveAssetContext(null));

describe('requireEditor', () => {
  it('errors without a viewer', () => {
    const r = requireEditor(undefined);
    expect(isGuardError(r)).toBe(true);
  });

  it('errors outside editor mode with the actionable hint', () => {
    const r = requireEditor(viewerInMode('hmi'));
    expect(isGuardError(r) && r.error).toMatch(/web_editor_open/);
  });

  it('errors in editor mode while no document is active yet', () => {
    const r = requireEditor(viewerInMode('editor'));
    expect(isGuardError(r) && r.error).toMatch(/activating/);
  });

  it('returns the active context in editor mode', () => {
    const viewer = viewerInMode('editor');
    const ctx = { viewer, doc: {} } as unknown as ActiveAssetContext;
    setActiveAssetContext(ctx);
    const r = requireEditor(viewer);
    expect(isGuardError(r)).toBe(false);
    expect(r).toBe(ctx);
  });
});
