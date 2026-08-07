// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-registry.ts — typed, directed connections between WebViewer
 * components (plan-259).
 *
 * A connection is an `RvConnection` EDGE (`{id, source, target, type, config}`,
 * flat edge array = serialization truth, React-Flow pattern) persisted in the
 * rv-ODT `Connections` block (schema/v1/rv-odt.json). Conceptually a
 * connection is a named, bidirectional call: the source invokes the target
 * with request parameters; the target answers — usually DEFERRED — through a
 * reply handle. Two type categories share ONE storage / drag / inspector /
 * cable mechanism:
 *
 *  - BUILT-IN (engine-semantic) types, e.g. `StopOnExit`: registered in code
 *    (`registerBuiltinConnectionType`), they hook into the engine (MU hold).
 *  - USER-DEFINED types: signature lives as DATA in `connectionTypes`
 *    (`{type, request, response}` parameter schemas); the behavior lives in
 *    the scripts on both ends (`self.connection(type).call` / `onRequest`).
 *
 * This module is ENGINE-PURE: no three.js scene access, no viewer import —
 * endpoints and node resolution are injected. Determinism:
 *  - requests are handed over synchronously to the endpoint (which typically
 *    schedules delivery on the target's event list — never re-entrant);
 *  - replies go through an explicit handle (`ConnectionReplyHandle`) that the
 *    receiver calls now or in a later tick — no Promise/await anywhere;
 *  - a reply handle answers exactly once (double reply = warn + no-op) and is
 *    invalidated by `resetRuntime()` (simulation reset) and `clearModel()`;
 *  - a re-entrancy depth guard caps synchronous dispatch cascades over cyclic
 *    edges (A→B→A) — the dispatch terminates instead of hanging.
 */

import type { ScriptMuRef } from '../sdk/rv-script-hook';

// ─── Data model (rv-ODT `Connections` block) ────────────────────────────────

/** Parameter wire types of user-defined connection signatures. */
export type ConnectionParamType = 'bool' | 'int' | 'float' | 'string';

/** One directed connection edge (rv-ODT `$defs/RvConnection`). */
export interface RvConnection {
  /** Stable edge id (unique within the scene). */
  id: string;
  /** Node path of the SOURCE (caller) end. */
  source: string;
  /** Node path of the TARGET (callee) end. */
  target: string;
  /** Connection type name — built-in ('StopOnExit') or user-defined. */
  type: string;
  /** Type-specific per-edge configuration (e.g. ProcessTime). */
  config?: Record<string, unknown>;
}

/** User-defined connection type signature (rv-ODT `$defs/ConnectionType`). */
export interface ConnectionType {
  type: string;
  /** Request parameter schema (name → wire type). */
  request?: Record<string, ConnectionParamType>;
  /** Response parameter schema (name → wire type). */
  response?: Record<string, ConnectionParamType>;
}

/** The rv-ODT `Connections` component payload as carried in GLB extras. */
export interface ParsedConnections {
  connections: RvConnection[];
  connectionTypes: ConnectionType[];
}

/** The built-in StopOnExit type name (engine-semantic, plan-259 F5). */
export const STOP_ON_EXIT_TYPE = 'StopOnExit';

/** Built-in (engine-semantic) connection types registered in code. Their
 *  signature/config schema is code-owned — no `connectionTypes` entry needed. */
export interface BuiltinConnectionTypeDef {
  type: string;
  /** Per-edge config schema rendered by the inspector (typed fields). */
  config?: Record<string, ConnectionParamType>;
  /** Config defaults applied when an edge omits a field. */
  configDefaults?: Record<string, unknown>;
  /** Short description shown in the inspector. */
  description?: string;
}

const builtinTypes = new Map<string, BuiltinConnectionTypeDef>();

/** Register a built-in connection type (module-load side effect, like
 *  `registerComponent`). Re-registration replaces the definition. */
export function registerBuiltinConnectionType(def: BuiltinConnectionTypeDef): void {
  builtinTypes.set(def.type, def);
}

/** All built-in connection type definitions (inspector type picker). */
export function getBuiltinConnectionTypes(): BuiltinConnectionTypeDef[] {
  return [...builtinTypes.values()];
}

registerBuiltinConnectionType({
  type: STOP_ON_EXIT_TYPE,
  config: { ProcessTime: 'float' },
  configDefaults: { ProcessTime: 0 },
  description:
    'Station stop: an MU reaching the connected sensor is held (accumulating '
    + 'surface: single-MU hold, belt keeps running; non-accumulating or '
    + 'instanced MUs: belt stop — a shared drive halts the whole line), handed '
    + 'to the station script via onArrival(mu) and released with mu.release().',
});

// ─── Defensive parsing (GLB extras → ParsedConnections) ─────────────────────

const PARAM_TYPES: ReadonlySet<string> = new Set(['bool', 'int', 'float', 'string']);

function parseParamSchema(raw: unknown): Record<string, ConnectionParamType> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ConnectionParamType> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && PARAM_TYPES.has(v)) out[k] = v as ConnectionParamType;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Defensive parse of ONE raw edge record. Null when structurally unusable. */
export function parseConnection(raw: unknown): RvConnection | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null;
  const source = typeof r.source === 'string' && r.source.length > 0 ? r.source : null;
  const target = typeof r.target === 'string' && r.target.length > 0 ? r.target : null;
  const type = typeof r.type === 'string' && r.type.length > 0 ? r.type : null;
  if (!id || !source || !target || !type) return null;
  const config = (r.config !== null && typeof r.config === 'object' && !Array.isArray(r.config))
    ? { ...(r.config as Record<string, unknown>) }
    : undefined;
  return config ? { id, source, target, type, config } : { id, source, target, type };
}

