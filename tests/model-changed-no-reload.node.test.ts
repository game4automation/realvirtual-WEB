// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The page reload on `model_changed` is gone and must stay gone (plan-365 F6).
 *
 * A behavioural test cannot prove this: a `location.reload()` inside the browser
 * test pool tears down the very context that would assert it. The source is
 * therefore the subject — the one place where "this call does not exist" is a
 * statement that can actually be checked.
 *
 * The reload used to fire for EVERY publish regardless of which model it was,
 * taking the camera, the workspace mode and any unsaved edit with it. Anything
 * that puts it back re-introduces exactly that.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INTERFACE_SOURCE = resolve(__dirname, '../src/interfaces/websocket-realtime-interface.ts');

describe('websocket-realtime-interface', () => {
  it('never calls location.reload()', () => {
    const source = readFileSync(INTERFACE_SOURCE, 'utf8');
    expect(source).not.toMatch(/location\s*\.\s*reload\s*\(/);
  });

  it('reports the published model to the coordinator instead', () => {
    const source = readFileSync(INTERFACE_SOURCE, 'utf8');
    expect(source).toContain('emitModelChanged');
    // The origin check stays, and it is the shared one — not a second, weaker
    // comparison that misses HTTPS on its default port.
    expect(source).toContain('isSameOriginWsTarget(this._wsScheme');
  });
});
