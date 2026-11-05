// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2240 — the `?recording=1` flag module: parsing, injectable search, default off, the
 * `recordingWelcome=1` exception, and the eager rule (the module imports nothing).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRecordingMode, isWelcomeAutoOpenSuppressed } from '../src/core/recording-mode';

describe('recording-mode', () => {
  it('parses only recording=1 as on', () => {
    expect(isRecordingMode('?recording=1')).toBe(true);
    expect(isRecordingMode('?a=b&recording=1')).toBe(true);
    for (const search of ['', '?recording=0', '?recording=true', '?recording=', '?recordingWelcome=1']) {
      expect(isRecordingMode(search), search).toBe(false);
    }
  });

  it('is off by default (no location in Node)', () => {
    expect(isRecordingMode()).toBe(false);
    expect(isWelcomeAutoOpenSuppressed()).toBe(false);
  });

  it('suppresses the welcome auto-open in recording mode unless recordingWelcome=1', () => {
    expect(isWelcomeAutoOpenSuppressed('?recording=1')).toBe(true);
    expect(isWelcomeAutoOpenSuppressed('?recording=1&recordingWelcome=1')).toBe(false);
    expect(isWelcomeAutoOpenSuppressed('?recordingWelcome=1')).toBe(false);
    expect(isWelcomeAutoOpenSuppressed('')).toBe(false);
  });

  it('stays eager-safe: imports nothing', () => {
    const source = readFileSync(resolve(__dirname, '../src/core/recording-mode.ts'), 'utf8');
    expect(source).not.toMatch(/^import\s/m);
  });

  it('is the one parser of the flag: the recording seam reads it', () => {
    const seam = readFileSync(resolve(__dirname, '../src/core/engine/rv-recording-targets.ts'), 'utf8');
    expect(seam).toContain("from '../recording-mode'");
    expect(seam).not.toMatch(/get\('recording'\)/);
  });
});
