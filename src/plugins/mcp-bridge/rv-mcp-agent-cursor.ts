// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-agent-cursor — the bridge half of the agent cursor (plan-626 F8).
 *
 * Every writing MCP call is reported to `agent-cursor-store` (begin with the argument targets,
 * end with the result targets). This module turns the store's cursor into viewport feedback:
 *
 *  - the targets are marked through a named aux-emphasis set in the HOVER colour — static, no
 *    pulsing (rv-mcp-editor-feedback.ts rule), and on its own channel so the user's real hover
 *    is never cleared by it — for the call and {@link CURSOR_MS} after it;
 *  - the camera follows through `followAgent` (the plan-520 decision) for tools that the editor
 *    feedback table does not already frame.
 *
 * The button afterglow stays with the existing choreography (bound tools press their button).
 * Nothing here may break a call: every hook is wrapped.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { listToolEntries } from '../../core/engine/rv-mcp-tools';
import {
  beginAgentCall,
  endAgentCall,
  getAgentCursor,
  subscribeAgentCursor,
  targetsFromArgs,
  targetsFromResult,
  type AgentTarget,
} from '../../core/hmi/agent-cursor-store';
import { resolveToolClass, type McpToolClass } from './rv-mcp-tool-class';
import { followAgent } from './rv-mcp-follow-policy';

/** Aux-emphasis set id of the agent cursor. */
export const AGENT_CURSOR_EMPHASIS = 'agent-cursor';

type DispatchEntry = { instance: object; methodKey: string };

const classCache = new Map<string, McpToolClass | undefined>();
let viewerHooked: RVViewer | null = null;
let unsubscribe: (() => void) | null = null;

/** The class of one dispatched tool (cached; undefined = unclassified). */
export function toolClassOf(tool: string, entry: DispatchEntry): McpToolClass | undefined {
  if (classCache.has(tool)) return classCache.get(tool);
  const meta = listToolEntries(entry.instance).find((e) => e.methodKey === entry.methodKey);
  const cls = meta ? resolveToolClass(meta) : undefined;
  classCache.set(tool, cls);
  return cls;
}

function placementRoot(viewer: RVViewer, id: string): Object3D | null {
  const planner = viewer.getPlugin?.('layout-planner') as unknown as { getPlacedRootById?: (id: string) => Object3D | null } | undefined;
  try { return planner?.getPlacedRootById?.(id) ?? null; } catch { return null; }
}

function resolveTargets(viewer: RVViewer, targets: readonly AgentTarget[]): Object3D[] {
  const out: Object3D[] = [];
  for (const t of targets) {
    const node = t.kind === 'path' ? viewer.registry?.getNode(t.value) ?? null : placementRoot(viewer, t.value);
    if (node && !out.includes(node)) out.push(node);
  }
  return out;
}

function hookViewer(viewer: RVViewer): void {
  if (viewerHooked === viewer) return;
  unsubscribe?.();
  viewerHooked = viewer;
  const render = (): void => {
    try {
      const cursor = getAgentCursor();
      const highlighter = viewer.highlighter;
      if (!highlighter) return;
      const nodes = cursor.phase === 'idle' ? [] : resolveTargets(viewer, cursor.targets);
      highlighter.setAuxEmphasis(
        AGENT_CURSOR_EMPHASIS,
        nodes.length ? nodes : null,
        { color: highlighter.getHoverStyle().edgeColor },
      );
      viewer.markRenderDirty?.();
    } catch { /* the cursor must never break anything */ }
  };
  unsubscribe = subscribeAgentCursor(render);
}

/** Command id a call executes: the bound command, or `web_execute`'s `id` argument. */
function commandOf(tool: string, args: Record<string, unknown> | undefined, boundId?: string): string | undefined {
  if (boundId) return boundId;
  if (tool === 'web_execute' && typeof args?.id === 'string') return args.id;
  return undefined;
}

/** Reports a call's begin. Returns 0 for a read (not tracked). */
export function agentCallBegin(
  viewer: RVViewer | undefined, tool: string, entry: DispatchEntry,
  args: Record<string, unknown> | undefined, boundId?: string,
): number {
  try {
    const cls = toolClassOf(tool, entry);
    if (cls === 'read') return 0;
    if (viewer) hookViewer(viewer);
    return beginAgentCall(tool, cls ?? 'unclassified', targetsFromArgs(tool, args, commandOf(tool, args, boundId)));
  } catch {
    return 0;
  }
}

/**
 * Reports a call's end. `framesItself` = the editor feedback already decides the camera for
 * this tool (it calls the same follow policy); otherwise the cursor asks `followAgent`.
 */
export function agentCallEnd(
  viewer: RVViewer | undefined, seq: number, tool: string,
  args: Record<string, unknown> | undefined, result: unknown, ok: boolean,
  boundId: string | undefined, framesItself: boolean,
): void {
  if (!seq) return;
  try {
    const targets = ok ? targetsFromResult(tool, result, commandOf(tool, args, boundId)) : [];
    endAgentCall(seq, ok, targets);
    if (!ok || framesItself || !viewer) return;
    const cursor = getAgentCursor();
    const paths: string[] = [];
    for (const node of resolveTargets(viewer, cursor.targets)) {
      const p = viewer.registry?.getPathForNode(node);
      if (p) paths.push(p);
    }
    if (paths.length) followAgent(viewer, paths);
  } catch { /* never break the call */ }
}

/** True when a tool result reports a failure (`{error: …}` or a thrown call). */
export function resultFailed(result: unknown): boolean {
  if (typeof result !== 'string') return false;
  if (!result.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return typeof parsed.error === 'string' || parsed.ok === false;
  } catch {
    return false;
  }
}

/** Test seam. */
export function _resetAgentCursorBridgeForTests(): void {
  classCache.clear();
  unsubscribe?.();
  unsubscribe = null;
  viewerHooked = null;
}
