// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-check-tools — `web_check_gap` / `web_check_contact` (plan-641 Phase 4).
 *
 * Read-only tools (no command, nothing recorded): the mesh-exact minimum
 * distance between two nodes, optionally in a POSE of drive positions. The pose
 * is set through the public pose adapter (`rv-pose-adapter.ts`, M6) for the
 * synchronous duration of the copy of both targets' world triangles and taken
 * back before the measurement itself runs; the geometry module
 * (`rv-mesh-gap.ts`, M7) and three-mesh-bvh are loaded lazily on the first
 * check.
 *
 * `runGeometryCheck` is the ONE entry — the tools and the macro replay's
 * assertion lines (`web_macro_assert`) both go through it, so an assertion
 * measures exactly what the tool measures.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVDrive } from '../../core/engine/rv-drive';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';

/** The checks an assertion line may name (the allowlist of `kind: 'assert'`). */
export const GEOMETRY_CHECKS = ['gap', 'contact'] as const;
export type GeometryCheck = (typeof GEOMETRY_CHECKS)[number];

export function isGeometryCheck(v: unknown): v is GeometryCheck {
  return typeof v === 'string' && (GEOMETRY_CHECKS as readonly string[]).includes(v);
}

/** Arguments of one check (also the stored `args` of an assertion line). */
export interface GeometryCheckArgs {
  a: string;
  b: string;
  /** Drive path or unique name → position (mm / deg). */
  pose?: Record<string, number>;
  toleranceMm?: number;
}

/** A check that could not run — `code` is machine-readable. */
export interface GeometryCheckError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface GeometryCheckResult {
  a: string;
  b: string;
  gapMm: number;
  contact: boolean;
  overlap: boolean;
  contained: boolean;
  containedIn?: 'a' | 'b';
  toleranceMm: number;
  closestA?: [number, number, number];
  closestB?: [number, number, number];
  tree: 'editor' | 'runtime';
  triangles: { a: number; b: number };
  pose: Array<{ drive: string; position: number; source: 'explicit' | 'gear' }>;
}

/** Parse the `pose` wire value: a JSON object string (or an object) of finite numbers. */
export function parsePoseParam(raw: unknown): Record<string, number> | { error: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { error: 'pose must be a JSON object like {"Cell/Cylinder": 5}' }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'pose must be a JSON object of drive → position' };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `pose value for "${k}" is not a number` };
    out[k] = n;
  }
  return out;
}

/**
 * Run one geometry check against the viewer's current tree. Never throws —
 * an error comes back as `{ error, code }`.
 */
export async function runGeometryCheck(
  viewer: RVViewer | undefined,
  args: GeometryCheckArgs,
): Promise<GeometryCheckResult | GeometryCheckError> {
  const reg = viewer?.registry;
  if (!viewer || !reg) return { error: 'No viewer/registry', code: 'no-viewer' };
  const nodeA = reg.getNode(String(args.a ?? ''));
  if (!nodeA) return { error: `Node not found: "${args.a}"`, code: 'node-not-found' };
  const nodeB = reg.getNode(String(args.b ?? ''));
  if (!nodeB) return { error: `Node not found: "${args.b}"`, code: 'node-not-found' };
  const tol = args.toleranceMm === undefined || args.toleranceMm === null ? undefined : Number(args.toleranceMm);
  if (tol !== undefined && (!Number.isFinite(tol) || tol < 0)) return { error: 'toleranceMm must be a number >= 0', code: 'invalid-args' };

  const [gap, poseMod] = await Promise.all([
    import('./rv-mesh-gap'),
    import('../../core/engine/rv-pose-adapter'),
  ]);
  try {
    const chunks = (viewer as { bakeRegistry?: import('./rv-mesh-gap').GapChunkSource }).bakeRegistry ?? null;
    const ta = gap.collectGapTarget(nodeA, chunks);
    const tb = gap.collectGapTarget(nodeB, chunks);
    const total = ta.triangles + tb.triangles;
    if (total > gap.GAP_TRIANGLE_BUDGET) {
      return {
        error: `The two targets hold ${total} triangles together (budget ${gap.GAP_TRIANGLE_BUDGET}) — measure a smaller node`,
        code: 'too-complex', details: { triangles: { a: ta.triangles, b: tb.triangles }, budget: gap.GAP_TRIANGLE_BUDGET },
      };
    }
    const editorTree = ta.tree === 'editor' || tb.tree === 'editor';
    const ctx = {
      drives: (viewer.drives ?? []) as readonly RVDrive[],
      drivePath: (p: string) => reg.getByPath<RVDrive>('Drive', p),
      editorTree,
    };
    // The pose exists only while both soups are copied (synchronous) — the
    // measurement runs on the copies after every node is back.
    const { result: soups, axes } = poseMod.withPose(ctx, args.pose ?? {}, () => {
      nodeA.updateWorldMatrix(true, true);
      nodeB.updateWorldMatrix(true, true);
      return { a: gap.worldTriangles(ta), b: gap.worldTriangles(tb) };
    });
    const r = gap.measureGap(soups.a, soups.b, tol ?? gap.DEFAULT_TOLERANCE_MM);
    return {
      a: args.a, b: args.b, ...r,
      tree: editorTree ? 'editor' : 'runtime',
      triangles: { a: ta.triangles, b: tb.triangles },
      pose: axes,
    };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const details = (e as { details?: Record<string, unknown> }).details;
    return {
      error: e instanceof Error ? e.message : String(e),
      code: typeof code === 'string' ? code : 'check-failed',
      ...(details && Object.keys(details).length ? { details } : {}),
    };
  }
}

