// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-tools.ts — TypeScript decorator system for MCP tool auto-discovery.
 *
 * Mirrors Unity's [McpTool] / [McpParam] C# attributes. Decorated methods on
 * an RVBehavior subclass are automatically collected into JSON tool schemas
 * and sent to the Python MCP server via WebSocket on connect.
 *
 * Usage:
 *   class MyPlugin extends RVBehavior {
 *     @McpTool("List all drives with positions")
 *     async webDriveList(): Promise<string> { ... }
 *
 *     @McpTool("Set a boolean signal")
 *     async webSignalSetBool(
 *       @McpParam("name", "Signal name") name: string,
 *       @McpParam("value", "Value to set", "boolean") value: boolean
 *     ): Promise<string> { ... }
 *   }
 */

// ── Metadata types ──

export interface ToolEntry {
  /** snake_case tool name (auto-converted from camelCase method name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Original method name on the class */
  methodKey: string;
  /** Ordered parameter definitions */
  params: ParamEntry[];
}

export interface ParamEntry {
  /** Parameter name (must match the method argument name) */
  name: string;
  /** JSON Schema type */
  type: 'string' | 'number' | 'boolean' | 'integer';
  /** Human-readable description */
  description: string;
  /** Whether the parameter is required (default: true) */
  required: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// ── Metadata storage ──

const TOOL_META_KEY = Symbol('McpTools');
const PARAM_META_KEY = Symbol('McpParams');

/** Get or create tool entry list for a class prototype. */
function getToolEntries(target: object): ToolEntry[] {
  if (!Object.prototype.hasOwnProperty.call(target, TOOL_META_KEY)) {
    Object.defineProperty(target, TOOL_META_KEY, {
      value: [],
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return (target as Record<symbol, ToolEntry[]>)[TOOL_META_KEY];
}

/** Get or create param entry map for a method. Key = methodKey, value = param entries indexed by position. */
function getParamEntries(target: object): Map<string, Map<number, ParamEntry>> {
  if (!Object.prototype.hasOwnProperty.call(target, PARAM_META_KEY)) {
    Object.defineProperty(target, PARAM_META_KEY, {
      value: new Map(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return (target as Record<symbol, Map<string, Map<number, ParamEntry>>>)[PARAM_META_KEY];
}

// ── Helpers ──

/** Convert camelCase to snake_case. */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

// ── Decorators ──

/**
 * Marks a method as an MCP tool (like Unity's [McpTool]).
 *
 * The method must return `Promise<string>` (JSON-encoded result).
 * The tool name is auto-generated as snake_case from the method name.
 */
export function McpTool(description: string) {
  return function (_target: object, propertyKey: string, _descriptor: PropertyDescriptor) {
    const entries = getToolEntries(_target);
    const paramMap = getParamEntries(_target);

    // Collect params registered via @McpParam for this method
    const methodParams = paramMap.get(propertyKey);
    const params: ParamEntry[] = [];
    if (methodParams) {
      // Sort by parameter index
      const sorted = [...methodParams.entries()].sort(([a], [b]) => a - b);
      for (const [, entry] of sorted) {
        params.push(entry);
      }
    }

    entries.push({
      name: toSnakeCase(propertyKey),
      description,
      methodKey: propertyKey,
      params,
    });
  };
}

/**
 * Documents a method parameter for MCP schema generation (like Unity's [McpParam]).
 *
 * Must be applied BEFORE @McpTool on the method (decorators evaluate bottom-up
 * for parameters, top-down for methods — so @McpParam runs first).
 */
export function McpParam(
  name: string,
  description: string,
  type: ParamEntry['type'] = 'string',
  required = true,
) {
  return function (_target: object, propertyKey: string, parameterIndex: number) {
    const paramMap = getParamEntries(_target);
    if (!paramMap.has(propertyKey)) {
      paramMap.set(propertyKey, new Map());
    }
    paramMap.get(propertyKey)!.set(parameterIndex, {
      name,
      type,
      description,
      required,
    });
  };
}

// ── Schema generation ──

/**
 * Generate JSON tool schemas from decorated methods on an instance.
 * Output format matches Unity's `McpToolRegistry.GetToolSchemas()`.
 */
export function generateToolSchemas(instance: object): ToolSchema[] {
  const proto = Object.getPrototypeOf(instance);
  const entries: ToolEntry[] = (proto as Record<symbol, ToolEntry[]>)[TOOL_META_KEY] ?? [];
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        entry.params.map((p) => [p.name, { type: p.type, description: p.description }]),
      ),
      required: entry.params.filter((p) => p.required).map((p) => p.name),
    },
  }));
}

/**
 * Build a lookup map from snake_case tool name → { methodKey, paramNames }.
 * Used at runtime to dispatch incoming tool calls to the correct method.
 */
export function buildToolDispatcher(instance: object): Map<string, {
  methodKey: string;
  paramNames: string[];
}> {
  const proto = Object.getPrototypeOf(instance);
  const entries: ToolEntry[] = (proto as Record<symbol, ToolEntry[]>)[TOOL_META_KEY] ?? [];
  const map = new Map<string, { methodKey: string; paramNames: string[] }>();
  for (const entry of entries) {
    map.set(entry.name, {
      methodKey: entry.methodKey,
      paramNames: entry.params.map((p) => p.name),
    });
  }
  return map;
}
