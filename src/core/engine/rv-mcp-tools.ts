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

import type { DocumentHandle } from '../editor/rv-editor-guard-core';

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
  /** plan-499: the command(s) this tool is a view of (metadata only, not on the wire). */
  command?: ToolCommandBinding;
  /** plan-626 F1: explicit tool class (metadata only, never announced — CONNECT reads the allowlist). */
  toolClass?: McpToolClassName;
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
    additionalProperties?: boolean;
  };
  /** Standard MCP annotations; forwarded verbatim to `tools/list` by both bridges. */
  annotations?: McpToolAnnotations;
  /** Per-call timeout hint for the bridge; stripped before the MCP client sees the tool list. */
  timeoutMs?: number;
  /**
   * `false` hides an announced tool from the client list; the bridges keep it
   * callable but leave it out of `tools/list`. Absent = listed.
   */
  listed?: boolean;
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
  /**
   * plan-499: the command (rv-command-registry) this tool body dispatches —
   * a command id for a 1:1 tool (the wire args ARE the command args), or a
   * branch table for a multiplexer (`web_editor_pivot`, `web_editor_shortcut`).
   * Metadata only — never announced to the client. The bridge resolves it ONCE
   * per call ({@link resolveBinding}) before any choreography, and hands the
   * result to the body as the trailing `McpCallContext` argument.
   */
  command?: ToolCommandBinding;
  /**
   * plan-626 F1: explicit tool class, only where the derivation in
   * `rv-mcp-tool-class.ts` (readOnly → command prefix → domain) would be wrong.
   * Metadata only — never announced; CONNECT reads the generated allowlist.
   */
  toolClass?: McpToolClassName;
}

/** plan-626 F1: the tool classes (`rv-mcp-tool-class.ts` derives and documents them). */
export type McpToolClassName = 'read' | 'edit' | 'sim' | 'signal' | 'save' | 'destructive' | 'file';

// ── Command bindings (plan-499) ──

/**
 * One branch of a multiplexer binding: which wire values select it, which
 * command it dispatches and how the WIRE params become the COMMAND args.
 *
 * WIRE params = the tool's `@McpParam` definitions; COMMAND args = the object
 * the command's `run()` receives. A branch is the transformation between them.
 */
export interface BindingBranch {
  /** Wire values (after `normalize`) that select this branch, e.g. `{ mode: 'bottom' }`. `{}` = always. */
  readonly when: Readonly<Record<string, string>>;
  /** Command id. */
  readonly id: string;
  /**
   * Wire -> command args. Applies defaults. THROWS (with the param name in the
   * message) when a value listed in `requires` is missing — the binding then
   * resolves to a refusal and nothing is dispatched.
   */
  readonly args: (wire: Readonly<Record<string, unknown>>) => unknown;
  /** Wire params this branch needs beyond the tool's required ones (e.g. `targetPath`). */
  readonly requires?: readonly string[];
  /** Target button for choreography + afterglow; default: the command's own `buttonKey(args)`. */
  readonly buttonKey?: string | ((wire: Readonly<Record<string, unknown>>) => string | null);
}

/** A branch table. `normalize` maps the raw wire once (case, aliases) before `when` is matched. */
export interface BranchBinding {
  readonly branches: readonly BindingBranch[];
  readonly normalize?: (wire: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
}

export type ToolCommandBinding = string | BranchBinding;

/** What ONE resolution of a binding produced for one call. */
export interface ResolvedBinding {
  /** The chosen command, or null (unbound / no branch matched / a required value is missing). */
  readonly bound: { readonly id: string; readonly args: unknown; readonly buttonKey: string | null } | null;
  /** Why `bound` is null when a branch matched but refused (missing required value). */
  readonly refusal: string | null;
}

/** Missing-value test shared by the branch tables and the parity gate. */
export function isMissingWireValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Resolve a tool's binding against the call's wire args — THE one resolution
 * (plan-499 F15). A 1:1 binding passes the wire through; a branch table picks
 * the first branch whose `when` matches and transforms. `buttonKey` stays null
 * when the branch does not name one — the registry then asks the command's
 * own `buttonKey(args)`.
 */
export function resolveBinding(
  binding: ToolCommandBinding | undefined,
  wire: Readonly<Record<string, unknown>>,
): ResolvedBinding {
  if (!binding) return { bound: null, refusal: null };
  if (typeof binding === 'string') {
    return { bound: { id: binding, args: { ...wire }, buttonKey: null }, refusal: null };
  }
  const w = binding.normalize ? binding.normalize(wire) : wire;
  for (const br of binding.branches) {
    const match = Object.entries(br.when).every(([k, v]) => String(w[k] ?? '') === v);
    if (!match) continue;
    let args: unknown;
    try {
      args = br.args(w);
    } catch (e) {
      return { bound: null, refusal: e instanceof Error ? e.message : String(e) };
    }
    const bk = typeof br.buttonKey === 'function' ? br.buttonKey(w) : (br.buttonKey ?? null);
    return { bound: { id: br.id, args, buttonKey: bk }, refusal: null };
  }
  return { bound: null, refusal: null };
}

/**
 * The per-call context the bridge builds ONCE, before any wait, and appends as
 * the LAST argument of `method.apply` (plan-499 F21). Bound tool bodies take it
 * as an optional trailing `ctx?: McpCallContext` and dispatch it unchanged —
 * no second resolution, no global hand-off.
 */
export interface McpCallContext {
  readonly callId: string;
  /** The one binding resolution; null = unbound tool or no branch. */
  readonly bound: ResolvedBinding['bound'];
  /** Refusal of a matched branch (missing required value), else null. */
  readonly refusal: string | null;
  /** Document identity at call begin (R5), null outside a document. */
  readonly handle: DocumentHandle | null;
  /** Selection at call begin. */
  readonly selection: readonly string[];
  /**
   * plan-641 F2 — the meta arguments of the call (`_reason/_source/_confidence`),
   * split off the wire centrally in the bridge before the binding resolved. Only
   * the macro recorder reads them; the tool body never sees them.
   */
  readonly meta?: { readonly reason?: string; readonly source?: string; readonly confidence?: 'observed' | 'inferred' | 'unverified' } | null;
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
      ...(options?.command ? { command: options.command } : {}),
      ...(options?.toolClass ? { toolClass: options.toolClass } : {}),
    });
  };
}

/** plan-499: the raw tool entries of a decorated instance (parity gate, standalone binding). */
export function listToolEntries(instance: object): readonly ToolEntry[] {
  const proto = Object.getPrototypeOf(instance);
  return (proto as Record<symbol, ToolEntry[]>)[TOOL_META_KEY] ?? [];
}

/** plan-499: the entry of one decorated method, by method name. */
export function getToolEntry(instance: object, methodKey: string): ToolEntry | undefined {
  return listToolEntries(instance).find((e) => e.methodKey === methodKey);
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
  command?: ToolCommandBinding;
}> {
  const proto = Object.getPrototypeOf(instance);
  const entries: ToolEntry[] = (proto as Record<symbol, ToolEntry[]>)[TOOL_META_KEY] ?? [];
  const map = new Map<string, { methodKey: string; paramNames: string[]; command?: ToolCommandBinding }>();
  for (const entry of entries) {
    map.set(entry.name, {
      methodKey: entry.methodKey,
      paramNames: entry.params.map((p) => p.name),
      ...(entry.command ? { command: entry.command } : {}),
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
  command?: ToolCommandBinding;
}> {
  const map = new Map<string, { instance: object; methodKey: string; paramNames: string[]; command?: ToolCommandBinding }>();
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
