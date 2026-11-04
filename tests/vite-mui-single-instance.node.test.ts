// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MUI and emotion must be pinned in `optimizeDeps.include`.
 *
 * Why this is worth a test: on 2026-10-30 the whole HMI came up with WHITE
 * Paper surfaces, a shifted layout and different icon spacing in the toolbars.
 * The cause was not a style commit — it was TWO @emotion/react instances in the
 * dev session ("You are loading @emotion/react when it is already loaded").
 * MUI's ThemeProvider then writes the dark theme into one instance's
 * ThemeContext while every styled component reads the other's, which has no
 * provider at all, so all of MUI silently falls back to its DEFAULT LIGHT
 * theme. That default also carries fontSize 14 instead of 13 and no Inter,
 * which is why colour and positioning changed together.
 *
 * The split becomes possible as soon as the dependency scan is incomplete — one
 * unresolvable import anywhere in the graph (the private tree included) aborts
 * it, and Vite then discovers MUI/emotion lazily across more than one optimizer
 * pass. Pinning them keeps a single instance no matter what the scan did.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The specifiers that must share ONE optimizer run. */
const PINNED = [
  '@mui/material',
  '@mui/material/styles',
  '@mui/icons-material',
  '@emotion/react',
  '@emotion/styled',
] as const;

describe('vite optimizeDeps — one MUI/emotion instance', () => {
  it('pins every MUI and emotion entry in optimizeDeps.include', async () => {
    const src = await readFile(join(REPO, 'vite.config.ts'), 'utf8');

    // The `include: [` array of the optimizeDeps block, read as text on purpose:
    // importing the config would run its build banner and git lookups.
    const block = src.slice(src.indexOf('optimizeDeps:'));
    const include = block.slice(block.indexOf('include: ['), block.indexOf(']', block.indexOf('include: [')));
    expect(include).not.toBe('');

    const missing = PINNED.filter((dep) => !include.includes(`'${dep}'`));
    expect(missing, `unpinned in optimizeDeps.include — a mid-session re-optimization can split these into two instances and MUI falls back to its default LIGHT theme: ${missing.join(', ')}`).toEqual([]);
  });
});
