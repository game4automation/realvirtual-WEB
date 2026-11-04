// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The rv-odt description strings are a lazy chunk (startup-bundle budget): until
 * `ensureDescriptions()` resolved, descriptions read as ''; afterwards (and always through the MCP
 * `web_component_schema` tool, which awaits it) they are the exact strings of rv-odt.json.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import rvOdt from '../schema/v1/rv-odt.json';

type OdtDefs = Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
const DEFS = (rvOdt as unknown as { $defs: OdtDefs }).$defs;

beforeEach(() => {
  vi.resetModules();
});

async function fresh() {
  return import('../src/core/engine/rv-component-schema-info');
}

describe('lazy rv-odt descriptions', () => {
  it('are empty before ensureDescriptions and complete after', async () => {
    const info = await fresh();
    expect(info.descriptionsLoaded()).toBe(false);
    expect(info.describeComponentType('Drive', null)!.description).toBe('');
    expect(info.describeComponentType('Drive', null)!.fields.every((f) => f.description === '')).toBe(true);

    await info.ensureDescriptions();
    expect(info.descriptionsLoaded()).toBe(true);
    const drive = info.describeComponentType('Drive', null)!;
    expect(drive.description).toBe(DEFS.Drive.description);
    for (const f of drive.fields) {
      expect(f.description, `Drive.${f.name}`).toBe(DEFS.Drive.properties![f.name].description ?? '');
    }
    expect(info.listComponentTypes().find((t) => t.type === 'Kinematic')!.description).toBe(DEFS.Kinematic.description);
  });

  it('ensureDescriptions is idempotent', async () => {
    const info = await fresh();
    await Promise.all([info.ensureDescriptions(), info.ensureDescriptions()]);
    await info.ensureDescriptions();
    expect(info.descriptionsLoaded()).toBe(true);
  });

  it('the MCP describe tool carries the descriptions without the caller loading them', async () => {
    await fresh();
    const { McpComponentSchemaTool } = await import('../src/plugins/mcp-bridge/rv-mcp-component-schema-tool');
    const { descriptionsLoaded } = await import('../src/core/engine/rv-component-schema-info');
    expect(descriptionsLoaded()).toBe(false);
    const t = new McpComponentSchemaTool(async () => '');
    const one = JSON.parse(await t.webComponentSchema('Drive')) as { description: string; fields: { name: string; description: string }[] };
    expect(one.description).toBe(DEFS.Drive.description);
    expect(one.fields.some((f) => f.description.length > 0)).toBe(true);
    const all = JSON.parse(await t.webComponentSchema(undefined as unknown as string)) as { types: { type: string; description: string }[] };
    expect(all.types.find((x) => x.type === 'Kinematic')!.description).toBe(DEFS.Kinematic.description);
  });
});
