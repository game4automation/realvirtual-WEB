// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Explicit, synchronous DES snapshot boundary (plan-2059).
 *
 * SnapshotJson's number arm is refined at runtime: only finite numbers other
 * than -0 are JSON data. Capture inspects descriptors without running getters,
 * rejects hidden/lossy state, and copies every container. Object identity must
 * be represented by explicit IDs: a session retains source identities across
 * participants and rejects both aliases and cycles before JSON can hide them.
 *
 * Codecs are opt-in at exact participant-relative paths; [] matches one array
 * index (also a Set item or Map entry). Map values use `map[][1]`, keys use
 * `map[][0]`. Tags are reserved wire objects, never implicit user-data revivers.
 * Decode checks the JSON boundary first, then interprets only schema-approved
 * tags. Neither operation mutates its input or touches an engine/registry.
 */

export type SnapshotJson = null | boolean | string | number
  | SnapshotJson[] | { [key: string]: SnapshotJson };
export type SnapshotCodec = 'map' | 'set' | 'number-tags';
export interface SnapshotSchema {
  readonly codecs?: Readonly<Record<string, SnapshotCodec>>;
}
export interface SnapshotContext extends SnapshotSchema { readonly participant: string }
export interface SnapshotContractError {
  code: 'des-snapshot-contract';
  participant: string;
  path: string;
  reason: string;
}
export interface CaptureSession {
  /** Throws on invalid state; diagnostics remain available through errors(). */
  capture(participant: string, value: unknown, schema?: SnapshotSchema): SnapshotJson;
  errors(): SnapshotContractError[];
}

function fail(errors: readonly SnapshotContractError[]): never {
  throw Object.assign(new Error(errors.map(e =>
    `${e.code}: ${e.participant}.${e.path}: ${e.reason}`).join('\n')), { ...errors[0], errors: [...errors] });
}

function field(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
}

interface CodecTable {
  /** Exact (no `[]`) patterns: path -> position in the declaration order. */
  readonly exact: ReadonlyMap<string, { readonly at: number; readonly codec: SnapshotCodec }>;
  /** `[]` patterns, compiled once, in declaration order. */
  readonly patterns: ReadonlyArray<{ readonly at: number; readonly regex: RegExp; readonly codec: SnapshotCodec }>;
}

// Compiled once per codecs object: a walk asks for EVERY path, and the authority schema declares
// one codec per numeric path - compiling a RegExp per (path x pattern) cost ~300 ms per capture
// in a fleet scene (plan-2059 O8).
const codecTables = new WeakMap<object, CodecTable>();

function codecTable(codecs: Readonly<Record<string, SnapshotCodec>>): CodecTable {
  let table = codecTables.get(codecs);
  if (table) return table;
  const exact = new Map<string, { at: number; codec: SnapshotCodec }>();
  const patterns: Array<{ at: number; regex: RegExp; codec: SnapshotCodec }> = [];
  let at = 0;
  for (const [pattern, codec] of Object.entries(codecs)) {
    if (!pattern.includes('[]')) { if (!exact.has(pattern)) exact.set(pattern, { at, codec }); }
    else {
      const expression = pattern.split('[]').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\[\\d+\\]');
      patterns.push({ at, regex: new RegExp(`^${expression}$`), codec });
    }
    at++;
  }
  table = { exact, patterns };
  codecTables.set(codecs, table);
  return table;
}

function codecAt(schema: SnapshotSchema, path: string): SnapshotCodec | undefined {
  if (!schema.codecs) return undefined;
  const { exact, patterns } = codecTable(schema.codecs);
  const hit = exact.get(path);
  // First declared match wins, as before: a `[]` pattern declared earlier beats an exact one.
  for (const p of patterns) {
    if (hit && p.at > hit.at) break;
    if (p.regex.test(path)) return p.codec;
  }
  return hit?.codec;
}

const TAGS = ['$map', '$set', '$num'];
const NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0,
};

