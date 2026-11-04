// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-generator — runs the JS rule part of a part family as a PURE
 * FUNCTION in QuickJS and returns a validated build plan (plan-650 §2.4, F2/F5).
 *
 * Contract:
 *  - The rule source defines a global `function generate(values, parts)` that
 *    returns a plain-JSON build plan (`BuildPlan`).
 *  - **Own runtime per run.** Every call creates a FRESH QuickJS runtime +
 *    context (own 16 MB heap, own interrupt handler, own stack limit) and
 *    disposes it afterwards. It never shares the `RVScriptHost` runtime of the
 *    script components (SOL finding 5) — a generator hitting its memory limit
 *    cannot starve running scripts, and a poisoned run cannot poison the next.
 *  - **No host surface.** No SDK `self`, no exposed host functions; `Date` and
 *    `Math.random` are deleted before the rule source is evaluated. Input is
 *    one JSON string, output is one JSON string. Runs WITHOUT the script trust
 *    gate (plan-650 decision log) — that exception is only safe because of
 *    this zero-capability shape; do not add host functions here.
 *  - **Result transfer under the deadline.** A wrapper inside the VM calls
 *    `generate`, serialises the result with `JSON.stringify` INSIDE the VM and
 *    checks the string length — cycles, getters and `toJSON` run under the same
 *    interrupt budget. The host never `dump`s a guest object graph.
 *  - **Budget = deterministic work counter.** The interrupt handler counts its
 *    own invocations (`interruptTicks`); exceeding `maxInterruptTicks` aborts
 *    with `limit-ticks`. The wallclock deadline (`deadlineMs`) is only an
 *    emergency brake (`limit-deadline`) and is not part of any test contract.
 *  - **Structural limits** are checked on the host-parsed plan (≤ 5000
 *    instances, ≤ 2000 nodes, ≤ 500 components, ≤ 100 messages, strings ≤ 256,
 *    depth ≤ 8, ≤ 16 stretches per instance, ≤ 2 M generated vertices).
 *  - Throw-free: every failure comes back as `{ ok: false, error: { code } }`.
 *
 * QuickJS is loaded lazily via `loadQuickJSModule` (dynamic import), so this
 * module may be imported eagerly without pulling the WASM chunk.
 */

import type { QuickJSContext, QuickJSRuntime } from 'quickjs-emscripten-core';
import { loadQuickJSModule, toSandboxError, isMemoryError } from './rv-script-sandbox';

// ─── Types ────────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';

/** One base part as the rule part sees it (part-local mm, axes as authored). */
export interface PartInfo {
  name: string;
  boundsMm: { min: Vec3; max: Vec3 };
  /** Vertex count of the base geometry — host-side input to the vertex budget. Optional. */
  vertexCount?: number;
}

export interface PlanStretch { axis: Axis; atMm: number; byMm: number }
/**
 * `pivot` (plan-650 Phase 6): `'start'` (default) keeps the part origin at the
 * start of the arc; `'center'` moves the arc centre to the instance origin — a
 * Radial TransportSurface turns about its node origin, so a curve's surface
 * strip needs it.
 */
export interface PlanBend { axis: Axis; radiusMm: number; centerSide: '+' | '-'; pivot?: 'start' | 'center' }

export interface PlanInstance {
  part: string;
  name?: string;
  /** positionMm/rotationDeg are parent-local when set, else in the parts-root frame. */
  parent?: string;
  positionMm: Vec3;
  rotationDeg?: Vec3;
  stretch?: PlanStretch[];
  bend?: PlanBend;
}

export interface PlanNode {
  name: string;
  /** positionMm/rotationDeg are parent-local when set, else in the parts-root frame. */
  parent?: string;
  positionMm: Vec3;
  rotationDeg?: Vec3;
}
export interface PlanComponent { node: string; type: string; fields: Record<string, unknown> }
export interface PlanMessage { level: 'info' | 'warning'; text: string }
/**
 * plan-650 Phase 5b: one child family the assembly places as an EMPTY,
 * non-embedded reference node (materialised later as a nested placement).
 * `values` are checked against the child's schema by the child's own variant step.
 */
export interface PlanChild {
  family: string;
  values: Record<string, number | boolean | string>;
  positionMm: Vec3;
  rotationDeg?: Vec3;
}