/** Defensive parse of ONE raw `connectionTypes` record. */
export function parseConnectionType(raw: unknown): ConnectionType | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== 'string' || r.type.length === 0) return null;
  const out: ConnectionType = { type: r.type };
  const request = parseParamSchema(r.request);
  const response = parseParamSchema(r.response);
  if (request) out.request = request;
  if (response) out.response = response;
  return out;
}

/**
 * Defensive parse of a raw `userData.realvirtual.Connections` value (rv-ODT
 * `Connections` block). GLBs without the block (or with a malformed one)
 * yield the empty result — old GLBs load unchanged (plan-259 backward compat).
 */
export function parseConnectionsExtras(raw: unknown): ParsedConnections {
  const out: ParsedConnections = { connections: [], connectionTypes: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.connections)) {
    for (const c of r.connections) {
      const parsed = parseConnection(c);
      if (parsed) out.connections.push(parsed);
      else console.warn('[connections] skipping malformed connection entry:', c);
    }
  }
  if (Array.isArray(r.connectionTypes)) {
    for (const t of r.connectionTypes) {
      const parsed = parseConnectionType(t);
      if (parsed) out.connectionTypes.push(parsed);
      else console.warn('[connections] skipping malformed connectionTypes entry:', t);
    }
  }
  return out;
}

// ─── Parameter validation (custom types, plan-259 §5.2 Custom-Param-Drift) ──

function defaultForParam(t: ConnectionParamType): unknown {
  switch (t) {
    case 'bool': return false;
    case 'int': return 0;
    case 'float': return 0;
    case 'string': return '';
  }
}

function paramMatches(t: ConnectionParamType, v: unknown): boolean {
  switch (t) {
    case 'bool': return typeof v === 'boolean';
    case 'int': return typeof v === 'number' && Number.isInteger(v);
    case 'float': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
  }
}

/**
 * Validate a params object against a signature schema: missing fields get
 * type defaults (+ warning), type mismatches are coerced to the default
 * (+ warning), unknown extra fields pass through untouched (additive).
 * Returns a NEW object; never mutates the input. No schema ⇒ pass-through.
 */
