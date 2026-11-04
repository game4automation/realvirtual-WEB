// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 §9.10 — every `setMode(` caller of the ModeManager is classified (static).
 *
 * Since the Editor is an on-demand feature, `setMode('editor')` on a cold workspace
 * does not switch at once: the ModeManager's safety net loads the feature and
 * switches afterwards. That is right for a caller with no follow-up step, and wrong
 * for one that reads `activeMode` or relies on the new mode right after — those must
 * use `setModeAsync` (or await `features.ensureForMode` first). This test pins every
 * remaining synchronous caller with the reason it may stay synchronous; a NEW caller
 * fails it until someone decides which of the two it is.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const CALL = /\b(?:modes|mgr)[!?]?\.setMode\(/;

/** `<file>::<trimmed line>` → why this caller may stay synchronous. */
const SYNCHRONOUS_CALLERS: Record<string, string> = {
  'src/core/hmi/projects/ProjectsDashboardHost.tsx::modes.setMode(id);':
    'fallback inside setModeAwaited() for doubles without switchMode/setModeAsync',
  'src/core/thumbnails/rv-thumbnail-regenerate.ts::modes.setMode(id);':
    'fallback inside switchModeAwaited() for doubles without switchMode (plan-776 regenerate run)',
  'src/core/hmi/scene/scene-store.ts::if (this._viewer.modes.has(mode)) this._viewer.modes.setMode(mode);':
    'safety net — catalogue mode after a load, nothing reads activeMode afterwards',
  'src/core/rv-plugin-context.ts::set: (id: ModeId) => mgr.setMode(id),':
    'safety net — synchronous plugin API ctx.modes.set(); documented: a lazy mode switches later',
  "src/main.ts::if (viewer.modes.has('hmi')) viewer.modes.setMode('hmi');":
    'boot failure path — hmi has no on-demand feature',
  'src/main.ts::viewer.modes.setMode(lockedTarget);':
    'boot failure path under a kiosk lock — runs only once isModeReady(lockedTarget)',
  'src/main.ts::viewer.modes.setMode(bootTarget.mode);':
    'AWAITED — the boot block awaits features.ensureForMode(bootTarget.mode) right before',
  "src/plugins/layout-planner/index.ts::this._viewer?.modes.setMode('planner');":
    'safety net — planner is never lazy',
  'src/plugins/mcp-bridge/rv-mcp-editor-tools.ts::v.modes.setMode(fallbackMode(v));':
    'safety net — leaving the editor for hmi/planner (never lazy)',
  'src/plugins/mcp-bridge/rv-mcp-editor-tools.ts::v!.modes.setMode(fallbackMode(v!));':
    'safety net — web_editor_close leaves for hmi/planner (never lazy)',
};

/** Callers that MUST be awaited (plan-652 §2.4.4) — pinned by the awaited form in their file. */
const MUST_AWAIT: Array<{ file: string; pattern: RegExp; min: number; why: string }> = [
  { file: 'src/core/hmi/projects/ProjectsDashboardHost.tsx', pattern: /const pending = setModeAwaited\([^;]*\); if \(pending\) await pending;/g, min: 5, why: 'editor handoff inside withOpenIntentMode (plan-478 F1b); awaited whenever a feature loads (plan-652 Phase 4)' },
  { file: 'src/core/hmi/session-overlay-commands.ts', pattern: /await modes\.setModeAsync\(mode\)/g, min: 1, why: 'workspace.setMode answers the active mode' },
  { file: 'src/plugins/mcp-bridge/rv-mcp-editor-tools.ts', pattern: /await v\.modes\.setModeAsync\('editor'\)/g, min: 1, why: 'web_editor_open awaits the editor context' },
  { file: 'src/main.ts', pattern: /await viewer\.features\.ensureForMode\(bootTarget\.mode\)/g, min: 1, why: 'boot block' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function callers(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'src/core/rv-mode-manager.ts') continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (CALL.test(t)) found.push(`${rel}::${t}`);
    }
  }
  return found.sort();
}

describe('setMode callers (plan-652 §9.10)', () => {
  it('every synchronous caller is classified', () => {
    const unclassified = callers().filter((c) => !(c in SYNCHRONOUS_CALLERS));
    expect(unclassified, 'new setMode( caller — use setModeAsync if it depends on the switch, else pin it here with a reason').toEqual([]);
  });

  it('the pinned list has no stale entries', () => {
    const live = new Set(callers());
    expect(Object.keys(SYNCHRONOUS_CALLERS).filter((k) => !live.has(k))).toEqual([]);
  });

  it.each(MUST_AWAIT)('$file awaits the switch ($why)', ({ file, pattern, min }) => {
    const text = readFileSync(resolve(ROOT, file), 'utf8');
    expect((text.match(pattern) ?? []).length).toBeGreaterThanOrEqual(min);
  });
});
