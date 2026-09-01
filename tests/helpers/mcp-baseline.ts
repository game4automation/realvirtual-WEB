// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-baseline — the shape of the checked-in discover baseline (plan-713 Phase 0).
 *
 * Two different gates read the same frozen file, which is why the normalisation
 * lives here once instead of inside each of them:
 *
 *  - **T1** (`rv-mcp-delegate-split.test.ts`) compares the FULL per-tool record
 *    against the baseline. The delegate split of Phase 1 is a pure code move, so
 *    every field an agent or a bridge can observe — name, description,
 *    inputSchema, readOnlyHint, timeoutMs — must come out byte-identical.
 *  - **T4b** (Phase 4) compares the payload SIZE against the baseline's, to keep
 *    the consolidation honest about what it actually saved.
 *
 * Tool ORDER is deliberately not part of the comparison (`.sort()` below): the
 * bridges announce a list, no consumer is promised an order, and pinning one
 * would turn every instance-list reshuffle into a false failure. Everything else
 * is compared verbatim.
 */

import type { ToolSchema } from '../../src/core/engine/rv-mcp-tools';

/** One tool as the baseline freezes it — every field both bridges can observe. */
export interface BaselineTool {
  name: string;
  description: string;
  /** `inputSchema` verbatim; parameter order inside it is the decorator order. */
  inputSchema: ToolSchema['inputSchema'];
  /** `undefined` only for a tool that never classified itself (the lint forbids it). */
  readOnlyHint: boolean | undefined;
  timeoutMs: number | undefined;
}

export interface DiscoverBaseline {
  /** Plan that froze this file — orientation for whoever finds it red. */
  plan: string;
  /** Number of announced tools at freeze time. */
  toolCount: number;
  /** JSON byte length of the `tools` array as `_sendDiscover` sends it. */
  payloadBytes: number;
  /** Coarse token estimate (bytes / 4) — the unit the plan's ≥25 % gate is stated in. */
  approxTokens: number;
  /** Per-delegate tool counts, keyed by the delegate's class name. */
  perDelegate: Record<string, number>;
  tools: BaselineTool[];
}

/** Rough token estimate for English + JSON: ~4 bytes per token. */
export function approxTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

/** Byte length of the tools array exactly as `_sendDiscover` serialises it. */
export function payloadBytes(schemas: readonly ToolSchema[]): number {
  return new TextEncoder().encode(JSON.stringify(schemas)).length;
}

/** Normalise announced schemas into the frozen, order-independent baseline form. */
export function toBaselineTools(schemas: readonly ToolSchema[]): BaselineTool[] {
  return schemas
    .map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema,
      readOnlyHint: s.annotations?.readOnlyHint,
      timeoutMs: s.timeoutMs,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Build the full baseline record from the live schemas plus a per-delegate census. */
export function buildBaseline(
  schemas: readonly ToolSchema[],
  perDelegate: Record<string, number>,
): DiscoverBaseline {
  const bytes = payloadBytes(schemas);
  return {
    plan: 'plan-713 Phase 0 — frozen before the delegate split',
    toolCount: schemas.length,
    payloadBytes: bytes,
    approxTokens: approxTokens(bytes),
    perDelegate,
    tools: toBaselineTools(schemas),
  };
}
