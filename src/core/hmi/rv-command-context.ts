// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-command-context — the MCP side of a command dispatch (plan-499 F15/F21).
 *
 * The bridge resolves a tool's binding exactly ONCE per call, at the very
 * beginning and before any wait ({@link buildCallContext}): which command, which
 * command args, which button, which document and which selection. That one
 * {@link McpCallContext} travels as the trailing argument of `method.apply` into
 * the tool body, whose only job is {@link dispatchBoundCommand} plus the
 * serialisation of the value. Nothing resolves twice, nothing is parked in a
 * global — so the button the choreography pressed, the args the command ran
 * with and the document it wrote to cannot drift apart.
 *
 * {@link bindStandalone} builds the same context for a DIRECT method call
 * (tests, internal callers that bypass the bridge).
 */

import type { RVViewer } from '../rv-viewer';
import {
  getToolEntry,
  resolveBinding,
  type McpCallContext,
  type ToolCommandBinding,
} from '../engine/rv-mcp-tools';
import { commandRegistry, type CommandRegistry, type ExecuteResult } from './rv-command-registry';

export type { McpCallContext } from '../engine/rv-mcp-tools';

let callSeq = 0;

/**
 * Build the per-call context: resolve the binding once and capture document
 * identity + selection NOW (before choreography, before the impl loads).
 */
export function buildCallContext(
  binding: ToolCommandBinding | undefined,
  wire: Readonly<Record<string, unknown>>,
  viewer: RVViewer | undefined,
  callId?: string | number,
  registry: CommandRegistry = commandRegistry,
): McpCallContext {
  const { bound, refusal } = resolveBinding(binding, wire ?? {});
  const captured = registry.captureContext(viewer);
  const buttonKey = bound
    ? (bound.buttonKey ?? registry.buttonKeyOf(bound.id, bound.args))
    : null;
  return {
    callId: String(callId ?? `call-${++callSeq}`),
    bound: bound ? { id: bound.id, args: bound.args, buttonKey } : null,
    refusal,
    handle: captured.handle,
    selection: captured.selection,
  };
}

/**
 * Standalone context for a direct method call: reads the method's decorator
 * binding and resolves it against the given wire args. Production calls come
 * through the bridge with a ready context and never reach this.
 */
export function bindStandalone(
  instance: object,
  methodKey: string,
  wire: Readonly<Record<string, unknown>>,
  viewer: RVViewer | undefined,
  registry: CommandRegistry = commandRegistry,
): McpCallContext {
  const entry = getToolEntry(instance, methodKey);
  return buildCallContext(entry?.command, wire, viewer, undefined, registry);
}

/** Result of a dispatch that had nothing to dispatch (unbound / branch refused). */
export type UnboundResult = { readonly ok: false; readonly kind: 'unbound'; readonly reason: string | null };

/**
 * THE one dispatch of a bound tool body: `execute(id, args, {origin:'mcp'})`
 * with the call's pre-resolved binding, button and early-captured context.
 * Returns `kind:'unbound'` without dispatching when no branch matched or a
 * required value was missing (`reason` = the branch refusal, or null).
 */
export async function dispatchBoundCommand<R = unknown>(
  ctx: McpCallContext,
  viewer?: RVViewer,
  registry: CommandRegistry = commandRegistry,
): Promise<ExecuteResult<R> | UnboundResult> {
  if (!ctx.bound) return { ok: false, kind: 'unbound', reason: ctx.refusal };
  return registry.execute<R>(ctx.bound.id, ctx.bound.args, {
    origin: 'mcp',
    ...(ctx.bound.buttonKey ? { buttonKey: ctx.bound.buttonKey } : {}),
    ...(viewer ? { viewer } : {}),
    context: { handle: ctx.handle, selection: ctx.selection },
  });
}

/** Serialise a failed dispatch the way every tool reports errors: `{error, ...details}`. */
export function commandErrorJson(r: { reason: string | null; details?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  return { error: r.reason ?? 'Nothing to do', ...(r.details ?? {}) };
}