/** Validated build plan (plan-650 §2.3). */
export interface BuildPlan {
  instances: PlanInstance[];
  nodes: PlanNode[];
  components: PlanComponent[];
  messages: PlanMessage[];
  /** Child families (plan-650 Phase 5b) — present only when the rules return any. */
  children?: PlanChild[];
}

/** Hard limits of one generator run (F5). */
export interface GeneratorLimits {
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  /** Deterministic budget: number of QuickJS interrupt-handler invocations. */
  maxInterruptTicks: number;
  /** Emergency brake only (wallclock) — never asserted by tests. */
  deadlineMs: number;
  maxResultChars: number;
  maxDepth: number;
  maxInstances: number;
  maxNodes: number;
  maxComponents: number;
  maxMessages: number;
  maxStringLength: number;
  maxStretchPerInstance: number;
  maxVertices: number;
  /** Child families per plan (plan-650 Phase 5b). */
  maxChildren: number;
}

export const DEFAULT_GENERATOR_LIMITS: Readonly<GeneratorLimits> = Object.freeze({
  memoryLimitBytes: 16 * 1024 * 1024,
  maxStackSizeBytes: 512 * 1024,
  // ~5000 bytecode ops per tick (QuickJS interrupt cadence) → ~2 M ops, ≈ 130 ms on the dev PC:
  // the tick budget binds before the 200 ms emergency deadline (decision 2026-10-21, plan-650).
  maxInterruptTicks: 400,
  deadlineMs: 200,
  maxResultChars: 2 * 1024 * 1024,
  maxDepth: 8,
  maxInstances: 5000,
  maxNodes: 2000,
  maxComponents: 500,
  maxMessages: 100,
  maxStringLength: 256,
  maxStretchPerInstance: 16,
  maxVertices: 2_000_000,
  maxChildren: 64,
});

export type GeneratorErrorCode =
  | 'syntax-error'
  | 'no-generate'
  | 'runtime-error'
  | 'limit-ticks'
  | 'limit-deadline'
  | 'limit-memory'
  | 'limit-size'
  | 'limit-depth'
  | 'limit-instances'
  | 'limit-nodes'
  | 'limit-components'
  | 'limit-messages'
  | 'limit-string'
  | 'limit-stretch'
  | 'limit-vertices'
  | 'limit-children'
  | 'unknown-parent'
  | 'parent-cycle'
  | 'parent-depth'
  | 'invalid-name'
  | 'invalid-plan'
  | 'host-error';

export interface GeneratorError { code: GeneratorErrorCode; message: string }

export interface GeneratorStats {
  /** Interrupt-handler invocations of this run (deterministic work counter). */
  interruptTicks: number;
  /** Length of the serialised result string (0 on failure before serialisation). */
  resultChars: number;
  /** Estimated generated vertices (sum of part vertex counts over instances). */
  vertices: number;
}

export type GeneratorResult =
  | { ok: true; plan: BuildPlan; stats: GeneratorStats }
  | { ok: false; error: GeneratorError; stats: GeneratorStats };

/** Process-wide count of generator runs (A7 counter; tests spy on it). */
let generatorRunCount = 0;
/** Number of `runGenerator` calls since module load (deterministic A7 counter). */
export function getGeneratorRunCount(): number {
  return generatorRunCount;
}

// ─── Run ──────────────────────────────────────────────────────────────────

const GENERATE_FN = 'generate';
const INPUT_GLOBAL = '__rvParametricInput';
/** Status prefix of the wrapper (a JSON text never starts with '!'; NUL would truncate in getString). */
const SENTINEL = '!rv:';

/** Removes non-deterministic globals before the rule source runs. */
const PRELUDE = `"use strict";
delete globalThis.Date;
delete Math.random;
`;

function wrapperSource(maxChars: number): string {
  return `(function () {
  if (typeof globalThis.${GENERATE_FN} !== 'function') return '!rv:no-generate';
  var input = JSON.parse(globalThis.${INPUT_GLOBAL});
  delete globalThis.${INPUT_GLOBAL};
  var result = globalThis.${GENERATE_FN}(input.values, input.parts);
  var text = JSON.stringify(result);
  if (typeof text !== 'string') return '!rv:not-json';
  if (text.length > ${maxChars}) return '!rv:limit-size:' + text.length;
  return text;
})()`;
}