/** Expectation of an assertion line. */
export interface GeometryExpect {
  gapMm?: { min?: number; max?: number };
  contact?: boolean;
}

/** Compare a check result with `expect`; null = pass, else the reason. */
export function failedExpectation(r: GeometryCheckResult, expect: GeometryExpect): string | null {
  const reasons: string[] = [];
  if (expect.contact !== undefined && r.contact !== expect.contact) {
    reasons.push(`contact is ${r.contact}, expected ${expect.contact}`);
  }
  const g = expect.gapMm;
  if (g?.min !== undefined && !(r.gapMm >= g.min)) reasons.push(`gap ${r.gapMm} mm < min ${g.min} mm`);
  if (g?.max !== undefined && !(r.gapMm <= g.max)) reasons.push(`gap ${r.gapMm} mm > max ${g.max} mm`);
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function toolArgs(a: string, b: string, pose: string | undefined, toleranceMm: number | undefined): GeometryCheckArgs | GeometryCheckError {
  const p = parsePoseParam(pose);
  if ('error' in p) return { error: String(p.error), code: 'invalid-args' };
  return {
    a: String(a ?? '').trim(), b: String(b ?? '').trim(),
    ...(Object.keys(p).length ? { pose: p as Record<string, number> } : {}),
    ...(toleranceMm !== undefined && toleranceMm !== null ? { toleranceMm: Number(toleranceMm) } : {}),
  };
}

export class McpCheckTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  @McpTool('Mesh-exact gap in mm between two nodes (not AABB), optionally in a drive pose that is restored afterwards. Returns gapMm, contact, overlap, contained.', { readOnly: true, timeoutMs: 60_000 })
  async webCheckGap(
    @McpParam('a', 'Node path A.') a: string,
    @McpParam('b', 'Node path B.') b: string,
    @McpParam('pose', 'JSON {drive: mm|deg}.', 'string', false) pose?: string,
    @McpParam('toleranceMm', 'Default 0.1.', 'number', false) toleranceMm?: number,
  ): Promise<string> {
    const args = toolArgs(a, b, pose, toleranceMm);
    if ('error' in args) return JSON.stringify(args);
    return JSON.stringify(await runGeometryCheck(this.getViewer(), args));
  }

  @McpTool('Do two nodes touch (mesh gap <= toleranceMm)? Same check as web_check_gap.', { readOnly: true, timeoutMs: 60_000 })
  async webCheckContact(
    @McpParam('a', 'Node path A.') a: string,
    @McpParam('b', 'Node path B.') b: string,
    @McpParam('pose', 'JSON {drive: mm|deg}.', 'string', false) pose?: string,
    @McpParam('toleranceMm', 'Default 0.1.', 'number', false) toleranceMm?: number,
  ): Promise<string> {
    const args = toolArgs(a, b, pose, toleranceMm);
    if ('error' in args) return JSON.stringify(args);
    const r = await runGeometryCheck(this.getViewer(), args);
    if ('error' in r) return JSON.stringify(r);
    const { contact, ...rest } = r;
    return JSON.stringify({ contact, ...rest });
  }

  // plan-641 Phase 5 — the first step of "look up → model → check → save".
  /** Read-only command body; preserves the original JSON value contract. */
  async queryPartLookup(
    name: string,
  ): Promise<string> {
    const text = String(name ?? '').trim();
    if (!text) return JSON.stringify({ error: 'name is required' });
    try {
      const { loadPartLibrary, lookupPart } = await import('../../core/knowledge/rv-part-library');
      const lib = await loadPartLibrary();
      const matches = lookupPart(text, lib);
      return JSON.stringify({
        name: text, matches,
        ...(matches.length === 0 ? { note: 'No rule matches — do not guess; ask, or read the datasheet and cite it.' } : {}),
      });
    } catch (e) {
      return JSON.stringify({ error: `Part library unavailable: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}
