// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-761 §9.2 — the descriptor `view.renderMode`: registration (idempotent),
 * the guards (enum incl. the refused `'wireframe'`, the deployment lock), the
 * per-mode button key, the MCP mirror and `run`.
 *
 * Node environment: `rv-command-bootstrap.node.test.ts` covers the editor
 * descriptors and NOT `view.*`, so this file is the registration proof.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  ensureViewCommandsRegistered, createViewCommandDescriptors, renderModeKey,
  RENDER_MODE_INVALID, VIEW_COMMAND_IDS,
} from '../src/core/hmi/view-commands';
import { RENDER_MODE_LOCKED } from '../src/core/hmi/render-mode-controller';
import { setAppConfig } from '../src/core/rv-app-config';
import { fakeRenderViewer } from './helpers/fake-render-viewer';

describe('view.renderMode', () => {
  let registry: CommandRegistry;
  beforeEach(() => {
    registry = new CommandRegistry();
    setAppConfig({});
    ensureViewCommandsRegistered(registry);
  });
  afterEach(() => setAppConfig({}));

  it('registers once (idempotent) with mcp mirror web_view_render_mode and argsSchema {mode:string}', () => {
    ensureViewCommandsRegistered(registry);
    const d = registry.get('view.renderMode')!;
    expect(d).toBeDefined();
    expect(d.mcp?.tool).toBe('web_view_render_mode');
    expect(d.mcp?.params).toEqual([{ name: 'mode', type: 'string', required: true }]);
    expect(d.argsSchema).toEqual({ mode: 'string' });
    expect(d.scope).toBe('none');
    expect(d.available).toBe(true);
    expect(d.readOnly).toBe(false);
    expect(d.eagerImpl).toBeDefined();
    expect(registry.list().filter((x) => x.id === 'view.renderMode')).toHaveLength(1);
    // plan-591 added the second view command — these two are exact list
    // comparisons on purpose, so a new one cannot slip in unnoticed.
    expect(VIEW_COMMAND_IDS).toEqual(['view.renderMode', 'view.visualPreset']);
    expect(createViewCommandDescriptors().map((x) => x.id))
      .toEqual(['view.renderMode', 'view.visualPreset']);
  });

  it("refuses unknown modes incl. 'wireframe', and locked deployments, each with a reason", () => {
    const viewer = fakeRenderViewer();
    expect(registry.enabled('view.renderMode', { mode: 'shiny' }, viewer))
      .toEqual({ reason: RENDER_MODE_INVALID });
    expect(RENDER_MODE_INVALID).toMatch(/simple\|default\|toon/);
    expect(registry.enabled('view.renderMode', { mode: 'wireframe' }, viewer))
      .toEqual({ reason: RENDER_MODE_INVALID });
    expect(registry.enabled('view.renderMode', {}, viewer)).toEqual({ reason: RENDER_MODE_INVALID });
    expect(registry.enabled('view.renderMode', { mode: 'toon' }, viewer)).toBe(true);
    setAppConfig({ lockedTabs: ['visual'] });
    expect(registry.enabled('view.renderMode', { mode: 'toon' }, viewer))
      .toEqual({ reason: RENDER_MODE_LOCKED });
    setAppConfig({ lockSettings: true });
    expect(registry.enabled('view.renderMode', { mode: 'toon' }, viewer))
      .toMatchObject({ reason: expect.stringMatching(/locked/) });
  });

  it('the lock wins over an invalid mode (one reason, the lock)', () => {
    setAppConfig({ lockedTabs: ['visual'] });
    expect(registry.enabled('view.renderMode', { mode: 'wireframe' }, fakeRenderViewer()))
      .toEqual({ reason: RENDER_MODE_LOCKED });
  });

  it('buttonKey is per mode', () => {
    expect(registry.buttonKeyOf('view.renderMode', { mode: 'toon' })).toBe('view.renderMode:toon');
    expect(registry.buttonKeyOf('view.renderMode', { mode: 'simple' })).toBe(renderModeKey('simple'));
    expect(registry.buttonKeyOf('view.renderMode', undefined)).toBe('view.renderMode:');
  });

  it('run sets the mode via setRenderMode and returns {renderMode, wireframe:false}', async () => {
    const viewer = fakeRenderViewer({ renderMode: 'default' });
    const r = await registry.execute('view.renderMode', { mode: 'simple' }, { origin: 'ui', viewer });
    expect(r).toEqual({ ok: true, value: { renderMode: 'simple', wireframe: false } });
    expect(viewer.renderMode).toBe('simple');
    expect(viewer.calls).toContain('renderMode=simple');
  });

  it('a refused execute is kind disabled with the rule text and touches the viewer not at all', async () => {
    const viewer = fakeRenderViewer({ renderMode: 'default' });
    const r = await registry.execute('view.renderMode', { mode: 'wireframe' }, { origin: 'mcp', viewer });
    expect(r).toMatchObject({ ok: false, kind: 'disabled', reason: RENDER_MODE_INVALID });
    expect(viewer.calls).toEqual([]);
    setAppConfig({ lockSettings: true });
    const locked = await registry.execute('view.renderMode', { mode: 'toon' }, { origin: 'mcp', viewer });
    expect(locked).toMatchObject({ ok: false, kind: 'disabled', reason: RENDER_MODE_LOCKED });
    expect(viewer.calls).toEqual([]);
    expect(viewer.renderMode).toBe('default');
  });
});
