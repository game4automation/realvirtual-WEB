// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-517 §9.1 — `web_component_schema(type?)`, the tool contract.
 *
 * Fields come from rv-odt.json, rules from the specification.md annotations
 * (lazy chunk). Beyond the structural drift test (component-schema-rules-sync),
 * the assertions here are SEMANTIC: the Drive note really states the mirrored
 * X axis, the cylinder rule really asks for a Drive on the same node — so a
 * rule block that loses its meaning fails here, not in review.
 *
 * Community-safe: no private import. The command-acceptance half (every listed
 * authorable type is taken by `editor.addComponent`) is the private-dependent
 * sibling `mcp-component-schema-authoring.test.ts`.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import specText from '../schema/v1/specification.md?raw';
// Side-effect import: registers every built-in component type and capability,
// exactly as a running viewer has them before any MCP call can arrive.
import '../src/core/engine/rv-scene-loader';
import {
  getTypesWithCapability,
  registerComponentSchema,
} from '../src/core/engine/rv-component-registry';
import {
  describeComponentType,
  isDriveExtension,
  listComponentTypes,
  type ComponentSchemaInfo,
  type ComponentTypeSummary,
} from '../src/core/engine/rv-component-schema-info';
import { McpComponentSchemaTool } from '../src/plugins/mcp-bridge/rv-mcp-component-schema-tool';
import { createMcpDelegates } from '../src/plugins/mcp-bridge/rv-mcp-instances';

/** A registered inline-only type (no rv-odt `$def`) — proves the inline fallback. */
const FIXTURE = 'Plan517InlineFixture';

beforeAll(() => {
  registerComponentSchema(FIXTURE, {
    NoDefault: { type: 'number', unit: 'mm' },
    Hidden: { type: 'string', default: 'x', scope: 'none' },
    Mode: { type: 'enum', enumMap: { Fast: 'fast', Slow: 'slow' }, default: 'fast' },
  }, { authorable: true });
});

function tool(loader = vi.fn(async () => specText)): { t: McpComponentSchemaTool; loader: typeof loader } {
  return { t: new McpComponentSchemaTool(loader), loader };
}

async function list(t: McpComponentSchemaTool): Promise<ComponentTypeSummary[]> {
  const res = JSON.parse(await t.webComponentSchema(undefined as unknown as string)) as { types: ComponentTypeSummary[] };
  return res.types;
}

async function detail(t: McpComponentSchemaTool, type: string): Promise<ComponentSchemaInfo> {
  return JSON.parse(await t.webComponentSchema(type)) as ComponentSchemaInfo;
}

const fieldOf = (info: ComponentSchemaInfo, name: string) => info.fields.find((f) => f.name === name);
const mentions = (lines: string[], ...needles: string[]) =>
  lines.some((l) => needles.every((n) => l.includes(n)));

// Types without an rv-odt `$def` carry no description (F4: empty string).
// `WebLabel` (plan-529) is WEB-only with an inline schema, like NodeKnowledge.
const INLINE_TYPES_WITHOUT_DESCRIPTION = new Set(['NodeKnowledge', 'WebLabel', FIXTURE]);

