// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The live value stream is model-scoped while the REST connection is not, so an interface can read
 * "Connected" — gateway polling the PLC, values in its store — while the browser has no stream and
 * every signal chip stays blank. This rule is the one the CONNECT panel explains that state with;
 * it is shared with the plugin's attach guard precisely so the two cannot drift apart.
 */

import { describe, it, expect } from 'vitest';
import { connectStreamBlock } from '../src/core/hmi/connect-stream';

describe('connectStreamBlock', () => {
  it('streams for a trusted, loaded model', () => {
    expect(connectStreamBlock(true, true)).toBeNull();
  });

  it('blames the missing model first — an untrusted nothing is still just nothing', () => {
    expect(connectStreamBlock(false, true)).toBe('no-model');
    expect(connectStreamBlock(false, false)).toBe('no-model');
  });

  it('withholds the stream from an untrusted (shared-link) model', () => {
    expect(connectStreamBlock(true, false)).toBe('untrusted');
  });
});