/** Internal copier also used to validate the undecoded transport without interpreting tags. */
function copier(allowWireTags = false): CaptureSession {
  const seen = new WeakMap<object, { participant: string; path: string }>();
  const active = new WeakSet<object>();
  const errors: SnapshotContractError[] = [];
  return {
    errors: () => errors.map(e => ({ ...e })),
    capture(participant, value, schema = {}) {
      const start = errors.length;
      const bad = (path: string, reason: string): null => {
        errors.push({ code: 'des-snapshot-contract', participant, path: path || '<root>', reason });
        return null;
      };
      const walk = (v: unknown, path: string): SnapshotJson => {
        // Looked up lazily: only a non-finite number or a Map/Set asks for it, while a walk visits every path (plan-2063).
        const codecOf = (): SnapshotCodec | undefined => codecAt(schema, path);
        if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
        if (typeof v === 'number') {
          if (Number.isFinite(v) && !Object.is(v, -0)) return v;
          if (codecOf() === 'number-tags') return { $num: Object.is(v, -0) ? '-0' : String(v) };
          return bad(path, 'non-finite number or -0 requires number-tags codec');
        }
        if (typeof v !== 'object') return bad(path, `forbidden ${typeof v}`);
        const first = seen.get(v);
        if (first) return bad(path,
          `${active.has(v) ? 'cycle' : 'alias'}: same object as ${first.participant}.${first.path}; use explicit IDs`);
        seen.set(v, { participant, path: path || '<root>' });
        active.add(v);
        try {
          if (v instanceof Map || v instanceof Set) {
            const map = v instanceof Map;
            if (codecOf() !== (map ? 'map' : 'set')) return bad(path, `${map ? 'Map' : 'Set'} requires schema codec`);
            if (Object.getPrototypeOf(v) !== (map ? Map.prototype : Set.prototype))
              return bad(path, 'collection subclasses are forbidden');
            for (const key of Reflect.ownKeys(v)) bad(field(path, String(key)), 'collection own properties are not snapshot data');
            if (v instanceof Map) {
              const entries: SnapshotJson[] = [];
              let i = 0;
              for (const [key, item] of Map.prototype.entries.call(v)) {
                const p = `${path}[${i++}]`;
                const k = typeof key === 'string' || typeof key === 'number'
                  ? walk(key, `${p}[0]`) : bad(`${p}[0]`, 'Map key must be string or number');
                entries.push([k, walk(item, `${p}[1]`)]);
              }
              return { $map: entries };
            }
            return { $set: Array.from(Set.prototype.values.call(v), (item, i) => walk(item, `${path}[${i}]`)) };
          }
          if (Array.isArray(v)) {
            if (Object.getPrototypeOf(v) !== Array.prototype) return bad(path, 'array subclasses are forbidden');
            const out: SnapshotJson[] = [];
            for (let i = 0; i < v.length; i++) {
              const p = `${path}[${i}]`;
              const d = Object.getOwnPropertyDescriptor(v, String(i));
              out.push(!d ? bad(p, 'sparse array') : !('value' in d)
                ? bad(p, 'accessor property') : walk(d.value, p));
            }
            for (const key of Reflect.ownKeys(v)) {
              if (typeof key === 'string' && (key === 'length'
                || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length)) continue;
              bad(field(path, String(key)), 'array extra property or symbol key');
            }
            return out;
          }
          const proto = Object.getPrototypeOf(v);
          if (proto !== Object.prototype && proto !== null) return bad(path, 'non-plain object (class/built-in instance)');
          const out: { [key: string]: SnapshotJson } = {};
          for (const key of Reflect.ownKeys(v)) {
            const p = field(path, String(key));
            if (typeof key === 'symbol') { bad(p, 'symbol key'); continue; }
            const d = Object.getOwnPropertyDescriptor(v, key)!;
            if (!('value' in d)) { bad(p, 'accessor property'); continue; }
            if (!d.enumerable) { bad(p, 'non-enumerable property'); continue; }
            if (!allowWireTags && TAGS.includes(key)) bad(p, 'reserved codec tag requires schema encoding');
            Object.defineProperty(out, key, { value: walk(d.value, p), enumerable: true, writable: true, configurable: true });
          }
          return out;
        } finally { active.delete(v); }
      };
      const result = walk(value, '');
      if (errors.length > start) fail(errors.slice(start));
      return result;
    },
  };
}

/** One session per entire capture; create another session for the next snapshot. */
export function createCaptureSession(): CaptureSession { return copier(); }

/** Validate and detach a single participant. For multiple participants use a session. */
export function toSnapshotData(value: unknown, ctx: SnapshotContext): SnapshotJson {
  return createCaptureSession().capture(ctx.participant, value, ctx);
}

/** Validate plain JSON data and throw one Error carrying all field diagnostics. */
export function assertSnapshotData(value: unknown, ctx: SnapshotContext = { participant: 'snapshot' }): asserts value is SnapshotJson {
  copier(true).capture(ctx.participant, value);
}

/** Decode a detached transport value, refusing malformed or unapproved codec tags. */
export function fromSnapshotData(value: unknown, ctx: SnapshotContext): unknown {
  const json = copier(true).capture(ctx.participant, value);
  const errors: SnapshotContractError[] = [];
  const bad = (path: string, reason: string): null => {
    errors.push({ code: 'des-snapshot-contract', participant: ctx.participant, path: path || '<root>', reason });
    return null;
  };
  const walk = (v: SnapshotJson, path: string): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    const tags = TAGS.filter(t => Object.hasOwn(v, t));
    if (tags.length) {
      const tag = tags[0];
      const expected: SnapshotCodec = tag === '$map' ? 'map' : tag === '$set' ? 'set' : 'number-tags';
      if (Object.keys(v).length !== 1 || codecAt(ctx, path) !== expected)
        return bad(path, `unapproved or malformed ${tag} codec tag`);
      const data = v[tag];
      if (tag === '$num') return typeof data === 'string' && Object.hasOwn(NUMBERS, data)
        ? NUMBERS[data] : bad(path, 'invalid number tag');
      if (!Array.isArray(data)) return bad(path, `${tag} must contain an array`);
      if (tag === '$set') {
        const items = data.map((item, i) => walk(item, `${path}[${i}]`));
        const result = new Set(items);
        if (result.size !== items.length) bad(path, 'duplicate Set item');
        return result;
      }
      const result = new Map<string | number, unknown>();
      data.forEach((entry, i) => {
        const p = `${path}[${i}]`;
        if (!Array.isArray(entry) || entry.length !== 2) { bad(p, 'Map entry must be [key, value]'); return; }
        const key = walk(entry[0], `${p}[0]`);
        if (typeof key !== 'string' && typeof key !== 'number') { bad(`${p}[0]`, 'Map key must be string or number'); return; }
        if (result.has(key)) bad(`${p}[0]`, 'duplicate Map key');
        result.set(key, walk(entry[1], `${p}[1]`));
      });
      return result;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) Object.defineProperty(out, key, {
      value: walk(item, field(path, key)), enumerable: true, writable: true, configurable: true,
    });
    return out;
  };
  const result = walk(json, '');
  if (errors.length) fail(errors);
  return result;
}

/** Same finite, non-past scheduling rule as plan-2058; no clock mutation. */
export function assertEventTime(t: number, simTime: number): void {
  if (!Number.isFinite(t) || !Number.isFinite(simTime) || t < simTime)
    throw new RangeError(`event times must be finite and not earlier than the current simulation time (t=${t}, simTime=${simTime})`);
}
