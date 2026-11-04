// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-626 9.6 — the WEB skills (`skills/realvirtual-web-*\/SKILL.md`) say only true things.
 *
 *  - every `web_*` / native tool name a skill mentions exists,
 *  - every command a skill runs as `web_execute("<id>", …)` is in the command registry,
 *  - every trap marked `<!-- fact:<id> -->` has an executable check below, and every check's
 *    marker is still in a skill (a deleted trap must take its check with it).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { listToolEntries, type ToolEntry } from '../src/core/engine/rv-mcp-tools';
import { DriveDirection, directionToGltfAxis } from '../src/core/engine/rv-coordinate-utils';
import { applySchema, type ComponentSchema } from '../src/core/engine/rv-component-registry';
import { isComponentReference } from '../src/core/engine/rv-node-path-rewrite.mjs';
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
import { NATIVE_TOOL_CLASSES, resolveToolClass } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';

const SKILLS_DIR = resolve(__dirname, '../skills');

interface Skill { dir: string; text: string }

let skills: Skill[];
let tools: Map<string, ToolEntry>;

beforeAll(async () => {
  skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('realvirtual-web-'))
    .map((d) => ({ dir: d.name, text: readFileSync(resolve(SKILLS_DIR, d.name, 'SKILL.md'), 'utf8') }));
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
  tools = new Map();
  for (const i of new McpBridgePlugin().mcpToolInstances) for (const e of listToolEntries(i)) tools.set(e.name, e);
}, 240_000);

/** Executable checks, one per trap marker. */
const FACTS: Record<string, (skill: string) => void> = {
  'linearx-minus-x': () => {
    expect(directionToGltfAxis(DriveDirection.LinearX).toArray()).toEqual([-1, 0, 0]);
    expect(directionToGltfAxis(DriveDirection.RotationY).toArray()).toEqual([0, -1, 0]);
    expect(directionToGltfAxis(DriveDirection.RotationZ).toArray()).toEqual([0, 0, -1]);
  },
  'componentref-object-form': () => {
    expect(isComponentReference('Cell/Drive')).toBe(false);
    expect(isComponentReference({ type: 'ComponentReference', path: 'Cell/Drive' })).toBe(true);
  },
  'rv-extras-unity-vectors': () => {
    const schema: ComponentSchema = { Offset: { type: 'vector3', unityCoords: true }, Plain: { type: 'vector3' } };
    const inst: Record<string, unknown> = {};
    applySchema(inst, schema, { Offset: { x: 1, y: 2, z: 3 }, Plain: { x: 1, y: 2, z: 3 } });
    expect((inst.Offset as { toArray(): number[] }).toArray()).toEqual([-1, 2, 3]);
    expect((inst.Plain as { toArray(): number[] }).toArray()).toEqual([1, 2, 3]);
  },
  'new-asset-empty-first': (skill) => {
    // Separate examples for new and existing assets, and both entry points exist.
    expect(skill).toMatch(/web_document_open\("empty"\)/);
    expect(skill).toMatch(/source: "new"/);
    expect(skill).toMatch(/source: "library"/);
    expect(tools.has('web_document_open')).toBe(true);
    const open = tools.get('web_editor_open')!;
    expect(open.params.map((p) => p.name)).toContain('source');
    expect(open.description).toMatch(/source=new/);
    expect(open.description).toMatch(/source=library/);
  },
  'save-after-each-step': () => {
    const save = tools.get('web_editor_save')!;
    expect(save, 'web_editor_save must exist').toBeTruthy();
    // A listed tool (not a hidden command alias), classified as the durable step.
    expect(save.command).toBeUndefined();
    expect(resolveToolClass(save)).toBe('save');
  },
};

describe('plan-626 WEB skills', () => {
  it('there are the three skills, each named after its folder', () => {
    expect(skills.map((s) => s.dir).sort()).toEqual([
      'realvirtual-web-commissioning', 'realvirtual-web-layout', 'realvirtual-web-modeling',
    ]);
    for (const s of skills) expect(s.text).toMatch(new RegExp(`^---\\r?\\nname: ${s.dir}\\r?\\n`));
  });

  it('every tool a skill names exists', () => {
    const missing: string[] = [];
    for (const s of skills) {
      for (const m of s.text.matchAll(/\b(web_[a-z0-9_]+|signal_[a-z_]+)\b/g)) {
        const name = m[1];
        if (!tools.has(name) && !(name in NATIVE_TOOL_CLASSES)) missing.push(`${s.dir}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every command a skill executes is registered', () => {
    const missing: string[] = [];
    for (const s of skills) {
      for (const m of s.text.matchAll(/web_execute\("([a-zA-Z.]+)"/g)) {
        if (!commandRegistry.get(m[1])) missing.push(`${s.dir}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every marked trap has a passing check, and every check a trap', () => {
    const marked = new Map<string, string>();
    for (const s of skills) for (const m of s.text.matchAll(/<!-- fact:([a-z0-9-]+) -->/g)) marked.set(m[1], s.text);
    expect([...marked.keys()].sort()).toEqual(Object.keys(FACTS).sort());
    for (const [id, text] of marked) FACTS[id](text);
  });
});
