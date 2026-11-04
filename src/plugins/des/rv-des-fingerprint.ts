// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-fingerprint.ts — the STRICT DES snapshot fingerprint (plan-2059 Phase 1).
 *
 * Thomas, 2026-11-02: "Nach Aenderungen muss man nicht fortsetzen koennen,
 * Aenderungen sind nicht erlaubt — ein Snapshot funktioniert nur am 1:1
 * identischen Modell." So the fingerprint is ONE hash over everything the
 * loaded model is — no per-property-group hashes, no whitelist, no exception
 * for presentation:
 *
 *  - `documents`  per occurrence (`''` = main model, else the placement root's
 *                 plan-769 address) the SHA-256 of the exact bytes the
 *                 document was decoded from (`rv-model-content-ledger`). The
 *                 ledger key (a load URL — a fresh blob: URL per open) is
 *                 NEVER hashed (R4 #1);
 *  - `scene`      the authored state of EVERY addressed node, DES or not:
 *                 address, complete extras (`userData.realvirtual`, incl. the
 *                 AssetOverrides of placement roots) and local matrix — for a
 *                 node the simulation moves, its rest pose (drive home pose,
 *                 DES instance root pose at bind), so motion during the run
 *                 never changes the hash while a planner move does (R4 #2);
 *  - `components` the DES instances' `{id, type}`;
 *  - `scripts`    the bound script source text;
 *  - `runConfig`  the run parameters (seed, warm-up, run length, ...) —
 *                 NOT part of `modelHash`: they get their own `runConfigHash`
 *                 (Thomas, 2026-11-01: a restore compares model + release
 *                 version only, so a snapshot can be restored with a changed
 *                 run end / warm-up);
 *  - `pathGraph`  the fleet path network (ids, lengths, successors, zones,
 *                 segment support points);
 *  - `schemaVersion`, `rngVersion`.
 *
 * The `{id, type}` list is kept next to the hash for the preflight's
 * diagnosis ("which id is missing / changed type") — it is not a partial
 * hash; equality is decided by `modelHash` alone.
 *
 * Synchronous on purpose: the capture is synchronous (plan-2059 F3). SHA-256
 * uses the shared incremental implementation (FIPS 180-4) because WebCrypto's digest is async.
 */

import { sha256HexUtf8 } from '../../core/engine/rv-sha256';
import type { DocumentHashState } from '../../core/engine/rv-model-content-ledger';

/** Snapshot envelope schema version the fingerprint belongs to. */
export const DES_SNAPSHOT_SCHEMA_VERSION = 4;

/** The fingerprint stored in a v4 snapshot. */
export interface DesFingerprint {
  readonly schemaVersion: typeof DES_SNAPSHOT_SCHEMA_VERSION;
  readonly rngVersion: number;
  /** Sorted by id. Diagnosis only — equality is `modelHash`. */
  readonly components: ReadonlyArray<{ readonly id: string; readonly type: string }>;
  /**
   * SHA-256 (hex) over the canonical JSON of {@link FingerprintInput} WITHOUT
   * `runConfig` (model part + release version). The ONLY hash a restore compares.
   */
  readonly modelHash: string;
  /** SHA-256 (hex) over the run configuration. Informational: a restore never compares it. */
  readonly runConfigHash: string;
}

/** One DES component instance (diagnosis list; its content is in `scene`). */
export interface FingerprintComponent {
  readonly id: string | null;
  readonly type: string;
}

/**
 * One addressed node of the loaded scene: its authored state. `matrix` is the
 * node's LOCAL matrix (column-major, 16 numbers) — for a node the simulation
 * moves, its rest pose (drive home pose, DES instance root pose at bind), so
 * motion during the run never changes the fingerprint (plan-2059 R4 #2).
 */
export interface FingerprintSceneNode {
  readonly address: string;
  /** Address of the nearest addressed ancestor (`''` = none) — the authored hierarchy. */
  readonly parent: string;
  /** Complete authored extras (`userData.realvirtual`), `null` when absent. */
  readonly extras: unknown;
  readonly matrix: ArrayLike<number>;
}

/** One loaded document: where it sits and the ledger verdict on its bytes. */
export interface FingerprintDocument {
  /** `''` for the main model, else the plan-769 address of the placement root (R4 #1); `null` = unaddressed. */
  readonly occurrence: string | null;
  readonly hash: DocumentHashState;
  /** Ledger key (load URL / cache key) — for messages only, NEVER hashed. */
  readonly key?: string;
}

/** One path of the fleet path graph. */
export interface FingerprintPath {
  readonly id: string;
  readonly length: number;
  readonly closed: boolean;
  readonly successorIds: readonly string[];
  readonly zoneId: string | null;
  readonly zoneCapacity: number | null;
  readonly align: readonly number[];
  readonly segments: ReadonlyArray<{ readonly length: number; readonly p0: readonly number[]; readonly pm: readonly number[]; readonly p1: readonly number[] }>;
}

/** Everything the strict fingerprint hashes. */
export interface FingerprintInput {
  readonly runtimeVersion: string;
  readonly rngVersion: number;
  readonly documents: readonly FingerprintDocument[];
  readonly scene: readonly FingerprintSceneNode[];
  readonly components: readonly FingerprintComponent[];
  readonly scripts: ReadonlyArray<{ readonly id: string; readonly source: string }>;
  readonly runConfig: unknown;
  readonly pathGraph: readonly FingerprintPath[];
}

/** Result: a complete fingerprint, or why none can be built (never a silent subset). */
export type FingerprintResult =
  | { readonly ok: true; readonly fingerprint: DesFingerprint }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Build the strict fingerprint. Input order does not matter (every list is
 * sorted by its key); any change of any input value changes `modelHash`.
 */
export function buildDesFingerprint(input: FingerprintInput): FingerprintResult {
  const reasons: string[] = [];
  if (!Number.isInteger(input.rngVersion)) reasons.push(`rngVersion is not an integer (${String(input.rngVersion)})`);

  const documents: Array<{ occurrence: string; sha256: string }> = [];
  const seenOcc = new Set<string>();
  for (const d of input.documents) {
    if (d.occurrence === null) { reasons.push(`placement document '${d.key ?? '?'}' has no node address`); continue; }
    const label = d.occurrence === '' ? 'main model' : `placement '${d.occurrence}'`;
    if (seenOcc.has(d.occurrence)) { reasons.push(`${label}: listed twice`); continue; }
    seenOcc.add(d.occurrence);
    const where = d.key ? ` (${d.key})` : '';
    if (d.hash.state === 'ready') documents.push({ occurrence: d.occurrence, sha256: d.hash.sha256 });
    else if (d.hash.state === 'pending') reasons.push(`${label}${where}: content hash still pending`);
    else reasons.push(`${label}${where}: content hash unavailable (${d.hash.reason})`);
  }

  documents.sort((a, b) => cmp(a.occurrence, b.occurrence));

  const scene: Array<{ address: string; parent: string; extras: unknown; matrix: number[] }> = [];
  const seenAddr = new Set<string>();
  for (const n of input.scene) {
    if (!n.address) { reasons.push('scene node without address'); continue; }
    if (seenAddr.has(n.address)) { reasons.push(`scene address '${n.address}' listed twice`); continue; }
    seenAddr.add(n.address);
    const m = Array.from(n.matrix ?? []);
    if (m.length !== 16) { reasons.push(`scene node '${n.address}': matrix has ${m.length} entries`); continue; }
    scene.push({ address: n.address, parent: n.parent ?? '', extras: n.extras ?? null, matrix: m });
  }
  scene.sort((a, b) => cmp(a.address, b.address));

  const components: Array<{ id: string; type: string }> = [];
  const seenId = new Set<string>();
  for (const c of input.components) {
    if (!c.id) { reasons.push(`component of type '${c.type}' has no DES component id`); continue; }
    if (seenId.has(c.id)) { reasons.push(`duplicate DES component id '${c.id}'`); continue; }
    seenId.add(c.id);
    components.push({ id: c.id, type: c.type });
  }
  components.sort((a, b) => cmp(a.id, b.id));

  const scriptIds = new Set<string>();
  for (const script of input.scripts) {
    if (!script.id) reasons.push('script has no DES component id');
    else if (scriptIds.has(script.id)) reasons.push(`duplicate script id '${script.id}'`);
    scriptIds.add(script.id);
  }
  const scripts = [...input.scripts].map((s) => ({ id: s.id, source: s.source }))
    .sort((a, b) => cmp(a.id, b.id) || cmp(a.source, b.source));
  const pathGraph = [...input.pathGraph].sort((a, b) => cmp(a.id, b.id));

  if (reasons.length > 0) return { ok: false, reasons };

  let text: string;
  let runConfigText: string;
  try {
    text = canonicalFingerprintJson({
      schemaVersion: DES_SNAPSHOT_SCHEMA_VERSION,
      rngVersion: input.rngVersion,
      runtimeVersion: input.runtimeVersion,
      documents,
      scene,
      components,
      scripts,
      pathGraph,
    });
    runConfigText = canonicalFingerprintJson(input.runConfig ?? null);
  } catch (e) {
    return { ok: false, reasons: [`model input not hashable: ${(e as Error).message}`] };
  }
  return {
    ok: true,
    fingerprint: {
      schemaVersion: DES_SNAPSHOT_SCHEMA_VERSION,
      rngVersion: input.rngVersion,
      components,
      modelHash: sha256HexUtf8(text),
      runConfigHash: sha256HexUtf8(runConfigText),
    },
  };
}

/** Two fingerprints describe the same model iff every field is equal (strict). */
export function sameDesFingerprint(a: DesFingerprint, b: DesFingerprint): boolean {
  return a.schemaVersion === b.schemaVersion && a.rngVersion === b.rngVersion && a.modelHash === b.modelHash;
}

/** Rows of a path network for {@link FingerprintInput.pathGraph}. Structural: any `RVPathNetwork`. */
export function pathGraphRows(network: { all(): ReadonlyArray<PathLike> } | null | undefined): FingerprintPath[] {
  if (!network) return [];
  const xyz = (o: { x: number; y: number; z: number }): number[] => [o.x, o.y, o.z];
  return network.all().map((p) => ({
    id: p.id,
    length: p.length,
    closed: !!p.closed,
    successorIds: [...(p.successorIds ?? [])],
    zoneId: p.zoneId ?? null,
    zoneCapacity: p.zoneCapacity ?? null,
    align: p.align ? xyz(p.align) : [],
    segments: (p.segments ?? []).map((s) => ({
      length: s.length,
      p0: xyz(s.getPosition(0)),
      pm: xyz(s.getPosition(0.5)),
      p1: xyz(s.getPosition(1)),
    })),
  }));
}

/** The structural path surface {@link pathGraphRows} reads (an `RVPath` satisfies it). */
export interface PathLike {
  readonly id: string;
  readonly length: number;
  readonly closed?: boolean;
  readonly successorIds?: readonly string[];
  readonly zoneId?: string | null;
  readonly zoneCapacity?: number | null;
  readonly align?: { x: number; y: number; z: number };
  readonly segments?: ReadonlyArray<{
    readonly length: number;
    getPosition(t01: number): { x: number; y: number; z: number };
  }>;
}

// ─── Canonical JSON (deterministic, lossless for what the fingerprint holds) ─

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic JSON: object keys sorted by code unit, non-finite numbers and
 * -0 tagged, Map/Set/typed arrays encoded, functions and class instances
 * refused (a model input holding behaviour is not "1:1 comparable"). Cycles
 * throw.
 */
export function canonicalFingerprintJson(value: unknown): string {
  const stack = new Set<object>();
  const enc = (v: unknown, path: string): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'boolean': return v ? 'true' : 'false';
      case 'string': return JSON.stringify(v);
      case 'number':
        if (Number.isNaN(v)) return '{"$num":"NaN"}';
        if (v === Infinity) return '{"$num":"Infinity"}';
        if (v === -Infinity) return '{"$num":"-Infinity"}';
        if (Object.is(v, -0)) return '{"$num":"-0"}';
        return JSON.stringify(v);
      case 'undefined': return '{"$undef":1}';
      case 'bigint': return `{"$bigint":${JSON.stringify(v.toString())}}`;
      case 'function':
      case 'symbol':
        throw new Error(`${typeof v} at ${path || '<root>'}`);
      default: break;
    }
    const o = v as object;
    if (stack.has(o)) throw new Error(`cycle at ${path || '<root>'}`);
    stack.add(o);
    try {
      if (Array.isArray(o)) return `[${o.map((x, i) => enc(x, `${path}[${i}]`)).join(',')}]`;
      if (ArrayBuffer.isView(o) && !(o instanceof DataView)) {
        const arr = Array.from(o as unknown as ArrayLike<number | bigint>, (x) => (typeof x === 'bigint' ? x.toString() : x));
        return `{"$typed":${JSON.stringify(o.constructor.name)},"v":${enc(arr, path)}}`;
      }
      if (o instanceof Map) {
        const rows = [...o.entries()].map(([k, x]) => [enc(k, `${path}<key>`), enc(x, `${path}<value>`)] as const)
          .sort((a, b) => cmp(a[0], b[0]));
        return `{"$map":[${rows.map(([k, x]) => `[${k},${x}]`).join(',')}]}`;
      }
      if (o instanceof Set) {
        const rows = [...o.values()].map((x) => enc(x, `${path}<item>`)).sort(cmp);
        return `{"$set":[${rows.join(',')}]}`;
      }
      const proto = Object.getPrototypeOf(o);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`non-plain object (${(o as { constructor?: { name?: string } }).constructor?.name ?? '?'}) at ${path || '<root>'}`);
      }
      const keys = Object.keys(o).sort(cmp);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${enc((o as Record<string, unknown>)[k], `${path}.${k}`)}`).join(',')}}`;
    } finally {
      stack.delete(o);
    }
  };
  return enc(value, '');
}

// Re-export the established fingerprint helpers for existing callers.
export { sha256Hex, sha256HexUtf8 } from '../../core/engine/rv-sha256';
