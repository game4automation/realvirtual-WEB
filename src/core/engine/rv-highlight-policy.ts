// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightPolicy — the single point that decides WHICH highlight profile
 * is active. Subscribes to the viewer's `mode-changed` event and atomically
 * swaps the RVHighlightManager profile (visual + overlay styles + OutlinePass
 * styles), then re-applies the surviving selection under the new profile.
 *
 * Plugins no longer install/restore styles on activate/deactivate — they
 * register a profile per mode id here (built-ins in main.ts, custom modes
 * beside their mode registration).
 *
 * NOTE: the profile applies on `mode-changed`, which fires AFTER the
 * onModeActivate hooks — highlighting from onModeActivate is unsupported
 * (it would render in the previous mode's profile).
 */

import type { HighlightProfile } from './rv-highlight-profiles';
import { DEFAULT_HIGHLIGHT_PROFILE } from './rv-highlight-profiles';
import type { RVHighlightManager } from './rv-highlight-manager';

/** Minimal viewer surface the policy needs (RVViewer satisfies it). */
export interface HighlightPolicyHost {
  on(event: 'mode-changed', cb: (data: { from: string | null; to: string }) => void): () => void;
  readonly highlighter: RVHighlightManager;
  readonly selectionManager: { refreshHighlight(): void };
}

export class RVHighlightPolicy {
  private readonly _profiles = new Map<string, HighlightProfile>();
  private _off: (() => void) | null;

  constructor(private readonly _host: HighlightPolicyHost) {
    this._off = _host.on('mode-changed', this._onModeChanged);
  }

  /** Register (or replace) the profile for a mode id. */
  register(modeId: string, profile: HighlightProfile): this {
    this._profiles.set(modeId, profile);
    return this;
  }

  /** The profile for a mode id — unknown/unregistered modes get the default. */
  profileFor(modeId: string): HighlightProfile {
    return this._profiles.get(modeId) ?? DEFAULT_HIGHLIGHT_PROFILE;
  }

  dispose(): void {
    this._off?.();
    this._off = null;
    this._profiles.clear();
  }

  private readonly _onModeChanged = ({ to }: { from: string | null; to: string }): void => {
    const h = this._host.highlighter;
    // Hover is mode-specific — never carry it across a mode switch.
    h.clear();
    h.setProfile(this.profileFor(to));
    // Re-apply the surviving selection under the new profile.
    this._host.selectionManager.refreshHighlight();
  };
}