export function validateConnectionParams(
  schema: Record<string, ConnectionParamType> | undefined,
  params: unknown,
  context: string,
): Record<string, unknown> {
  const src = (params !== null && typeof params === 'object' && !Array.isArray(params))
    ? params as Record<string, unknown>
    : {};
  if (!schema) return { ...src };
  const out: Record<string, unknown> = { ...src };
  for (const [name, type] of Object.entries(schema)) {
    if (!(name in out)) {
      out[name] = defaultForParam(type);
      console.warn(`[connections] ${context}: missing parameter '${name}' (${type}) — using default`);
    } else if (!paramMatches(type, out[name])) {
      console.warn(`[connections] ${context}: parameter '${name}' is not of type '${type}' — using default`);
      out[name] = defaultForParam(type);
    }
  }
  return out;
}

// ─── Endpoints + reply handles ───────────────────────────────────────────────

/** Reply callback the source passes into `call()` (deferred, no Promise). */
export type ConnectionReplyCallback = (response: Record<string, unknown>) => void;

/** The deferred reply handle handed to the target's `onRequest`. */
export type ConnectionReplyFn = (response: unknown) => void;

/**
 * The receiving surface one component registers for its node path. Delivery
 * SHOULD be scheduled on the component's own event list (deterministic) —
 * the registry hands over synchronously and never calls back into the caller.
 */
export interface ConnectionEndpoint {
  /** Custom-type request (`self.connection(type).call` on the source side). */
  onRequest?(topic: string, params: Record<string, unknown>, reply: ConnectionReplyFn, edge: RvConnection): void;
  /** Built-in StopOnExit arrival — the MU is ALREADY held when this fires. */
  onArrival?(mu: ScriptMuRef, edge: RvConnection): void;
}

interface ReplyHandle {
  id: number;
  edge: RvConnection;
  onReply: ConnectionReplyCallback;
  replied: boolean;
  alive: boolean;
}

/** Guard against synchronous dispatch recursion over cyclic edges (A→B→A). */
const MAX_DISPATCH_DEPTH = 32;

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * The connection runtime: edges + custom type signatures + adjacency index
 * (runtime-only, never persisted) + endpoint registry + request/reply
 * dispatch. One instance per viewer session (see `getConnectionSystem()`).
 */
export class RVConnectionRegistry {
  private readonly edges = new Map<string, RvConnection>();
  private readonly types = new Map<string, ConnectionType>();
  private readonly endpoints = new Map<string, ConnectionEndpoint>();
  /** Adjacency index (out/in per node path) — rebuilt lazily on change. */
  private outIndex: Map<string, RvConnection[]> | null = null;
  private inIndex: Map<string, RvConnection[]> | null = null;
  private readonly replies = new Map<number, ReplyHandle>();
  private nextReplyId = 1;
  private dispatchDepth = 0;
  private readonly listeners = new Set<() => void>();

  // ── Change subscription (UI / gizmo layer) ────────────────────────────

  /** Subscribe to any edge/type change. Returns the unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notifyChanged(): void {
    this.outIndex = null;
    this.inIndex = null;
    for (const cb of this.listeners) cb();
  }

  // ── Model lifecycle ───────────────────────────────────────────────────

  /** Replace all edges/types with the GLB-authored set (model load). */
  loadModel(parsed: ParsedConnections): void {
    this.clearModel();
    for (const t of parsed.connectionTypes) this.types.set(t.type, t);
    for (const c of parsed.connections) this.edges.set(c.id, c);
    this.notifyChanged();
  }

  /** Apply edit-op edges/types ADDITIVELY (scene load, replayed op log). */
  applyEdits(connections: RvConnection[], connectionTypes: ConnectionType[]): void {
    for (const t of connectionTypes) this.types.set(t.type, t);
    for (const c of connections) this.edges.set(c.id, c);
    this.notifyChanged();
  }

  /** Drop everything (model cleared). Invalidates open reply handles. */
  clearModel(): void {
    this.edges.clear();
    this.types.clear();
    this.resetRuntime();
    this.notifyChanged();
  }

