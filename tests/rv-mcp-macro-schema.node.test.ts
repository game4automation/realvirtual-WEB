// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.2 — the catalogue announces the meta arguments
 * (`_reason` / `_source` / `_confidence`) exactly where a call can become a
 * macro line: on `web_execute` / `web_batch` (own params) and on the bound
 * aliases of `macro: true` commands (added by the bridge, stripped again in
 * `_handleCall`). Read-only tools and runtime commands (signals, simulation,
 * view, undo/redo) never get them, and the classification is an explicit flag,
 * never derived (risk table: "Laufzeit als Modell").
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildMultiDispatcher, generateToolSchemasMulti, type ToolSchema } from '../src/core/engine/rv-mcp-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureMechanismCommandsRegistered } from '../src/core/hmi/mechanism-command-descriptors';
import {
  isMacroCommand,
  macroCapableToolNames,
  MACRO_META_PROPERTIES,
  withMacroMetaParams,
} from '../src/plugins/mcp-bridge/rv-mcp-command-tools';

let schemas: ToolSchema[];
let byName: Map<string, ToolSchema>;

beforeAll(async () => {
  ensureEditorCommandsRegistered();
  ensureSimCommandsRegistered();
  ensureViewCommandsRegistered();
  ensureSessionOverlayCommandsRegistered();
  ensureComponentCommandsRegistered();
  ensureQueryCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  ensureDesPlcCommandsRegistered();
  ensurePlannerCommandsRegistered();
  ensureMechanismCommandsRegistered();
  const { McpBridgePlugin } = await import('../src/plugins/mcp-bridge-plugin');
  const plugin = new McpBridgePlugin();
  const instances = plugin.mcpToolInstances;
  const dispatcher = buildMultiDispatcher(instances);
  schemas = withMacroMetaParams(generateToolSchemasMulti(instances), macroCapableToolNames(dispatcher, commandRegistry));
  byName = new Map(schemas.map((s) => [s.name, s]));
}, 240_000);

const metaKeys = Object.keys(MACRO_META_PROPERTIES);
const hasMeta = (name: string): boolean => {
  const s = byName.get(name);
  expect(s, name).toBeDefined();
  return metaKeys.every((k) => k in (s!.inputSchema.properties ?? {}));
};

describe('plan-641 §9.2 — meta arguments in the catalogue', () => {
  it('web_execute declares them as optional params (web_batch carries them per step)', () => {
    expect(hasMeta('web_execute')).toBe(true);
    expect(byName.get('web_execute')!.inputSchema.required ?? []).not.toContain('_reason');
  });

  it('retired editor aliases no longer have decorated macro schemas', () => {
    for (const name of ['web_editor_set_field', 'web_editor_add_component', 'web_editor_remove_component',
      'web_editor_rename', 'web_editor_reparent', 'web_editor_transform', 'web_editor_group_assign',
      'web_editor_assign_material', 'web_editor_delete']) {
      expect(byName.has(name), name).toBe(false);
    }
  });

  it('read-only tools never carry them', () => {
    for (const s of schemas) {
      if (s.annotations?.readOnlyHint === true) expect(metaKeys.some((k) => k in (s.inputSchema.properties ?? {})), s.name).toBe(false);
    }
  });

  it('runtime / view / history commands are not macro commands and their tools carry no meta', () => {
    for (const name of ['web_signal_set_bool', 'web_signal_set_float', 'web_sim_play_pause', 'web_sim_reset',
      'web_drive_jog', 'web_view_render_mode', 'web_editor_undo', 'web_editor_redo', 'web_camera_set']) {
      const s = byName.get(name);
      if (!s) continue;
      expect(metaKeys.some((k) => k in (s.inputSchema.properties ?? {})), name).toBe(false);
    }
    for (const id of ['sim.playPause', 'signal.setBool', 'drive.jog', 'editor.undo', 'editor.redo', 'selection.clear', 'editor.wireframe']) {
      expect(isMacroCommand(commandRegistry.get(id)), id).toBe(false);
    }
  });

  it('every macro command is a write (readOnly false) — the flag is explicit', () => {
    const macro = commandRegistry.list().filter((d) => d.macro === true);
    expect(macro.length).toBeGreaterThan(20);
    for (const d of macro) expect(d.readOnly, d.id).toBe(false);
  });
});
