// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightPolicy — mode-changed applies the registered profile, re-applies
 * the surviving selection, and unknown modes fall back to the default.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import { RVHighlightPolicy } from '../src/core/engine/rv-highlight-policy';
import {
  MODE_HIGHLIGHT_PROFILES,
  DEFAULT_HIGHLIGHT_PROFILE,
} from '../src/core/engine/rv-highlight-profiles';

type ModeCb = (data: { from: string | null; to: string }) => void;

function makeHost() {
  const scene = new Scene();
  const highlighter = new RVHighlightManager(scene);
  let modeCb: ModeCb | null = null;
  let refreshCount = 0;
  const host = {
    on(event: 'mode-changed', cb: ModeCb) {
      expect(event).toBe('mode-changed');
      modeCb = cb;
      return () => { modeCb = null; };
    },
    highlighter,
    selectionManager: { refreshHighlight: () => { refreshCount++; } },
  };
  return {
    host,
    scene,
    highlighter,
    fireModeChanged: (to: string) => modeCb?.({ from: null, to }),
    getRefreshCount: () => refreshCount,
    isSubscribed: () => modeCb !== null,
  };
}

describe('RVHighlightPolicy', () => {
  let ctx: ReturnType<typeof makeHost>;
  let policy: RVHighlightPolicy;

  beforeEach(() => {
    ctx = makeHost();
    policy = new RVHighlightPolicy(ctx.host)
      .register('hmi', MODE_HIGHLIGHT_PROFILES.hmi)
      .register('planner', MODE_HIGHLIGHT_PROFILES.planner)
      .register('editor', MODE_HIGHLIGHT_PROFILES.editor);
  });

  it('mode-changed installs the registered profile on the highlighter', () => {
    ctx.fireModeChanged('planner');
    expect(ctx.highlighter.getProfile()).toBe(MODE_HIGHLIGHT_PROFILES.planner);
    ctx.fireModeChanged('editor');
    expect(ctx.highlighter.getProfile()).toBe(MODE_HIGHLIGHT_PROFILES.editor);
  });

  it('unknown mode falls back to the default profile', () => {
    ctx.fireModeChanged('some-custom-mode');
    expect(ctx.highlighter.getProfile()).toBe(DEFAULT_HIGHLIGHT_PROFILE);
    expect(policy.profileFor('nope')).toBe(DEFAULT_HIGHLIGHT_PROFILE);
  });

  it('mode-changed clears hover and re-applies the selection', () => {
    // Active hover before the switch — must not survive it.
    const root = new Object3D();
    root.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    ctx.scene.add(root);
    ctx.highlighter.highlight(root);
    expect(ctx.highlighter.isActive).toBe(true);

    ctx.fireModeChanged('planner');
    expect(ctx.highlighter.isActive).toBe(false);
    expect(ctx.getRefreshCount()).toBe(1);
  });

  it('dispose unsubscribes from mode-changed', () => {
    expect(ctx.isSubscribed()).toBe(true);
    policy.dispose();
    expect(ctx.isSubscribed()).toBe(false);
  });
});
