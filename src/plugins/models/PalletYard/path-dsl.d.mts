// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Types of tools/lib/path-dsl.mjs (plan-612) for the TypeScript importers (layout.ts, tests).

export type Vec3 = [number, number, number];
export type SegmentSpec =
  | { kind: 'line'; from: Vec3; to: Vec3 }
  | { kind: 'arc'; center: Vec3; radius: number; startAngle: number; degrees: number; plane: 'XZ' };

export interface GraphEntry {
  id: string;
  segments: SegmentSpec[];
  successors: string[];
  zone?: string;
  zoneCapacity?: number;
}

export declare const round: (v: number) => number;
export declare const v3: (x: number, z: number) => Vec3;
export declare const line: (x0: number, z0: number, x1: number, z1: number) => SegmentSpec;
export declare const arc: (cx: number, cz: number, radius: number, startAngle: number, degrees: number) => SegmentSpec;
export declare function sCurve(
  x0: number, z0: number, hx: number, sz: number, opts: { sLen: number; offset: number },
): [SegmentSpec, SegmentSpec];
export declare function splitSpec(spec: SegmentSpec, n: number): SegmentSpec[];
export declare const specLength: (s: SegmentSpec) => number;
export declare function buildGraph(
  paths: Record<string, SegmentSpec[]>,
  successors: Record<string, string[]>,
  opts: { maxPiece: number; keepWhole: RegExp },
): { graph: GraphEntry[]; order: string[] };
export declare const lastPieceOf: (graph: ReadonlyArray<{ id: string }>, id: string) => string;
export declare function applyMergeZones(graph: GraphEntry[], merges: Record<string, string[]>, prefix?: string): void;
export declare const pathExtras: (p: GraphEntry) => { Path: Record<string, unknown> };
export declare function cloneNode(doc: unknown, src: unknown, name: string): unknown;