  /**
   * Simulation reset (plan-259 §5.2 sim_reset coupling): invalidate every
   * open reply handle so a deferred `reply()` scheduled before the reset can
   * never ghost-call into the restarted simulation. Edges/types stay.
   */
  resetRuntime(): void {
    for (const h of this.replies.values()) h.alive = false;
    this.replies.clear();
  }

  // ── Edges / types (persistence-facing mutation) ───────────────────────

  /** All edges (stable insertion order). */
  all(): RvConnection[] {
    return [...this.edges.values()];
  }

  /** All user-defined type signatures. */
  allTypes(): ConnectionType[] {
    return [...this.types.values()];
  }

  get(id: string): RvConnection | null {
    return this.edges.get(id) ?? null;
  }

  getType(type: string): ConnectionType | null {
    return this.types.get(type) ?? null;
  }

  /** Add (or replace) an edge. Warns on self-links and new cycles (plan-259
   *  §5.2 Reentrancy) — the edge is still added; the dispatch guard protects
   *  the runtime. */
  addConnection(conn: RvConnection): void {
    if (conn.source === conn.target) {
      console.warn(`[connections] edge '${conn.id}' links '${conn.source}' to itself — dispatch is guarded, but check the design`);
    } else if (this.wouldCreateCycle(conn)) {
      console.warn(`[connections] edge '${conn.id}' (${conn.source} → ${conn.target}) creates a connection cycle — dispatch is guarded, but check the design`);
    }
    this.edges.set(conn.id, conn);
    this.notifyChanged();
  }

  /** Remove an edge by id (no-op for unknown ids). */
  removeConnection(id: string): void {
    if (this.edges.delete(id)) this.notifyChanged();
  }

  /** Add or replace a user-defined type signature. */
  setConnectionType(t: ConnectionType): void {
    this.types.set(t.type, t);
    this.notifyChanged();
  }

  /** Remove a user-defined type signature (edges of the type stay). */
  removeConnectionType(type: string): void {
    if (this.types.delete(type)) this.notifyChanged();
  }