describe('web_component_schema — list (F1, F7)', () => {
  it('lists every authorable type, each with a description unless it is an inline type', async () => {
    const { t } = tool();
    const types = await list(t);
    const byType = new Map(types.map((s) => [s.type, s]));
    for (const type of getTypesWithCapability('authorable')) {
      const s = byType.get(type);
      expect(s, `${type} missing from the list`).toBeTruthy();
      expect(s!.authorable).toBe(true);
      expect(s!.createVia).toBeUndefined();
      if (!INLINE_TYPES_WITHOUT_DESCRIPTION.has(type)) {
        expect(s!.description.length, `${type} has no description`).toBeGreaterThan(0);
      } else {
        expect(s!.description).toBe('');
      }
    }
    expect(types.map((s) => s.type)).toEqual([...types.map((s) => s.type)].sort((a, b) => a.localeCompare(b)));
  });

  it('Kinematic is listed as NOT authorable, with the tool that creates it', async () => {
    const { t } = tool();
    const kin = (await list(t)).find((s) => s.type === 'Kinematic');
    expect(kin).toMatchObject({ authorable: false, createVia: 'web_editor_kinematize' });
  });

  it('the list call never loads the specification (lazy chunk)', async () => {
    const { t, loader } = tool();
    await list(t);
    await t.webComponentSchema('');
    expect(loader).not.toHaveBeenCalled();
    await detail(t, 'Drive');
    await detail(t, 'Sensor');
    expect(loader).toHaveBeenCalledTimes(1); // loaded once, then cached
  });

  it('requiresDriveOnSameNode is the SAME function the inspector gate uses', async () => {
    const { t } = tool();
    for (const s of await list(t)) {
      expect(s.requiresDriveOnSameNode, s.type).toBe(isDriveExtension(s.type));
    }
    const types = new Map((await list(t)).map((s) => [s.type, s]));
    expect(types.get('Drive_Cylinder')!.requiresDriveOnSameNode).toBe(true);
    expect(types.get('Drive')!.requiresDriveOnSameNode).toBe(false);
  });
});

