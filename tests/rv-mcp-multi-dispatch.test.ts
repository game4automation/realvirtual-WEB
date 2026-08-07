// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Multi-instance MCP tool dispatch (delegate-object pattern): merged schemas,
 * duplicate-name guard, per-instance dispatch, and the timeoutMs hint.
 */

import { describe, it, expect } from 'vitest';
import {
  McpTool,
  McpParam,
  generateToolSchemasMulti,
  buildMultiDispatcher,
  generateToolSchemas,
} from '../src/core/engine/rv-mcp-tools';

class AlphaTools {
  @McpTool('Alpha one')
  async webAlphaOne(): Promise<string> { return 'alpha-one'; }

  @McpTool('Alpha slow', { timeoutMs: 60_000 })
  async webAlphaSlow(
    @McpParam('n', 'A number', 'number') n: number,
  ): Promise<string> { return `alpha-slow:${n}`; }
}

class BetaTools {
  @McpTool('Beta one')
  async webBetaOne(
    @McpParam('name', 'A name') name: string,
  ): Promise<string> { return `beta-one:${name}`; }
}

class BetaDuplicate {
  @McpTool('Duplicate of alpha one')
  async webAlphaOne(): Promise<string> { return 'dup'; }
}

describe('multi-instance MCP dispatch', () => {
  it('merges schemas from several instances', () => {
    const schemas = generateToolSchemasMulti([new AlphaTools(), new BetaTools()]);
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(['web_alpha_one', 'web_alpha_slow', 'web_beta_one']);
  });

  it('carries timeoutMs into the schema (and only where declared)', () => {
    const schemas = generateToolSchemasMulti([new AlphaTools()]);
    const slow = schemas.find((s) => s.name === 'web_alpha_slow');
    const fast = schemas.find((s) => s.name === 'web_alpha_one');
    expect(slow?.timeoutMs).toBe(60_000);
    expect(fast?.timeoutMs).toBeUndefined();
  });

  it('throws on duplicate tool names across instances', () => {
    expect(() => generateToolSchemasMulti([new AlphaTools(), new BetaDuplicate()]))
      .toThrow(/Duplicate MCP tool name/);
    expect(() => buildMultiDispatcher([new AlphaTools(), new BetaDuplicate()]))
      .toThrow(/Duplicate MCP tool name/);
  });

  it('dispatches to the owning instance with ordered params', async () => {
    const alpha = new AlphaTools();
    const beta = new BetaTools();
    const map = buildMultiDispatcher([alpha, beta]);
    const entry = map.get('web_beta_one')!;
    expect(entry.instance).toBe(beta);
    expect(entry.paramNames).toEqual(['name']);
    const method = (entry.instance as unknown as Record<string, (...a: unknown[]) => Promise<string>>)[entry.methodKey];
    await expect(method.apply(entry.instance, ['x'])).resolves.toBe('beta-one:x');
  });

  it('single-instance schema generation stays intact (regression)', () => {
    const schemas = generateToolSchemas(new BetaTools());
    expect(schemas).toHaveLength(1);
    expect(schemas[0].inputSchema.required).toEqual(['name']);
  });
});