  /** True when adding `conn` would close a directed cycle (target ⇝ source). */
  private wouldCreateCycle(conn: RvConnection): boolean {
    const seen = new Set<string>();
    const stack = [conn.target];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === conn.source) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of this.outOf(cur)) stack.push(e.target);
    }
    return false;
  }

  // ── Adjacency (runtime index, 1:n) ────────────────────────────────────

  private ensureIndex(): void {
    if (this.outIndex && this.inIndex) return;
    this.outIndex = new Map();
    this.inIndex = new Map();
    for (const e of this.edges.values()) {
      const out = this.outIndex.get(e.source);
      if (out) out.push(e); else this.outIndex.set(e.source, [e]);
      const inn = this.inIndex.get(e.target);
      if (inn) inn.push(e); else this.inIndex.set(e.target, [e]);
    }
  }

  /** Outgoing edges of a node path (1:n fan-out). */
  outOf(path: string): RvConnection[] {
    this.ensureIndex();
    return this.outIndex!.get(path) ?? [];
  }

  /** Incoming edges of a node path (n:1 fan-in). */
  into(path: string): RvConnection[] {
    this.ensureIndex();
    return this.inIndex!.get(path) ?? [];
  }

  // ── Endpoints ─────────────────────────────────────────────────────────

  /** Register the receiving endpoint for a node path. Returns unregister. */
  registerEndpoint(path: string, endpoint: ConnectionEndpoint): () => void {
    this.endpoints.set(path, endpoint);
    return () => {
      if (this.endpoints.get(path) === endpoint) this.endpoints.delete(path);
    };
  }

  /** Endpoint for a path — exact match first, then suffix convenience
   *  (`…/Station` matches a registration under the full hierarchy path). */
  private endpointFor(path: string): ConnectionEndpoint | null {
    const exact = this.endpoints.get(path);
    if (exact) return exact;
    for (const [p, ep] of this.endpoints) {
      if (p.endsWith(`/${path}`) || path.endsWith(`/${p}`)) return ep;
    }
    return null;
  }

  // ── Dispatch (bidirectional call) ─────────────────────────────────────

  /**
   * Source-side call over all outgoing edges of `fromPath` with `type`
   * (1:n fan-out — with n targets, `onReply` may be invoked up to n times,
   * once per replying target). Request parameters are validated against the
   * type signature. Returns the number of endpoints the request reached.
   */
  call(
    fromPath: string,
    type: string,
    params: unknown,
    onReply: ConnectionReplyCallback | null,
  ): number {
    if (this.dispatchDepth >= MAX_DISPATCH_DEPTH) {
      console.warn(`[connections] dispatch depth ${MAX_DISPATCH_DEPTH} exceeded at '${fromPath}' (${type}) — cyclic connection cascade dropped`);
      return 0;
    }
    const sig = this.types.get(type);
    const validated = validateConnectionParams(sig?.request, params, `${fromPath} → ${type}`);
    let delivered = 0;
    this.dispatchDepth++;
    try {
      for (const edge of this.outOf(fromPath)) {
        if (edge.type !== type) continue;
        const endpoint = this.endpointFor(edge.target);
        if (!endpoint?.onRequest) {
          console.warn(`[connections] edge '${edge.id}': target '${edge.target}' has no onRequest endpoint — request dropped`);
          continue;
        }
        const reply = this.mintReply(edge, onReply, sig);
        endpoint.onRequest(type, validated, reply, edge);
        delivered++;
      }
    } finally {
      this.dispatchDepth--;
    }
    return delivered;
  }

  /**
   * Deliver a built-in arrival (StopOnExit) for one edge. The caller (the
   * connection-system plugin) has ALREADY held the MU. Returns true when the
   * target endpoint consumed it.
   */
  deliverArrival(edge: RvConnection, mu: ScriptMuRef): boolean {
    if (this.dispatchDepth >= MAX_DISPATCH_DEPTH) {
      console.warn(`[connections] dispatch depth exceeded delivering arrival on '${edge.id}' — dropped`);
      return false;
    }
    const endpoint = this.endpointFor(edge.target);
    if (!endpoint?.onArrival) return false;
    this.dispatchDepth++;
    try {
      endpoint.onArrival(mu, edge);
    } finally {
      this.dispatchDepth--;
    }
    return true;
  }

  /** Open (not yet answered, still valid) reply handles — tests/diagnostics. */
  get openReplyCount(): number {
    let n = 0;
    for (const h of this.replies.values()) {
      if (h.alive && !h.replied) n++;
    }
    return n;
  }

  private mintReply(
    edge: RvConnection,
    onReply: ConnectionReplyCallback | null,
    sig: ConnectionType | null | undefined,
  ): ConnectionReplyFn {
    const handle: ReplyHandle = {
      id: this.nextReplyId++,
      edge,
      onReply: onReply ?? (() => { /* fire-and-forget call */ }),
      replied: false,
      alive: true,
    };
    this.replies.set(handle.id, handle);
    return (response: unknown) => {
      if (!handle.alive) {
        console.warn(`[connections] reply on edge '${edge.id}' ignored — handle invalidated (reset/dispose)`);
        return;
      }
      if (handle.replied) {
        console.warn(`[connections] duplicate reply on edge '${edge.id}' ignored`);
        return;
      }
      handle.replied = true;
      this.replies.delete(handle.id);
      const validated = validateConnectionParams(sig?.response, response, `${edge.target} reply → ${edge.type}`);
      handle.onReply(validated);
    };
  }
}

// ─── Session singleton (viewer wiring) ──────────────────────────────────────

let activeRegistry: RVConnectionRegistry | null = null;

/** The shared per-session connection registry (created lazily). Plugins, the
 *  inspector and the scene executors all talk to this instance. */
export function getConnectionSystem(): RVConnectionRegistry {
  activeRegistry ??= new RVConnectionRegistry();
  return activeRegistry;
}

/** Test seam: replace (or clear with null→fresh) the session registry. */
export function __setConnectionSystemForTests(reg: RVConnectionRegistry | null): void {
  activeRegistry = reg;
}