describe('web_component_schema — detail (F2, F5, F6)', () => {
  it('Drive: Direction enum is the raw wire enum; a note states LinearX = three.js −X', async () => {
    const info = await detail(tool().t, 'Drive');
    const dir = fieldOf(info, 'Direction')!;
    expect(dir.type).toBe('enum');
    expect(dir.enum).toEqual(['LinearX', 'LinearY', 'LinearZ', 'RotationX', 'RotationY', 'RotationZ', 'Virtual']);
    expect(dir.enum).not.toContain('0');
    expect(dir.description.length).toBeGreaterThan(0);
    expect(mentions(info.notes, 'LinearX', '−X'), JSON.stringify(info.notes)).toBe(true);
    expect(fieldOf(info, 'TargetSpeed')).toMatchObject({ type: 'number', default: 100 });
  });

  it('Drive_Cylinder: needs a Drive on the same node; MinPos/MaxPos/TimeOut/TimeIn present', async () => {
    const info = await detail(tool().t, 'Drive_Cylinder');
    expect(info.requiresDriveOnSameNode).toBe(true);
    for (const f of ['MinPos', 'MaxPos', 'TimeOut', 'TimeIn']) expect(fieldOf(info, f), f).toBeTruthy();
    expect(fieldOf(info, 'MaxPos')).toMatchObject({ type: 'number', default: 100 });
    expect(mentions(info.rules, '`Drive`', 'same node'), JSON.stringify(info.rules)).toBe(true);
    expect(fieldOf(info, 'Out')!.type).toBe('ComponentReference');
  });

  it('TransportSurface: DriveReference.refType is Drive; a note names the findInParent fallback', async () => {
    const info = await detail(tool().t, 'TransportSurface');
    expect(fieldOf(info, 'DriveReference')!.refType).toBe('Drive');
    expect(mentions(info.notes, 'DriveReference', 'findInParent'), JSON.stringify(info.notes)).toBe(true);
    expect(fieldOf(info, 'TransportDirection')).toMatchObject({ type: 'Vector3', unityCoords: true });
  });

  it('Drive_Gear: MasterDrive.refType is Drive', async () => {
    const info = await detail(tool().t, 'Drive_Gear');
    expect(fieldOf(info, 'MasterDrive')!.refType).toBe('Drive');
    expect(mentions(info.rules, 'GearFactor')).toBe(true);
  });

  it('Kinematic: Parent is a plain string without refType; a rule explains the string path', async () => {
    const info = await detail(tool().t, 'Kinematic');
    expect(info).toMatchObject({ authorable: false, createVia: 'web_editor_kinematize' });
    const parent = fieldOf(info, 'Parent')!;
    expect(parent.type).toBe('string');
    expect(parent.refType).toBeUndefined();
    expect(mentions(info.rules, '`Parent`', 'STRING'), JSON.stringify(info.rules)).toBe(true);
    expect(mentions(info.rules, '`KinematicParentEnable`')).toBe(true);
  });

  it('Source: ThisObjectAsMU carries no refType; a rule explains the name/path string', async () => {
    const info = await detail(tool().t, 'Source');
    expect(fieldOf(info, 'ThisObjectAsMU')!.refType).toBeUndefined();
    expect(mentions(info.rules, '`ThisObjectAsMU`', 'STRING') || mentions(info.rules, '`ThisObjectAsMU`', 'string'))
      .toBe(true);
  });

  it('Group: described from its rv-odt $def, description names Group_1', async () => {
    const info = await detail(tool().t, 'Group');
    expect(info.description).toContain('Group_1');
    expect(info.description).not.toMatch(/'Group1'/);
    expect(fieldOf(info, 'GroupName')).toMatchObject({ type: 'string', default: 'Group' });
    expect(fieldOf(info, 'GroupName')!.description.length).toBeGreaterThan(0);
    expect(mentions(info.rules, '`Group_N`')).toBe(true);
  });

  it('inline fixture: exact field set and metadata from the registered schema', async () => {
    const info = await detail(tool().t, FIXTURE);
    expect(info.fields).toEqual([
      { name: 'NoDefault', type: 'number', unit: 'mm', description: '' },
      { name: 'Hidden', type: 'string', default: 'x', scope: 'none', description: '' },
      { name: 'Mode', type: 'enum', default: 'fast', enum: ['Fast', 'Slow'], description: '' },
    ]);
    expect(info).toMatchObject({ authorable: true, description: '', rules: [], notes: [] });
  });

  it('NodeKnowledge (inline): enums complete', async () => {
    const info = await detail(tool().t, 'NodeKnowledge');
    expect(fieldOf(info, 'Author')!.enum).toEqual(['agent', 'user']);
    expect(fieldOf(info, 'Confidence')!.enum).toEqual(['observed', 'inferred', 'unverified']);
    expect(info.fields.map((f) => f.name).sort()).toEqual(['Author', 'Confidence', 'Note', 'NodeIdAtWrite', 'UpdatedAt'].sort());
  });

  it('every F5 type carries at least one rule', () => {
    for (const type of ['Drive', 'Drive_Cylinder', 'Drive_Simple', 'Drive_Gear', 'Kinematic', 'Group',
      'TransportSurface', 'Sensor', 'Source', 'MU', 'Grip']) {
      const info = describeComponentType(type, specText);
      expect(info, type).not.toBeNull();
      expect(info!.rules.length, `${type} has no rule`).toBeGreaterThan(0);
    }
  });

  it('unknown type → error + availableTypes', async () => {
    const res = JSON.parse(await tool().t.webComponentSchema('NoSuchThing')) as { error: string; availableTypes: string[] };
    expect(res.error).toContain('NoSuchThing');
    expect(res.availableTypes).toEqual(listComponentTypes().map((s) => s.type));
    expect(res.availableTypes).toContain('Drive');
  });

  it('a failing spec load still answers the fields, with a warning, and retries next time', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValue(specText);
    const t = new McpComponentSchemaTool(loader);
    const first = JSON.parse(await t.webComponentSchema('Drive')) as ComponentSchemaInfo & { warning?: string };
    expect(first.fields.length).toBeGreaterThan(0);
    expect(first.rules).toEqual([]);
    expect(first.warning).toBeTruthy();
    const second = await detail(t, 'Drive');
    expect(second.rules.length).toBeGreaterThan(0);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('web_component_schema — production wiring', () => {
  it('is announced through the delegate list and loads the real spec chunk lazily', async () => {
    const delegates = createMcpDelegates(() => undefined);
    const inst = delegates['McpComponentSchemaTool'] as McpComponentSchemaTool;
    expect(inst).toBeInstanceOf(McpComponentSchemaTool);
    const info = await detail(inst, 'Drive_Cylinder');
    expect(info.rules.length).toBeGreaterThan(0);
  });
});