/**
 * Runs `generate(values, parts)` from `code` once, in a fresh runtime, and
 * validates the returned build plan. `values` must already be normalized.
 */
export async function runGenerator(
  code: string,
  values: Readonly<Record<string, number | boolean | string>>,
  parts: readonly PartInfo[],
  limits: Partial<GeneratorLimits> = {},
): Promise<GeneratorResult> {
  generatorRunCount++;
  const lim: GeneratorLimits = { ...DEFAULT_GENERATOR_LIMITS, ...limits };
  const stats: GeneratorStats = { interruptTicks: 0, resultChars: 0, vertices: 0 };
  const fail = (code: GeneratorErrorCode, message: string): GeneratorResult => ({ ok: false, error: { code, message }, stats });

  let inputJson: string;
  try {
    inputJson = JSON.stringify({ values, parts: parts.map((p) => ({ name: p.name, boundsMm: p.boundsMm })) });
  } catch (err) {
    return fail('host-error', `input not serialisable: ${err instanceof Error ? err.message : String(err)}`);
  }

  let runtime: QuickJSRuntime | null = null;
  let ctx: QuickJSContext | null = null;
  let text: string;
  try {
    const module = await loadQuickJSModule();
    runtime = module.newRuntime();
    runtime.setMemoryLimit(lim.memoryLimitBytes);
    runtime.setMaxStackSize(lim.maxStackSizeBytes);
    let reason: 'ticks' | 'deadline' | null = null;
    const deadlineAt = performance.now() + lim.deadlineMs;
    runtime.setInterruptHandler(() => {
      stats.interruptTicks++;
      if (stats.interruptTicks > lim.maxInterruptTicks) { reason = 'ticks'; return true; }
      if (performance.now() >= deadlineAt) { reason = 'deadline'; return true; }
      return false;
    });
    ctx = runtime.newContext();

    const evalStep = (source: string, file: string): { ok: true; value: string } | { ok: false; result: GeneratorResult } => {
      const c = ctx as QuickJSContext;
      const r = c.evalCode(source, file, { type: 'global' });
      if (r.error) {
        const err = toSandboxError(c.dump(r.error));
        r.error.dispose();
        if (reason === 'ticks') return { ok: false, result: fail('limit-ticks', `generator exceeded ${lim.maxInterruptTicks} interrupt ticks`) };
        if (reason === 'deadline') return { ok: false, result: fail('limit-deadline', `generator exceeded the ${lim.deadlineMs} ms emergency deadline`) };
        if (isMemoryError(err)) return { ok: false, result: fail('limit-memory', `generator exceeded ${lim.memoryLimitBytes} bytes of memory`) };
        if (/stack overflow/i.test(err.message)) return { ok: false, result: fail('limit-memory', `generator exceeded the stack limit: ${err.message}`) };
        const code: GeneratorErrorCode = err.name === 'SyntaxError' && file.endsWith('rules.js') ? 'syntax-error' : 'runtime-error';
        return { ok: false, result: fail(code, `${err.name}: ${err.message}`) };
      }
      const v = c.typeof(r.value) === 'string' ? c.getString(r.value) : '';
      r.value.dispose();
      return { ok: true, value: v };
    };

    const prelude = evalStep(PRELUDE, 'parametric://prelude.js');
    if (!prelude.ok) return prelude.result;
    const rules = evalStep(code, 'parametric://rules.js');
    if (!rules.ok) return rules.result;
    const input = ctx.newString(inputJson);
    ctx.setProp(ctx.global, INPUT_GLOBAL, input);
    input.dispose();
    const out = evalStep(wrapperSource(lim.maxResultChars), 'parametric://wrapper.js');
    if (!out.ok) return out.result;
    text = out.value;
  } catch (err) {
    return fail('host-error', err instanceof Error ? err.message : String(err));
  } finally {
    try { ctx?.dispose(); } catch { /* poisoned context — runtime dispose below frees it */ }
    try { runtime?.dispose(); } catch { /* ignore */ }
  }

  if (text.startsWith(SENTINEL)) {
    const tag = text.slice(SENTINEL.length);
    if (tag === 'no-generate') return fail('no-generate', `rule source does not define a global '${GENERATE_FN}' function`);
    if (tag === 'not-json') return fail('invalid-plan', 'generate() must return a JSON object');
    if (tag.startsWith('limit-size:')) return fail('limit-size', `result has ${tag.slice(11)} chars, limit ${lim.maxResultChars}`);
    return fail('host-error', `unexpected wrapper tag ${tag}`);
  }
  stats.resultChars = text.length;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail('invalid-plan', `result is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = validatePlan(raw, parts, lim, stats);
  if ('error' in checked) return { ok: false, error: checked.error, stats };
  return { ok: true, plan: checked.plan, stats };
}

// ─── Validation ───────────────────────────────────────────────────────────

class PlanError extends Error {
  constructor(readonly code: GeneratorErrorCode, message: string) { super(message); }
}

function depthOf(v: unknown, limit: number, depth = 1): number {
  if (depth > limit) return depth;
  if (v === null || typeof v !== 'object') return depth - 1;
  let max = depth;
  for (const child of Array.isArray(v) ? v : Object.values(v as object)) {
    const d = depthOf(child, limit, depth + 1);
    if (d > max) max = d;
    if (max > limit) break;
  }
  return max;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const PLAN_KEYS = new Set(['instances', 'nodes', 'components', 'messages', 'children']);
const CHILD_KEYS = new Set(['family', 'values', 'positionMm', 'rotationDeg']);
const INSTANCE_KEYS = new Set(['part', 'name', 'parent', 'positionMm', 'rotationDeg', 'stretch', 'bend']);
const NODE_KEYS = new Set(['name', 'parent', 'positionMm', 'rotationDeg']);
const COMPONENT_KEYS = new Set(['node', 'type', 'fields']);
const MESSAGE_KEYS = new Set(['level', 'text']);

/**
 * Validates a parsed build plan against the structural limits. Exported for
 * the cache path (a plan read back from a cache manifest is validated again).
 */
export function validatePlan(
  raw: unknown,
  parts: readonly PartInfo[],
  limits: Partial<GeneratorLimits> = {},
  stats?: GeneratorStats,
): { plan: BuildPlan } | { error: GeneratorError } {
  const lim: GeneratorLimits = { ...DEFAULT_GENERATOR_LIMITS, ...limits };
  try {
    if (!isObj(raw)) throw new PlanError('invalid-plan', 'generate() must return an object');
    const depth = depthOf(raw, lim.maxDepth);
    if (depth > lim.maxDepth) throw new PlanError('limit-depth', `result nesting exceeds depth ${lim.maxDepth}`);
    for (const k of Object.keys(raw)) {
      if (!PLAN_KEYS.has(k)) throw new PlanError('invalid-plan', `unknown build-plan key "${k}"`);
    }
    const str = (v: unknown, where: string): string => {
      if (typeof v !== 'string' || v.length === 0) throw new PlanError('invalid-plan', `${where} must be a non-empty string`);
      if (v.length > lim.maxStringLength) throw new PlanError('limit-string', `${where} exceeds ${lim.maxStringLength} chars`);
      return v;
    };
    const num = (v: unknown, where: string): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new PlanError('invalid-plan', `${where} must be a finite number`);
      return Object.is(v, -0) ? 0 : v;
    };
    const vec3 = (v: unknown, where: string): Vec3 => {
      if (!Array.isArray(v) || v.length !== 3) throw new PlanError('invalid-plan', `${where} must be [x, y, z]`);
      return [num(v[0], `${where}[0]`), num(v[1], `${where}[1]`), num(v[2], `${where}[2]`)];
    };
    const axis = (v: unknown, where: string): Axis => {
      if (v !== 'x' && v !== 'y' && v !== 'z') throw new PlanError('invalid-plan', `${where} must be 'x', 'y' or 'z'`);
      return v;
    };
    const list = (v: unknown, where: string, max: number, code: GeneratorErrorCode): unknown[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v)) throw new PlanError('invalid-plan', `${where} must be an array`);
      if (v.length > max) throw new PlanError(code, `${where} has ${v.length} entries, limit ${max}`);
      return v;
    };
    const keysOk = (o: Record<string, unknown>, allowed: Set<string>, where: string): void => {
      for (const k of Object.keys(o)) if (!allowed.has(k)) throw new PlanError('invalid-plan', `${where}: unknown key "${k}"`);
    };
    const checkStrings = (v: unknown, where: string): void => {
      if (typeof v === 'string') { if (v.length > lim.maxStringLength) throw new PlanError('limit-string', `${where} exceeds ${lim.maxStringLength} chars`); return; }
      if (v === null || typeof v !== 'object') return;
      for (const [k, c] of Array.isArray(v) ? v.entries() : Object.entries(v)) {
        if (typeof k === 'string' && k.length > lim.maxStringLength) throw new PlanError('limit-string', `${where}: key exceeds ${lim.maxStringLength} chars`);
        checkStrings(c, where);
      }
    };

    const partVerts = new Map(parts.map((p) => [p.name, p.vertexCount ?? 0]));
    let vertices = 0;
    const instances = list(raw.instances, 'instances', lim.maxInstances, 'limit-instances').map((v, i): PlanInstance => {
      const w = `instances[${i}]`;
      if (!isObj(v)) throw new PlanError('invalid-plan', `${w} must be an object`);
      keysOk(v, INSTANCE_KEYS, w);
      const part = str(v.part, `${w}.part`);
      if (!partVerts.has(part)) throw new PlanError('invalid-plan', `${w}.part "${part}" is not a base part`);
      vertices += partVerts.get(part) ?? 0;
      if (vertices > lim.maxVertices) throw new PlanError('limit-vertices', `generated vertices exceed ${lim.maxVertices}`);
      const inst: PlanInstance = { part, positionMm: vec3(v.positionMm, `${w}.positionMm`) };
      if (v.name !== undefined) inst.name = str(v.name, `${w}.name`);
      if (v.parent !== undefined) inst.parent = str(v.parent, `${w}.parent`);
      if (v.rotationDeg !== undefined) inst.rotationDeg = vec3(v.rotationDeg, `${w}.rotationDeg`);
      if (v.stretch !== undefined) {
        inst.stretch = list(v.stretch, `${w}.stretch`, lim.maxStretchPerInstance, 'limit-stretch').map((s, j) => {
          const ws = `${w}.stretch[${j}]`;
          if (!isObj(s)) throw new PlanError('invalid-plan', `${ws} must be an object`);
          keysOk(s, new Set(['axis', 'atMm', 'byMm']), ws);
          return { axis: axis(s.axis, `${ws}.axis`), atMm: num(s.atMm, `${ws}.atMm`), byMm: num(s.byMm, `${ws}.byMm`) };
        });
      }
      if (v.bend !== undefined) {
        const b = v.bend;
        if (!isObj(b)) throw new PlanError('invalid-plan', `${w}.bend must be an object`);
        keysOk(b, new Set(['axis', 'radiusMm', 'centerSide', 'pivot']), `${w}.bend`);
        const radiusMm = num(b.radiusMm, `${w}.bend.radiusMm`);
        if (radiusMm <= 0) throw new PlanError('invalid-plan', `${w}.bend.radiusMm must be > 0`);
        if (b.centerSide !== '+' && b.centerSide !== '-') throw new PlanError('invalid-plan', `${w}.bend.centerSide must be '+' or '-'`);
        if (b.pivot !== undefined && b.pivot !== 'start' && b.pivot !== 'center') {
          throw new PlanError('invalid-plan', `${w}.bend.pivot must be 'start' or 'center'`);
        }
        inst.bend = { axis: axis(b.axis, `${w}.bend.axis`), radiusMm, centerSide: b.centerSide };
        if (b.pivot === 'center') inst.bend.pivot = 'center';
      }
      return inst;
    });
    const nodes = list(raw.nodes, 'nodes', lim.maxNodes, 'limit-nodes').map((v, i): PlanNode => {
      const w = `nodes[${i}]`;
      if (!isObj(v)) throw new PlanError('invalid-plan', `${w} must be an object`);
      keysOk(v, NODE_KEYS, w);
      const node: PlanNode = { name: str(v.name, `${w}.name`), positionMm: vec3(v.positionMm, `${w}.positionMm`) };
      if (v.parent !== undefined) node.parent = str(v.parent, `${w}.parent`);
      if (v.rotationDeg !== undefined) node.rotationDeg = vec3(v.rotationDeg, `${w}.rotationDeg`);
      return node;
    });
    const objects: (PlanInstance | PlanNode)[] = [...instances, ...nodes];
    const explicitTargets = new Map<string, PlanInstance | PlanNode>();
    for (const obj of objects) {
      if (obj.name !== undefined) {
        // Keep this literal local to avoid coupling validation to assembly.
        if (/[/#]/.test(obj.name) || obj.name === '_Children') {
          throw new PlanError('invalid-name', `invalid generated name "${obj.name}"`);
        }
        // Duplicate names remain assembly's responsibility.
        explicitTargets.set(obj.name, obj);
      }
    }
    for (const obj of objects) {
      if (obj.parent !== undefined && !explicitTargets.has(obj.parent)) {
        throw new PlanError('unknown-parent', `unknown parent "${obj.parent}"`);
      }
    }
    let maxParentDepth = 0;
    for (const obj of objects) {
      const seen = new Set<PlanInstance | PlanNode>();
      let current = obj;
      let depth = 0;
      while (current.parent !== undefined) {
        seen.add(current);
        const target = explicitTargets.get(current.parent)!;
        if (seen.has(target)) throw new PlanError('parent-cycle', 'cycle in generated parents');
        current = target;
        depth++;
      }
      maxParentDepth = Math.max(maxParentDepth, depth);
    }
    if (maxParentDepth > 16) throw new PlanError('parent-depth', 'parent chain exceeds 16 hops');
    const components = list(raw.components, 'components', lim.maxComponents, 'limit-components').map((v, i): PlanComponent => {
      const w = `components[${i}]`;
      if (!isObj(v)) throw new PlanError('invalid-plan', `${w} must be an object`);
      keysOk(v, COMPONENT_KEYS, w);
      const fields = v.fields === undefined ? {} : v.fields;
      if (!isObj(fields)) throw new PlanError('invalid-plan', `${w}.fields must be an object`);
      checkStrings(fields, `${w}.fields`);
      return { node: str(v.node, `${w}.node`), type: str(v.type, `${w}.type`), fields };
    });
    const messages = list(raw.messages, 'messages', lim.maxMessages, 'limit-messages').map((v, i): PlanMessage => {
      const w = `messages[${i}]`;
      if (!isObj(v)) throw new PlanError('invalid-plan', `${w} must be an object`);
      keysOk(v, MESSAGE_KEYS, w);
      if (v.level !== 'info' && v.level !== 'warning') throw new PlanError('invalid-plan', `${w}.level must be 'info' or 'warning'`);
      return { level: v.level, text: str(v.text, `${w}.text`) };
    });
    const children = list(raw.children, 'children', lim.maxChildren, 'limit-children').map((v, i): PlanChild => {
      const w = `children[${i}]`;
      if (!isObj(v)) throw new PlanError('invalid-plan', `${w} must be an object`);
      keysOk(v, CHILD_KEYS, w);
      const rawValues = v.values === undefined ? {} : v.values;
      if (!isObj(rawValues)) throw new PlanError('invalid-plan', `${w}.values must be an object`);
      const values: Record<string, number | boolean | string> = {};
      for (const [k, x] of Object.entries(rawValues)) {
        if (typeof x === 'number') values[k] = num(x, `${w}.values.${k}`);
        else if (typeof x === 'boolean') values[k] = x;
        else if (typeof x === 'string') values[k] = str(x, `${w}.values.${k}`);
        else throw new PlanError('invalid-plan', `${w}.values.${k} must be a number, boolean or string`);
      }
      const child: PlanChild = { family: str(v.family, `${w}.family`), values, positionMm: vec3(v.positionMm, `${w}.positionMm`) };
      if (v.rotationDeg !== undefined) child.rotationDeg = vec3(v.rotationDeg, `${w}.rotationDeg`);
      return child;
    });
    if (stats) stats.vertices = vertices;
    const plan: BuildPlan = { instances, nodes, components, messages };
    if (children.length > 0) plan.children = children;
    return { plan };
  } catch (err) {
    if (err instanceof PlanError) return { error: { code: err.code, message: err.message } };
    return { error: { code: 'invalid-plan', message: err instanceof Error ? err.message : String(err) } };
  }
}
