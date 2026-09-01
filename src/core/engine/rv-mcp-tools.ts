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
  /** Per-call timeout in ms for the Node bridge (overrides its 15 s default). */
  timeoutMs?: number;
  /** Side-effect classification; drives `annotations.readOnlyHint` in discover. */
  readOnly?: boolean;
  /** Irreversibility hint; drives `annotations.destructiveHint` in discover. */
  destructive?: boolean;
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

/**
 * MCP standard tool annotations (spec revision 2025-03-26, unchanged since).
 *
 * `readOnlyHint` is the one the bridge servers act on: it is the write gate, and the MCP client
 * shows it. It is a HINT, never an authorisation boundary — the browser decides what a tool
 * actually does, so a server-side name list would be no stronger. Both bridges therefore treat a
 * missing or false hint as a write (secure by default).
 *
 * `destructiveHint` (plan-713 F3) is announced ONLY where it is true, and it gates nothing. It is
 * the spec's own field for "this write can destroy data the caller did not name", and the client
 * is where a confirmation belongs. Emitting it for every write would make it noise; emitting it
 * for `web_document_update` — the one tool that deletes a file — is what makes it readable.
 *
 * Additive on the wire: `annotations` is already one of the four fields CONNECT projects
 * (`McpServerSetup.cs`), so a second key inside it changes no schema (NF1).
 */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  /** Standard MCP annotations; forwarded verbatim to `tools/list` by both bridges. */
  annotations?: McpToolAnnotations;
  /** Per-call timeout hint for the bridge; stripped before the MCP client sees the tool list. */
  timeoutMs?: number;
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

/** Optional per-tool settings for {@link McpTool}. */
export interface McpToolOptions {
  /** Per-call timeout in ms the bridge should apply (default: its 15 s). */
  timeoutMs?: number;
  /**
   * Side-effect classification, announced as `annotations.readOnlyHint`.
   *
   * `true` only for tools that change NOTHING an operator or a later call can observe — not the
   * model, not signals, not the simulation, and not the viewport. Camera moves, selection and
   * isolation are therefore `false`: they persist nothing, but a watching operator sees the view
   * jump, which is a surprise on a running plant, not a feature.
   *
   * Every tool must set this explicitly — `rv-mcp-tool-conventions.test.ts` fails otherwise. A
   * missing value means "write" everywhere downstream, so an unclassified tool silently
   * disappears for read-only clients instead of leaking a mutation.
   */
  readOnly?: boolean;
  /**
   * Announced as `annotations.destructiveHint` when true, omitted otherwise.
   *
   * For the narrow case the MCP spec means by it: a write that can destroy data the caller did
   * not name in the call. `web_document_update(action=delete)` is one; every ordinary authoring
   * write is not, and marking them all would say nothing.
   */
  destructive?: boolean;
}

/**
 * Marks a method as an MCP tool (like Unity's [McpTool]).
 *
 * The method must return `Promise<string>` (JSON-encoded result).
 * The tool name is auto-generated as snake_case from the method name.
 */
export function McpTool(description: string, options?: McpToolOptions) {
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
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      ...(options?.destructive ? { destructive: true } : {}),
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
    // Emitted for BOTH values, never omitted for `false`: the bridges must be able to tell
    // "classified as a write" apart from "never classified" when a stale browser connects.
    ...(entry.readOnly === undefined ? {} : {
      annotations: {
        readOnlyHint: entry.readOnly,
        // Omitted when false rather than emitted as `false`: unlike `readOnlyHint` no bridge
        // reads this, so "absent" and "false" are the same statement and the shorter one keeps
        // 139 unaffected tools byte-identical in the discover payload.
        ...(entry.destructive ? { destructiveHint: true } : {}),
      },
    }),
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
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

// ── Multi-instance variants (delegate-object pattern) ──
//
// Decorator metadata lives per-prototype, so tools spread across several
// classes (e.g. McpBridgePlugin + McpViewTools + McpEditorTools) are merged
// here. Subclassing does NOT work for splitting — the symbol own-property on
// a subclass prototype would shadow the base list.

/**
 * Generate merged tool schemas from several decorated instances.
 * Throws on duplicate tool names (dev-time guard against silent shadowing).
 */
export function generateToolSchemasMulti(instances: readonly object[]): ToolSchema[] {
  const seen = new Set<string>();
  const out: ToolSchema[] = [];
  for (const instance of instances) {
    for (const schema of generateToolSchemas(instance)) {
      if (seen.has(schema.name)) {
        throw new Error(`Duplicate MCP tool name across instances: ${schema.name}`);
      }
      seen.add(schema.name);
      out.push(schema);
    }
  }
  return out;
}

/**
 * Build a merged dispatcher over several decorated instances. Each entry
 * carries the owning instance so the caller applies the method on it.
 */
export function buildMultiDispatcher(instances: readonly object[]): Map<string, {
  instance: object;
  methodKey: string;
  paramNames: string[];
}> {
  const map = new Map<string, { instance: object; methodKey: string; paramNames: string[] }>();
  for (const instance of instances) {
    for (const [name, entry] of buildToolDispatcher(instance)) {
      if (map.has(name)) {
        throw new Error(`Duplicate MCP tool name across instances: ${name}`);
      }
      map.set(name, { instance, ...entry });
    }
  }
  return map;
}
