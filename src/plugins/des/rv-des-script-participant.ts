// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { ScriptStateSource } from './des-runner';
import type { SnapshotHandleRef } from './rv-des-preflight';
import type { SnapshotPart } from './rv-snapshot-registry';
import type { SnapshotRegistry } from './rv-snapshot-registry';
import { fromSnapshotData, toSnapshotData, type SnapshotSchema } from './rv-snapshot-contract';

export interface ScriptTimerTable {
  next: number;
  items: { pid: number; interval: number; hook: string; data: unknown; current: number }[];
}

function validateTimers(value: unknown): asserts value is ScriptTimerTable {
  const t = value as ScriptTimerTable | null;
  if (!t || !Number.isSafeInteger(t.next) || t.next < 1 || !Array.isArray(t.items)
    || Object.keys(t).some(k => !['next', 'items'].includes(k))) throw new Error('invalid script timers');
  const ids = new Set<number>();
  for (const item of t.items) {
    if (!item || !Number.isSafeInteger(item.pid) || item.pid >= 0 || -item.pid >= t.next
      || ids.has(item.pid) || !Number.isFinite(item.interval) || item.interval <= 0
      || typeof item.hook !== 'string' || !Object.hasOwn(item, 'data')
      || !Number.isInteger(item.current) || item.current < 0 || item.current > 2 ** 32 - 1
      || Object.keys(item).some(k => !['pid', 'interval', 'hook', 'data', 'current'].includes(k)))
      throw new Error('invalid script timer item');
    ids.add(item.pid);
  }
}

/** Pure, restore-only enumeration; existing fixed action handle fields are independent. */
export function scriptTimerHandleRefs(parts: readonly SnapshotPart[], scriptIds: ReadonlySet<string>): SnapshotHandleRef[] {
  const refs: SnapshotHandleRef[] = [];
  for (const part of parts) {
    if (!scriptIds.has(part.key)) continue;
    const timers = (fromSnapshotData(part.state, { participant: part.key, ...SCRIPT_STATE_SCHEMA }) as ScriptSnapshotState).timers;
    validateTimers(timers);
    timers.items.forEach((timer, i) => refs.push({ participant: part.key,
      path: `timers.items.${i}.current`, eventId: timer.current, action: 'Script.Hook', owner: part.key,
      expect: event => {
        const p = event.data as { hook?: unknown; desId?: unknown; data?: { pid?: unknown } } | null;
        return p?.desId === part.key && p.hook === '__rv.every' && p.data?.pid === timer.pid;
      },
    }));
  }
  return refs;
}

/** Reverse check: every queued `__rv.every` slice must be the `current` slice of exactly one timer of its script. */
export function scriptTimerQueueProblems(events: readonly { id: number; action: string; data?: unknown }[],
  parts: readonly SnapshotPart[], scriptIds: ReadonlySet<string>): string[] {
  const claimed = new Map<number, number>();
  for (const part of parts) {
    if (!scriptIds.has(part.key)) continue;
    const timers = (fromSnapshotData(part.state, { participant: part.key, ...SCRIPT_STATE_SCHEMA }) as ScriptSnapshotState).timers;
    validateTimers(timers);
    for (const t of timers.items) claimed.set(t.current, (claimed.get(t.current) ?? 0) + 1);
  }
  const problems: string[] = [];
  for (const e of events) {
    const p = e.action === 'Script.Hook' ? e.data as { hook?: unknown; desId?: unknown } | null : null;
    if (p?.hook !== '__rv.every') continue;
    if (typeof p.desId !== 'string' || !scriptIds.has(p.desId)) { problems.push(`timer slice ${e.id} has an unknown script`); continue; }
    if (claimed.get(e.id) !== 1) problems.push(`timer slice ${e.id} is not owned by exactly one timer record`);
  }
  return problems;
}

// plan-2061 V5: the captured `rng` int IS the v2 script stream state; des.rng never duplicates it.
// plan-2212 Phase 3: `stats` = the published `self.statValue` rows `[key, value, unit, group]`.
export interface ScriptSnapshotState { rng: number; fsmState?: string; persist?: unknown; legacy?: unknown; timers: ScriptTimerTable;
  stats?: [string, number | string | null, string | null, string | null][] }

/** A stat value may be NaN / ±Infinity / -0 (a script divides): tagged like other snapshot numbers. */
const SCRIPT_STATE_SCHEMA: SnapshotSchema = { codecs: { 'stats[][1]': 'number-tags' } };

function validateStats(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('invalid script stat rows');
  const keys = new Set<string>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== 'string' || keys.has(row[0])
      || !(row[1] === null || typeof row[1] === 'number' || typeof row[1] === 'string')
      || !(row[2] === null || typeof row[2] === 'string') || !(row[3] === null || typeof row[3] === 'string'))
      throw new Error('invalid script stat row');
    keys.add(row[0]);
  }
}

/** Script VM wiring is a service. Only the declared guest data crosses the boundary. */
export function scriptParticipants(registry: SnapshotRegistry, sources: readonly ScriptStateSource[] = []) {
  const scripts = new Map<string, ScriptStateSource>();
  const staged = new Map<string, ScriptSnapshotState>();
  for (const source of [...sources].sort((a, b) => (a.desId ?? '').localeCompare(b.desId ?? ''))) {
    const key = source.desId;
    if (!key) throw Object.assign(new Error(`des-snapshot-unaddressable: Script: ${source.path}`), { code: 'des-snapshot-unaddressable' });
    if (scripts.has(key)) throw new Error(`duplicate script DES id '${key}'`);
    scripts.set(key, source);
    const decode = (json: unknown): ScriptSnapshotState => {
      const state = fromSnapshotData(json, { participant: key, ...SCRIPT_STATE_SCHEMA }) as ScriptSnapshotState;
      if (!state || !Number.isInteger(state.rng) || state.rng < -2147483648 || state.rng > 2147483647
        || state.fsmState !== undefined && typeof state.fsmState !== 'string'
        || Object.keys(state).some(k => !['rng', 'fsmState', 'persist', 'legacy', 'timers', 'stats'].includes(k))) throw new Error(`${key}: invalid script state`);
      validateTimers(state.timers);
      validateStats(state.stats);
      return state;
    };
    registry.register({ key, version: 1, schema: SCRIPT_STATE_SCHEMA,
      capture() {
        try {
          const state = source.adapter.captureScriptState();
          if (!state) throw new Error('script VM unavailable');
          return decode(toSnapshotData(state, { participant: key, ...SCRIPT_STATE_SCHEMA }));
        } catch (error) {
          throw Object.assign(new Error(`des-snapshot-contract: ${key}: ${String(error)}`),
            { code: 'des-snapshot-contract', participant: key, path: '$' });
        }
      },
      validate(json) { try { decode(json); return []; } catch (error) { return [String(error)]; } },
      prepare: decode,
      commit(value) { staged.set(key, value as ScriptSnapshotState); },
    });
  }
  return {
    idOf(dispatcher: unknown) {
      for (const [id, source] of scripts) if (source.adapter === dispatcher) return id;
      throw new Error('unknown script dispatcher');
    },
    dispatcher(id: string) {
      const script = scripts.get(id);
      if (!script) throw new Error(`unknown script DES id '${id}'`);
      return script.adapter;
    },
    has: (id: string) => scripts.has(id),
    apply() { for (const [id, source] of scripts) source.adapter.restoreScriptState(staged.get(id)!); },
  };
}
