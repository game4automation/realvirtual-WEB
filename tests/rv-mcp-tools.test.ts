// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-tools.test.ts — Tests for @McpTool / @McpParam decorators and schema generation.
 *
 * Validates:
 * - Decorators store metadata correctly on the class prototype
 * - generateToolSchemas() produces correct JSON format matching Unity
 * - buildToolDispatcher() maps snake_case names to method keys
 * - toSnakeCase() handles camelCase, acronyms, numbers
 * - Tools with no parameters produce empty schema
 */
import { describe, it, expect } from 'vitest';
import {
  McpTool,
  McpParam,
  generateToolSchemas,
  buildToolDispatcher,
  toSnakeCase,
} from '../src/core/engine/rv-mcp-tools';
import type { ToolSchema } from '../src/core/engine/rv-mcp-tools';

// ── Helper class with decorated methods ──

class FakePlugin {
  @McpTool('Get status info')
  async webStatus(): Promise<string> {
    return JSON.stringify({ ok: true });
  }

  @McpTool('Set a boolean signal')
  async webSignalSetBool(
    @McpParam('name', 'Signal name') _name: string,
    @McpParam('value', 'Value to set', 'boolean') _value: boolean,
  ): Promise<string> {
    return '{}';
  }

  @McpTool('Set a float signal')
  async webSignalSetFloat(
    @McpParam('name', 'Signal name') _name: string,
    @McpParam('value', 'Float value', 'number') _value: number,
  ): Promise<string> {
    return '{}';
  }

  @McpTool('Jog a drive')
  async webDriveJog(
    @McpParam('name', 'Drive name') _name: string,
    @McpParam('forward', 'Direction', 'boolean', false) _forward: boolean,
  ): Promise<string> {
    return '{}';
  }
}

// ── toSnakeCase Tests ──

describe('toSnakeCase', () => {
  it('converts simple camelCase', () => {
    expect(toSnakeCase('webDriveList')).toBe('web_drive_list');
  });

  it('converts single word (lowercase)', () => {
    expect(toSnakeCase('status')).toBe('status');
  });

  it('converts PascalCase', () => {
    expect(toSnakeCase('WebStatus')).toBe('web_status');
  });

  it('handles consecutive uppercase (acronyms)', () => {
    // Each uppercase letter gets a separate underscore — consistent behavior
    expect(toSnakeCase('getHTTPUrl')).toBe('get_h_t_t_p_url');
  });

  it('handles single character', () => {
    expect(toSnakeCase('a')).toBe('a');
  });

  it('handles empty string', () => {
    expect(toSnakeCase('')).toBe('');
  });

  it('handles string with numbers', () => {
    expect(toSnakeCase('webDrive2List')).toBe('web_drive2_list');
  });
});

// ── Decorator Metadata Tests ──

describe('@McpTool / @McpParam decorators', () => {
  it('stores tool entries on prototype', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    expect(schemas.length).toBe(4);
  });

  it('generates correct snake_case names', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const names = schemas.map(s => s.name);
    expect(names).toContain('web_status');
    expect(names).toContain('web_signal_set_bool');
    expect(names).toContain('web_signal_set_float');
    expect(names).toContain('web_drive_jog');
  });

  it('stores descriptions', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const statusTool = schemas.find(s => s.name === 'web_status');
    expect(statusTool?.description).toBe('Get status info');
  });

  it('parameter decorators store param metadata', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const setBool = schemas.find(s => s.name === 'web_signal_set_bool');
    expect(setBool).toBeDefined();
    expect(setBool!.inputSchema.properties).toHaveProperty('name');
    expect(setBool!.inputSchema.properties).toHaveProperty('value');
    expect(setBool!.inputSchema.properties.name.type).toBe('string');
    expect(setBool!.inputSchema.properties.value.type).toBe('boolean');
  });

  it('parameter descriptions are stored', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const setBool = schemas.find(s => s.name === 'web_signal_set_bool');
    expect(setBool!.inputSchema.properties.name.description).toBe('Signal name');
    expect(setBool!.inputSchema.properties.value.description).toBe('Value to set');
  });

  it('required params are listed in required array', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const setBool = schemas.find(s => s.name === 'web_signal_set_bool');
    expect(setBool!.inputSchema.required).toContain('name');
    expect(setBool!.inputSchema.required).toContain('value');
  });

  it('optional params are NOT in required array', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const jog = schemas.find(s => s.name === 'web_drive_jog');
    expect(jog!.inputSchema.required).toContain('name');
    expect(jog!.inputSchema.required).not.toContain('forward');
  });
});

// ── generateToolSchemas Tests ──

describe('generateToolSchemas', () => {
  it('produces correct JSON structure', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    for (const schema of schemas) {
      expect(schema).toHaveProperty('name');
      expect(schema).toHaveProperty('description');
      expect(schema).toHaveProperty('inputSchema');
      expect(schema.inputSchema.type).toBe('object');
      expect(schema.inputSchema).toHaveProperty('properties');
      expect(schema.inputSchema).toHaveProperty('required');
    }
  });

  it('tools with no params produce empty properties and required', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const statusTool = schemas.find(s => s.name === 'web_status');
    expect(statusTool).toBeDefined();
    expect(Object.keys(statusTool!.inputSchema.properties)).toHaveLength(0);
    expect(statusTool!.inputSchema.required).toHaveLength(0);
  });

  it('returns empty array for undecorated class', () => {
    class PlainClass {}
    const schemas = generateToolSchemas(new PlainClass());
    expect(schemas).toHaveLength(0);
  });

  it('schemas match expected format for Unity compatibility', () => {
    const schemas = generateToolSchemas(new FakePlugin());
    const setFloat = schemas.find(s => s.name === 'web_signal_set_float') as ToolSchema;
    expect(setFloat).toEqual({
      name: 'web_signal_set_float',
      description: 'Set a float signal',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Signal name' },
          value: { type: 'number', description: 'Float value' },
        },
        required: ['name', 'value'],
      },
    });
  });
});

// ── buildToolDispatcher Tests ──

describe('buildToolDispatcher', () => {
  it('returns a Map with snake_case keys', () => {
    const dispatcher = buildToolDispatcher(new FakePlugin());
    expect(dispatcher).toBeInstanceOf(Map);
    expect(dispatcher.has('web_status')).toBe(true);
    expect(dispatcher.has('web_signal_set_bool')).toBe(true);
    expect(dispatcher.has('web_signal_set_float')).toBe(true);
    expect(dispatcher.has('web_drive_jog')).toBe(true);
  });

  it('maps to correct method keys', () => {
    const dispatcher = buildToolDispatcher(new FakePlugin());
    expect(dispatcher.get('web_status')?.methodKey).toBe('webStatus');
    expect(dispatcher.get('web_signal_set_bool')?.methodKey).toBe('webSignalSetBool');
  });

  it('stores correct param names', () => {
    const dispatcher = buildToolDispatcher(new FakePlugin());
    expect(dispatcher.get('web_signal_set_bool')?.paramNames).toEqual(['name', 'value']);
    expect(dispatcher.get('web_status')?.paramNames).toEqual([]);
  });

  it('returns empty Map for undecorated class', () => {
    class PlainClass {}
    const dispatcher = buildToolDispatcher(new PlainClass());
    expect(dispatcher.size).toBe(0);
  });
});
