// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-hash — the ONE hash contract of parametric part families
 * (plan-650 §2.3, SOL finding 2).
 *
 *   InputHash = sha256(canonicalJSON({ ApiVersion, CodeHash, Values, PartsHash }))
 *   PartsHash = sha256(canonicalJSON(sorted [{ name, localMatrix, geometryHash, materialKey }]))
 *
 * `Values` must already be normalized (`normalizeValues`). Renaming, moving
 * or recolouring a base part changes `PartsHash` and therefore `InputHash`.
 * `PlanHash` (hash of a build plan) exists only for golden tests and is never
 * compared at runtime.
 *
 * Canonical JSON is a subset of RFC 8785: object keys sorted by UTF-16 code
 * units, numbers in ECMAScript `Number#toString` form (identical to RFC 8785
 * for finite numbers; `-0` → `0`), strings via `JSON.stringify`. Non-finite
 * numbers, `undefined`, functions, symbols and bigints are rejected — a hash
 * input that cannot be represented exactly is an error, never silently
 * dropped. No npm dependency: SHA-256 via `crypto.subtle`.
 */

/** Canonical JSON (RFC 8785 subset). Throws on values JSON cannot represent exactly. */
export function canonicalJSON(value: unknown): string {
  return write(value, 0);
}

const MAX_CANONICAL_DEPTH = 64;

function write(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error('canonicalJSON: nesting too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJSON: non-finite number ${String(value)}`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => write(v, depth + 1)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(compareCodeUnits);
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) throw new Error(`canonicalJSON: undefined value at key "${k}"`);
        parts.push(`${JSON.stringify(k)}:${write(v, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJSON: unsupported type ${typeof value}`);
  }
}

/** Sort by UTF-16 code units (RFC 8785 §3.2.3) — NOT locale order. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return sha256HexBytes(bytes);
}

/** Lowercase hex SHA-256 of raw bytes (geometry hashing). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('rv-parametric-hash: crypto.subtle is unavailable');
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/** `CodeHash` = sha256 of the generator source exactly as stored. */
export function computeCodeHash(code: string): Promise<string> {
  return sha256Hex(code);
}

/** One base part as it enters `PartsHash`. */
export interface PartHashEntry {
  /** Part name under `PartsRoot` (unique). */
  name: string;
  /** Local matrix relative to `PartsRoot`, 16 numbers column-major (three.js `Matrix4.elements`). */
  localMatrix: readonly number[];
  /** Hash of the part's geometry (attributes + index), e.g. `sha256HexBytes`. */
  geometryHash: string;
  /** Stable material identity (e.g. material name + colour); recolouring changes it. */
  materialKey: string;
}

/** `PartsHash` over the base parts, independent of their order. Duplicate names are an error. */
export function computePartsHash(parts: readonly PartHashEntry[]): Promise<string> {
  const seen = new Set<string>();
  const rows = parts.map((p) => {
    if (seen.has(p.name)) throw new Error(`computePartsHash: duplicate part name "${p.name}"`);
    seen.add(p.name);
    if (p.localMatrix.length !== 16) throw new Error(`computePartsHash: part "${p.name}" localMatrix must have 16 numbers`);
    return {
      name: p.name,
      localMatrix: [...p.localMatrix],
      geometryHash: p.geometryHash,
      materialKey: p.materialKey,
    };
  });
  rows.sort((a, b) => compareCodeUnits(a.name, b.name));
  return sha256Hex(canonicalJSON(rows));
}

/** Inputs of `InputHash` (plan-650 §2.3). */
export interface InputHashInput {
  ApiVersion: number;
  CodeHash: string;
  /** Normalized values (`normalizeValues`). */
  Values: Readonly<Record<string, number | boolean | string>>;
  PartsHash: string;
  /**
   * plan-650 Phase 5b (R2-3): declared child families as `[Family, DocHash]`
   * rows. Empty / absent = not hashed at all, so every family without
   * children keeps its Phase-1..5 hash.
   */
  Uses?: readonly (readonly [string, string])[];
  /**
   * plan-2216: identity of the family node. The assembled subtree carries NodeIds and
   * references derived from it, so two families with equal inputs must not share a cache
   * entry. Absent = not hashed.
   */
  FamilyId?: string;
}

/** `InputHash` — the cache key of a variant; equal to `BakedInputHash` for the baked default. */
export function computeInputHash(input: InputHashInput): Promise<string> {
  return sha256Hex(
    canonicalJSON({
      ApiVersion: input.ApiVersion,
      CodeHash: input.CodeHash,
      Values: input.Values,
      PartsHash: input.PartsHash,
      ...(input.FamilyId !== undefined ? { FamilyId: input.FamilyId } : {}),
      ...(input.Uses && input.Uses.length > 0
        ? { Uses: [...input.Uses].map((u) => [u[0], u[1]]).sort((a, b) => compareCodeUnits(a[0], b[0])) }
        : {}),
    }),
  );
}

/** `PlanHash` — hash of a build plan; golden tests only, never a runtime comparison. */
export function computePlanHash(plan: unknown): Promise<string> {
  return sha256Hex(canonicalJSON(plan));
}
