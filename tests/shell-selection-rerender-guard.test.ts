// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Guard: a selection change must not re-render the whole HMI shell.
 *
 * The editor plugin's snapshot changes on every selection. Measured 2026-11-05
 * in the dev build: while TopBar, ActivityBar and the width hooks under
 * ButtonPanel / BottomBar subscribed to the FULL snapshot via
 * `useEditorPlugin()`, every click-to-select and every planner drop
 * re-rendered ~800 components (65-70 ms of React work per selection).
 *
 * The shell reads primitive slices through `useEditorState(selector)` and the
 * plugin itself through `useEditorPluginInstance()`. This test pins that: none
 * of the shell files may call `useEditorPlugin()` again.
 */

import { describe, it, expect } from 'vitest';
import topBar from '../src/core/hmi/TopBar.tsx?raw';
import activityBar from '../src/core/hmi/ActivityBar.tsx?raw';
import buttonPanel from '../src/core/hmi/ButtonPanel.tsx?raw';
import bottomBar from '../src/core/hmi/BottomBar.tsx?raw';
import hmiShell from '../src/core/hmi/HMIShell.tsx?raw';
import leftWindowWidth from '../src/hooks/use-left-window-width.ts?raw';
import viewportInsets from '../src/hooks/use-viewport-insets.ts?raw';
import mobileLayout from '../src/hooks/use-mobile-layout.ts?raw';
import libraryPanel from '../src/plugins/layout-planner/LayoutLibraryPanel.tsx?raw';

const SHELL_SOURCES: Record<string, string> = {
  'TopBar.tsx': topBar,
  'ActivityBar.tsx': activityBar,
  'ButtonPanel.tsx': buttonPanel,
  'BottomBar.tsx': bottomBar,
  'HMIShell.tsx': hmiShell,
  'use-left-window-width.ts': leftWindowWidth,
  'use-viewport-insets.ts': viewportInsets,
  'use-mobile-layout.ts': mobileLayout,
};

/** Strip line and block comments so a doc mention does not trip the guard. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('HMI shell does not subscribe to the full editor state', () => {
  for (const [file, src] of Object.entries(SHELL_SOURCES)) {
    it(`${file} does not call useEditorPlugin()`, () => {
      expect(codeOnly(src)).not.toMatch(/\buseEditorPlugin\s*\(/);
    });
  }

  it('the hierarchy width is read as a number slice', () => {
    expect(codeOnly(leftWindowWidth)).toMatch(/const hierarchyWidth = useEditorState\(/);
  });

  it('the planner library panel does not subscribe to the whole layout snapshot', () => {
    // The snapshot carries `selectedId`; a whole-snapshot subscription
    // re-rendered the library grid on every selection and every drop.
    expect(codeOnly(libraryPanel)).not.toMatch(/useSyncExternalStore\(\s*store\?\.subscribe[^,]*,\s*store\?\.getSnapshot\b/);
  });
});
