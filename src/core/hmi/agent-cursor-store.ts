// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * agent-cursor-store — what the agent is touching right now (plan-626 F8).
 *
 * The MCP bridge reports every WRITING call twice: at its begin (targets from the arguments)
 * and at its end (targets the result addresses — e.g. the placement `web_layout_place` just
 * created). The store keeps
 *
 *  - the CURSOR: the targets of the newest call, live for {@link CURSOR_MS} after the call ends
 *    (the bridge marks them in the viewport — static, no pulsing, see rv-mcp-editor-feedback),
 *  - the ACTIVITY LIST: the last {@link ACTIVITY_CAP} calls (tool, class, targets, ok) for the
 *    chat panel of plan-625.
 *
 * Pure module — no three.js, no viewer. Targets are references the bridge resolves itself
 * (a node path, or a layout placement id).
 */

import { useSyncExternalStore } from 'react';
import { parsePathList } from './rv-path-list';

/** How long the cursor stays on its targets after the call ended, in ms. */
export const CURSOR_MS = 1500;
/** Number of calls kept in the activity list. */
export const ACTIVITY_CAP = 50;

/** One thing a call touched: a scene node path or a layout placement id. */
export interface AgentTarget {
  kind: 'path' | 'placement';
  value: string;
}

/** One entry of the activity list. */
export interface AgentActivity {
  seq: number;
  tool: string;
  toolClass: string;
  targets: AgentTarget[];
  /** null while running. */
  ok: boolean | null;
  startedAt: number;
  endedAt: number | null;
}

/** The cursor: targets of the newest call while it runs and {@link CURSOR_MS} after. */
export interface AgentCursor {
  phase: 'idle' | 'running' | 'afterglow';
  tool: string | null;
  targets: AgentTarget[];
}

type Rec = Record<string, unknown>;

const IDLE: AgentCursor = Object.freeze({ phase: 'idle', tool: null, targets: [] }) as AgentCursor;

let _seq = 0;
let _activities: AgentActivity[] = [];
let _cursor: AgentCursor = IDLE;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _now: () => number = () => Date.now();
const listeners = new Set<() => void>();

function emit(): void { for (const l of listeners) l(); }

/** THE shared path-list rule (`rv-path-list`); a broken JSON list shows no cursor target — the tool reports it. */
function splitPaths(raw: unknown): string[] {
  try { return parsePathList(raw); } catch { return []; }
}

function isLayoutTool(tool: string, command?: string): boolean {
  return tool.startsWith('web_layout_') || (command?.startsWith('layout.') ?? false);
}

function dedupe(targets: AgentTarget[]): AgentTarget[] {
  const seen = new Set<string>();
  const out: AgentTarget[] = [];
  for (const t of targets) {
    const key = `${t.kind}:${t.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

const PATH_ARG_KEYS = ['path', 'targetPath', 'nodePath', 'parentPath', 'parent'] as const;

/** Targets a call names in its arguments. `command` = the bound / executed command id, if any. */
export function targetsFromArgs(tool: string, args: Rec | undefined, command?: string): AgentTarget[] {
  if (!args) return [];
  // web_execute / web_batch carry the command's own args one level down.
  const inner = (args.args && typeof args.args === 'object' ? args.args : args) as Rec;
  const out: AgentTarget[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = inner[key];
    if (typeof v === 'string' && v.trim()) out.push({ kind: 'path', value: v.trim() });
  }
  for (const p of splitPaths(inner.paths)) out.push({ kind: 'path', value: p });
  if (isLayoutTool(tool, command)) {
    for (const key of ['id', 'onto', 'targetId'] as const) {
      const v = inner[key];
      if (typeof v === 'string' && v) out.push({ kind: 'placement', value: v });
    }
  }
  return dedupe(out);
}

/** Targets a result addresses — new nodes and placements included (F8: `web_layout_place`). */
export function targetsFromResult(tool: string, result: unknown, command?: string): AgentTarget[] {
  let parsed: unknown = result;
  if (typeof result === 'string') {
    try { parsed = JSON.parse(result); } catch { return []; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const r = parsed as Rec;
  if (typeof r.error === 'string') return [];
  // web_execute / web_batch answer with the command's value under `value`.
  const v = (r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : r) as Rec;
  const out: AgentTarget[] = [];
  for (const key of ['path', 'node', 'createdPath'] as const) {
    if (typeof v[key] === 'string' && v[key]) out.push({ kind: 'path', value: v[key] as string });
  }
  for (const p of splitPaths(v.paths)) out.push({ kind: 'path', value: p });
  const created = v.created;
  if (typeof created === 'string') out.push({ kind: 'path', value: created });
  else if (Array.isArray(created)) {
    for (const c of created) {
      if (typeof c === 'string') out.push({ kind: 'path', value: c });
      else if (c && typeof c === 'object' && typeof (c as Rec).path === 'string') out.push({ kind: 'path', value: (c as Rec).path as string });
    }
  } else if (created && typeof created === 'object' && typeof (created as Rec).path === 'string') {
    out.push({ kind: 'path', value: (created as Rec).path as string });
  }
  if (isLayoutTool(tool, command) && typeof v.id === 'string' && v.id) out.push({ kind: 'placement', value: v.id });
  return dedupe(out);
}

/** Starts one writing call; returns its sequence number for {@link endAgentCall}. */
export function beginAgentCall(tool: string, toolClass: string, targets: AgentTarget[]): number {
  const seq = ++_seq;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _activities = [..._activities, { seq, tool, toolClass, targets, ok: null, startedAt: _now(), endedAt: null }]
    .slice(-ACTIVITY_CAP);
  _cursor = { phase: 'running', tool, targets };
  emit();
  return seq;
}

/** Ends a call: merges result targets, starts the {@link CURSOR_MS} afterglow of the cursor. */
export function endAgentCall(seq: number, ok: boolean, resultTargets: AgentTarget[] = []): void {
  const idx = _activities.findIndex((a) => a.seq === seq);
  if (idx < 0) return;
  const prev = _activities[idx];
  const targets = dedupe([...prev.targets, ...resultTargets]);
  const next = { ...prev, ok, targets, endedAt: _now() };
  _activities = [..._activities.slice(0, idx), next, ..._activities.slice(idx + 1)];
  // Only the NEWEST call owns the cursor; an older one finishing late leaves it alone.
  if (seq === _seq) {
    _cursor = { phase: 'afterglow', tool: prev.tool, targets };
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { _timer = null; _cursor = IDLE; emit(); }, CURSOR_MS);
  }
  emit();
}

/** The current cursor. */
export function getAgentCursor(): AgentCursor { return _cursor; }

/** The activity list, oldest first (≤ {@link ACTIVITY_CAP}). */
export function getAgentActivities(): readonly AgentActivity[] { return _activities; }

/** Subscribe to cursor / activity changes. */
export function subscribeAgentCursor(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — the current cursor. */
export function useAgentCursor(): AgentCursor {
  return useSyncExternalStore(subscribeAgentCursor, getAgentCursor, getAgentCursor);
}

/** React hook — the activity list. */
export function useAgentActivities(): readonly AgentActivity[] {
  return useSyncExternalStore(subscribeAgentCursor, getAgentActivities, getAgentActivities);
}

/** Test seam: reset everything and optionally inject a clock. */
export function _resetAgentCursorForTests(now?: () => number): void {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _seq = 0;
  _activities = [];
  _cursor = IDLE;
  _now = now ?? (() => Date.now());
  listeners.clear();
}
