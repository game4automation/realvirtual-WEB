// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `rv-audit-instruction-targets.mjs` (plan-734).
 *
 * Required because the Node test imports the module statically from TypeScript;
 * without it `npm run typecheck` fails with TS7016. Same convention (and same
 * caveat) as `validate-project.d.mts`: keep in step with the .mjs — nothing
 * ties the two together at compile time.
 */

/** One `CustomRuntimeInstruction` target and how it resolved. */
export interface InstructionTargetFinding {
  /** Name of the node carrying the instruction. */
  owner: string;
  /** 1-based step number within that instruction. */
  step: number;
  /** First 60 characters of the step text. */
  instruction: string;
  /** The authored target path as written in rv_extras. */
  path: string;
  status: 'resolvable' | 'unresolvable' | 'path not in GLB';
  /** Whether any node in the GLB carries this authored path at all. */
  inGlb: boolean;
  /** Resolution stage under the PRE-plan-734 alias rule. */
  stageBefore: string;
  /** Resolution stage under the current alias rule. */
  stageAfter: string;
  /** Whether the pre-plan-734 viewer could resolve it. */
  resolvableBefore: boolean;
  /** The path segment that Three.js both deduplicated AND sanitized, if any. */
  culprit: string | null;
}

export interface InstructionTargetAudit {
  /** True when no target is unresolvable under the current rule. */
  ok: boolean;
  nodes: number;
  meshes: number;
  targets: number;
  /** Targets the CURRENT viewer cannot resolve — the shipping gate. */
  unresolvable: number;
  /** Targets the PRE-plan-734 viewer could not resolve — the bug's blast radius. */
  unresolvableLegacy: number;
  dedupedNodes: number;
  dedupedAndSanitized: number;
  droppedAliases: number;
  findings: InstructionTargetFinding[];
}

export function sanitizeLikeThree(name: string): string;
export function readGlbJson(bytes: Uint8Array): unknown;
export function simulateThreeNames(gltf: unknown): {
  raw: string; threeName: string; restored: boolean; deduped: boolean;
}[];
export function buildPathTable(gltf: unknown): {
  rawPath: (string | null)[];
  canonicalPath: (string | null)[];
  legacyAlias: (string | null)[];
  fixedAliases: string[][];
  info: { raw: string; threeName: string; restored: boolean; deduped: boolean }[];
};
export function collectInstructionTargets(gltf: unknown): {
  ownerNode: number; owner: string; step: number; instruction: string; path: string;
}[];
export function auditGlb(input: Uint8Array | object): InstructionTargetAudit;
export function auditGlbFile(path: string): InstructionTargetAudit;
