// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-signal-bind-tools — the tool surface a language model needs to wire an
 * external PLC to a shared model (plan-425 F5/F6).
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * rv-mcp-tools.ts).
 *
 * ## Why four tools and not a wizard
 *
 * Matching "MC04_01_Motor_Run" to a slot called `Forward` on a component called
 * `Conveyor_03` is a language problem, and the user's decision (2026-08-10) was
 * to give the language model the primitives rather than build a heuristic
 * auto-mapper in the UI: list the targets, list the sources, bind, unbind. The
 * human oversight is the bindings overview and a one-click unbind, not a
 * confirmation prompt on every link — binding a hundred signals one dialog at a
 * time is the workflow this exists to remove.
 *
 * ## Two things these tools refuse to do
 *
 * **Address a slot by target and slot name alone.** A Planner placement
 * aggregates its whole subtree, so one target can carry `Forward` on several
 * components. `targetId + slot` would then be a coin flip over which mapping to
 * replace. Every contract here takes `componentPath` as well, and a mutation
 * that cannot resolve to exactly one slot is refused rather than guessed
 * (review round 1, finding 3).
 *
 * **Report a success the next reload will contradict.** Node persistence is a
 * silent no-op without an active edit target, and placement persistence needs
 * the planner. Both are checked BEFORE the runtime mutation, so a tool that
 * cannot make the change stick fails without making it at all (review round 1,
 * finding 4).
 *
 * ## The write gate
 *
 * `bind` and `unbind` are declared `readOnly: false`, which is the whole of what
 * this file has to do about authorisation: CONNECT refuses to dispatch any
 * `web_*` tool that is not announced read-only while its write switch is off
 * (McpServerSetup.CallToolAsync). The C# side owns that fence and
 * `McpWriteGateTests` pins it.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { valueOrThrowToolJson } from '../../core/hmi/rv-command-context';
import {
  commandRegistry,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';

/** Command ids of the slot binding writes (aliases `web_signal_bind` / `web_signal_unbind`, plan-641 Nachtrag). */
export const SIGNAL_BIND_COMMAND = 'signal.bind';
export const SIGNAL_UNBIND_COMMAND = 'signal.unbind';
import { getActiveEditTarget } from '../../core/hmi/rv-edit-target';
import { collectBindingInventory, mergeAppliedMappings } from '../signal-bind/binding-inventory';
import { emitSignalBindingApplied } from '../signal-bind/binding-applied-pulse';
import { enumerateAllBindableTargets } from '../signal-bind/bindable-targets';
import { bindWithUnitScale, describeUnitStatus } from '../signal-bind/unit-scale';
import { enqueueBind, holdsBindQueue, runInBindQueue, writeQueued } from '../../core/hmi/rv-bind-queue';
import { createSignalBindingPersistence } from '../signal-bind/signal-binding-persistence';
import { signalBindTargetId, type SignalBindTarget } from '../signal-bind/signal-bind-target';
import {
  removeMappingForRow,
  upsertMappingForRow,
  collectInternalSignals,
} from '../signal-bind/slot-row-models';
import { slotRejectReason, dropRejectText, plcKindOf } from '../signal-bind/drop-accept';
import type { PickerSignal } from '../../core/hmi/rv-signal-slot-row';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import { componentAddressOf } from '../../core/engine/rv-signal-mapping-address';
import { relativeComponentPath } from '../../core/engine/rv-binding-slot-resolver';

/** A located slot, plus the target and persistence it belongs to. */
interface ResolvedSlot {
  entry: { id: string; target: SignalBindTarget; node: object };
  slot: {
    slot: string;
    componentPath: string;
    componentType?: string;
    kind: 'mapped-signal' | 'direct-property' | 'direct-feedback';
    type: 'bool' | 'float' | 'int';
    direction: 'plcOutput' | 'plcInput';
    targetName?: string;
    reason?: string;
  };
}

/** plan-769 F15: each listed slot row gains the `componentAddress` of its component node. */
function withComponentAddresses<T extends { targetId: string; componentPath: string }>(viewer: RVViewer, rows: T[]): Array<T & { componentAddress?: string }> {
  const registry = viewer.registry;
  if (!registry) return rows;
  const roots = new Map(enumerateAllBindableTargets(viewer).map((t) => [t.id, t.node as import('three').Object3D]));
  return rows.map((row) => {
    const root = roots.get(row.targetId);
    if (!root) return row;
    const path = row.componentPath;
    const rootPath = registry.getPathForNode(root);
    const node = path === '.' || path === '' ? root : registry.getNode(rootPath ? `${rootPath}/${path}` : path);
    const componentAddress = node ? componentAddressOf(registry, root, node) : null;
    return componentAddress ? { ...row, componentAddress } : row;
  });
}

function err(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: message, ...extra });
}

/** An `err()` JSON of one batch entry, with its index. */
function withIndex(json: string, index: number): string {
  return JSON.stringify({ ...JSON.parse(json), index });
}

/** One entry of the batch form of `signal.bind`; `signal: null` clears the slot. */
export interface BatchEntry {
  readonly targetId: string;
  readonly componentPath: string;
  readonly slot: string;
  readonly signal: string | null;
}

export class McpSignalBindTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {
    // plan-641 Nachtrag: the bound bind / unbind tools need their commands before discover.
    ensureSignalBindCommandsRegistered();
  }

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  /**
   * Locate exactly one slot, or explain why not.
   *
   * The fail-closed half of the canonical slot identity: an omitted or
   * non-unique `componentPath` is an error, never a "best match".
   */
  private _resolveSlot(
    targetRef: string,
    componentPath: string | undefined,
    slotName: string,
  ): ResolvedSlot | string {
    const viewer = this.viewer;
    const manager = viewer?.signalBindingManager;
    if (!viewer || !manager) return err('No signal binding manager available');

    const targets = enumerateAllBindableTargets(viewer);
    const entry = targets.find((t) => t.id === targetRef)
      ?? targets.find((t) => (t.target.label ?? t.node.name) === targetRef);
    if (!entry) {
      return err(`Target "${targetRef}" not found`, {
        hint: 'Use web_query("signal.bindingsList", {}) for valid targetId values.',
      });
    }

    // plan-769 F15 (9.18): the component may be named by its PATH (what the list prints)
    // or by its ADDRESS (`componentAddress` of the list, what a file stores).
    if (componentPath !== undefined && componentPath.includes('#') && viewer.registry) {
      const bindRoot = entry.node as import('three').Object3D;
      const node = viewer.registry.resolveAddressIn(bindRoot, componentPath);
      if (node) componentPath = relativeComponentPath(bindRoot, node, viewer.registry);
    }
    const slots = manager.getElementSlots(entry.id, entry.node)
      .filter((s) => s.slot === slotName);
    const usable = slots.filter((s) => s.kind !== 'unavailable');
    const matches = componentPath !== undefined
      ? usable.filter((s) => s.componentPath === componentPath)
      : usable;

    if (matches.length === 0) {
      const unavailable = slots.find((s) => s.kind === 'unavailable');
      if (unavailable && componentPath === undefined) {
        return err(`Slot "${slotName}" is not available on this target`, {
          reason: unavailable.reason,
        });
      }
      return err(`Slot "${slotName}" not found on target "${entry.id}"`, {
        componentPath,
        hint: 'Use web_query("signal.bindingsList", {}) for valid componentPath + slot pairs.',
      });
    }
    if (matches.length > 1) {
      // The aggregation case. Naming one of them would be a guess about which
      // machine the model meant.
      return err(`Slot "${slotName}" is ambiguous on target "${entry.id}"`, {
        candidates: matches.map((s) => s.componentPath),
        hint: 'Pass componentPath to identify exactly one slot.',
      });
    }
    const slot = matches[0];
    return {
      entry,
      slot: {
        slot: slot.slot,
        componentPath: slot.componentPath,
        ...(slot.componentType !== undefined ? { componentType: slot.componentType } : {}),
        kind: slot.kind,
        type: slot.type,
        direction: slot.direction,
        ...(slot.kind === 'mapped-signal' ? { targetName: slot.targetName } : {}),
      },
    };
  }

  /**
   * Can a change to this target be KEPT? Checked before anything is touched.
   *
   * Without this a bind reports success, the user reloads, and the link is gone
   * — with the model having been told the opposite.
   */
  private _persistenceBlocked(target: SignalBindTarget): string | null {
    if (target.kind === 'placed') {
      return this.viewer?.getPlugin('layout-planner')
        ? null
        : 'The layout planner is not active, so a placement binding cannot be saved.';
    }
    return getActiveEditTarget().available
      ? null
      : 'No active edit target, so a node binding cannot be saved.';
  }

  /** Read-only command body (plan-2007). */
  async querySignalBindingsList(
    filter?: string,
    boundOnly?: boolean,
    limit?: number,
  ): Promise<string> {
    const viewer = this.viewer;
    if (!viewer) return err('No viewer available');
    const inventory = collectBindingInventory(viewer);
    const q = (filter ?? '').toLowerCase();
    const max = limit && limit > 0 ? limit : 300;
    const matched = inventory.rows.filter((row) => {
      if (boundOnly && !row.signal) return false;
      if (!q) return true;
      return `${row.targetId} ${row.targetLabel} ${row.componentPath} ${row.slot}`
        .toLowerCase().includes(q);
    });
    return JSON.stringify({
      total: inventory.rows.length,
      matched: matched.length,
      returned: Math.min(matched.length, max),
      truncated: matched.length > max,
      // plan-769 F15: the path as before, plus the address a saved file stores for it.
      slots: withComponentAddresses(viewer, matched.slice(0, max)),
      // Orphans ride along rather than getting their own tool (user's shrink of
      // the surface, 2026-08-10): a model that has just listed the bindings has
      // the broken ones in the same answer and needs no second round trip.
      orphans: inventory.orphans,
    });
  }

  /** Read-only command body (plan-2007). */
  async querySignalSourcesList(
    filter?: string,
    limit?: number,
  ): Promise<string> {
    const store = this.viewer?.signalStore;
    if (!store) return err('No signal store available');
    const q = (filter ?? '').toLowerCase();
    const max = limit && limit > 0 ? limit : 300;

    const sources: PickerSignal[] = [];
    for (const name of store.getAll().keys()) {
      const providers = store.getSignalProviders(name);
      if (providers.length === 0) continue;   // internal signals come below
      const type = store.getType(name) ?? '';
      const meta = store.getSignalMeta(name);
      sources.push({
        name,
        direction: type.startsWith('PLCOutput') ? 'output'
          : type.startsWith('PLCInput') ? 'input' : 'unknown',
        dataType: type || undefined,
        interfaceId: providers[0].interfaceId,
        topic: providers[0].topic,
        address: meta?.address,
        comment: meta?.comment,
        origin: 'connect',
        // More than one interface offering the same name is not bindable until
        // the ambiguity is resolved — the model must not pick a provider.
        conflict: providers.length > 1,
      });
    }
    sources.push(...collectInternalSignals(store));

    const matched = q
      ? sources.filter((s) => `${s.name} ${s.comment ?? ''}`.toLowerCase().includes(q))
      : sources;
    return JSON.stringify({
      total: sources.length,
      matched: matched.length,
      returned: Math.min(matched.length, max),
      truncated: matched.length > max,
      signals: matched.slice(0, max),
    });
  }

  /** The bind itself — the body of `signal.bind`. JSON, `{error}` on refusal. */
  async bindSlot(targetId: string, componentPath: string, slot: string, signal: string): Promise<string> {
    const viewer = this.viewer;
    const manager = viewer?.signalBindingManager;
    const store = viewer?.signalStore;
    if (!viewer || !manager || !store) return err('No signal binding manager available');

    const resolved = this._resolveSlot(targetId, componentPath || undefined, slot);
    if (typeof resolved === 'string') return resolved;

    if (store.get(signal) === undefined) {
      return err(`Signal "${signal}" not found`, {
        hint: 'Use web_query("signal.sourcesList", {}) for bindable signal names.',
      });
    }
    const providers = store.getSignalProviders(signal);
    if (providers.length > 1) {
      return err(`Signal "${signal}" is offered by more than one interface`, {
        interfaces: providers.map((p) => p.interfaceId),
      });
    }
    const type = store.getType(signal) ?? '';
    const source: PickerSignal = {
      name: signal,
      direction: type.startsWith('PLCOutput') ? 'output'
        : type.startsWith('PLCInput') ? 'input' : 'unknown',
      dataType: type || undefined,
      ...(providers[0] ? { interfaceId: providers[0].interfaceId, topic: providers[0].topic } : {}),
      origin: providers.length === 1 ? 'connect' : 'internal',
    };

    // The SAME rule the drag-and-drop overlay applies, reported in the SAME
    // words. A model told "type mismatch" and a user shown "type mismatch"
    // should be looking at one decision, not two implementations of it.
    const reject = slotRejectReason(
      { type: resolved.slot.type, direction: resolved.slot.direction },
      {
        plcType: type,
        direction: source.direction,
        origin: source.origin,
        interfaceId: source.interfaceId,
      },
    );
    if (reject) return err(dropRejectText(reject), { reason: reject.kind });

    const blocked = this._persistenceBlocked(resolved.entry.target);
    if (blocked) return err(blocked, { persisted: false });

    const persistence = createSignalBindingPersistence(viewer, resolved.entry.target);
    if (!upsertMappingForRow(persistence.read(), resolved.slot, source)) {
      return err('The signal carries no provider identity — it cannot be linked');
    }

    // plan-512: the SAME unit-aware bind as the inspector — mapping and unit
    // factor in one undo step, queued behind any bind already running on this
    // document, verified from the resulting state (broken links on the same
    // target survive, as before: the helper merges them).
    const result = await bindWithUnitScale(viewer, resolved.entry.target, persistence, resolved.slot, source);
    if (!result) return err('The signal carries no provider identity — it cannot be linked');
    const bound = manager.getBindingLiveness(
      resolved.entry.id, resolved.slot.slot, resolved.slot.componentPath) !== undefined;
    if (!result.persisted || !bound) {
      return err('The slot refused the binding', {
        persisted: false,
        ...(result.error ? { reason: result.error } : {}),
      });
    }
    // The agent-initiated half of the F8 boundary. A watching operator sees the
    // same pulse they would have seen had they dropped the signal themselves —
    // which is the only feedback a bind made from outside the browser gives.
    emitSignalBindingApplied(viewer, resolved.entry.id, {
      componentPath: resolved.slot.componentPath,
      slot: resolved.slot.slot,
      signal,
      sourceKind: source.origin === 'internal' ? 'internal' : 'connect',
    });

    // Confirm from the persisted state, not from the intent: the whole point of
    // the pre-check is that "I wrote it" and "it is there" are different claims.
    const savedMapping = persistence.read().find((m) =>
      m.slot === resolved.slot.slot
      && m.componentPath === resolved.slot.componentPath
      && m.signal === signal);
    const saved = !!savedMapping;
    const unitStatus = result.status;
    return JSON.stringify({
      targetId: resolved.entry.id,
      componentPath: resolved.slot.componentPath,
      slot: resolved.slot.slot,
      kind: resolved.slot.kind,
      signal,
      sourceKind: source.origin,
      dataType: plcKindOf(type),
      liveness: manager.getBindingLiveness(
        resolved.entry.id, resolved.slot.slot, resolved.slot.componentPath),
      persisted: saved,
      // plan-512: what the unit logic did — the written factor's provenance
      // (absent when nothing was written) and the evaluated state of the slot.
      ...(savedMapping?.unitScale ? { unitScale: savedMapping.unitScale } : {}),
      unitStatus: unitStatus.kind,
      ...(unitStatus.kind !== 'none' ? { unitDetail: describeUnitStatus(unitStatus, signal) } : {}),
    });
  }

  /**
   * The batch form of `signal.bind` (plan-2233 F6): `signal: null` clears the slot.
   *
   * Every entry is resolved and checked first (slot, signal, type, direction,
   * persistence) — a refused entry touches nothing. Then the whole batch runs as
   * ONE entry of the document's bind queue (a picker or MCP bind of another
   * caller waits behind it, never between two of its binds) inside ONE document
   * transaction: one undo step, and a bind that does not stick rolls the whole
   * batch back. Each bind is the picker's own `bindWithUnitScale`, so the stored
   * `SignalLinks.Mappings` are byte-identical to binding the slots one by one.
   */
  async bindBatch(entries: readonly BatchEntry[], label = 'Bind signals', queueHold?: object): Promise<string> {
    const viewer = this.viewer;
    const manager = viewer?.signalBindingManager;
    const store = viewer?.signalStore;
    if (!viewer || !manager || !store) return err('No signal binding manager available');
    const planned: Array<{ resolved: ResolvedSlot; source: PickerSignal | null }> = [];
    for (const [i, entry] of entries.entries()) {
      const resolved = this._resolveSlot(entry.targetId, entry.componentPath || undefined, entry.slot);
      if (typeof resolved === 'string') return withIndex(resolved, i);
      if (resolved.entry.target.kind !== 'node') return err('A batch binds node targets only', { index: i });
      const blocked = this._persistenceBlocked(resolved.entry.target);
      if (blocked) return err(blocked, { persisted: false, index: i });
      if (entry.signal === null) {
        planned.push({ resolved, source: null });
        continue;
      }
      const source = this._sourceFor(entry.signal);
      if (typeof source === 'string') return withIndex(source, i);
      const reject = slotRejectReason(
        { type: resolved.slot.type, direction: resolved.slot.direction },
        { plcType: source.dataType ?? '', direction: source.direction, origin: source.origin, interfaceId: source.interfaceId },
      );
      if (reject) return err(dropRejectText(reject), { reason: reject.kind, index: i });
      if (!upsertMappingForRow([], resolved.slot, source)) {
        return err('The signal carries no provider identity — it cannot be linked', { index: i });
      }
      planned.push({ resolved, source });
    }
    const et = getActiveEditTarget();
    let failedAt = -1;
    let reason: string | undefined;
    try {
      // A caller that already holds this document's queue (a composite edit, e.g. a wall
      // template) passes its hold object: the batch then runs inside that one entry.
      const run = (hold: object) => et.withTransaction(label, async () => {
        for (const [i, p] of planned.entries()) {
          failedAt = i;
          const target = p.resolved.entry.target;
          const persistence = createSignalBindingPersistence(viewer, target);
          if (!p.source) {
            const before = persistence.read();
            const next = removeMappingForRow(before, p.resolved.slot);
            if (next.length === before.length) continue;
            const merged = mergeAppliedMappings(next, manager.previewMappings(p.resolved.entry.id, target.node, next));
            if (persistence.writeAsync) await persistence.writeAsync(merged);
            else persistence.write(merged);
            continue;
          }
          const result = await bindWithUnitScale(viewer, target, persistence, p.resolved.slot, p.source,
            { editTarget: et, queueHold: hold });
          const bound = manager.getBindingLiveness(
            p.resolved.entry.id, p.resolved.slot.slot, p.resolved.slot.componentPath) !== undefined;
          if (!result?.persisted || !bound) {
            throw new Error(result?.error ?? `slot "${p.resolved.slot.slot}" refused the binding`);
          }
        }
        failedAt = -1;
      });
      await (holdsBindQueue(et, queueHold) ? run(queueHold!) : runInBindQueue(et, run));
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (reason !== undefined) {
      return err(`The batch was rolled back: ${reason}`, { persisted: false, index: failedAt, reason });
    }
    for (const p of planned) {
      if (!p.source) continue;
      emitSignalBindingApplied(viewer, p.resolved.entry.id, {
        componentPath: p.resolved.slot.componentPath, slot: p.resolved.slot.slot, signal: p.source.name,
        sourceKind: p.source.origin === 'internal' ? 'internal' : 'connect',
      });
    }
    return JSON.stringify({
      persisted: true,
      bound: planned.filter((p) => p.source)
        .map((p) => ({ targetId: p.resolved.entry.id, slot: p.resolved.slot.slot, signal: p.source!.name })),
      cleared: planned.filter((p) => !p.source).map((p) => ({ targetId: p.resolved.entry.id, slot: p.resolved.slot.slot })),
    });
  }

  /** The picker source of one signal name: exact lookup, exactly one provider. */
  private _sourceFor(signal: string): PickerSignal | string {
    const store = this.viewer!.signalStore!;
    if (store.get(signal) === undefined) {
      return err(`Signal "${signal}" not found`, {
        hint: 'Use web_query("signal.sourcesList", {}) for bindable signal names.',
      });
    }
    const providers = store.getSignalProviders(signal);
    if (providers.length > 1) {
      return err(`Signal "${signal}" is offered by more than one interface`, {
        interfaces: providers.map((p) => p.interfaceId),
      });
    }
    const type = store.getType(signal) ?? '';
    return {
      name: signal,
      direction: type.startsWith('PLCOutput') ? 'output'
        : type.startsWith('PLCInput') ? 'input' : 'unknown',
      dataType: type || undefined,
      ...(providers[0] ? { interfaceId: providers[0].interfaceId, topic: providers[0].topic } : {}),
      origin: providers.length === 1 ? 'connect' : 'internal',
    };
  }

  /** The unbind itself — the body of `signal.unbind`. JSON, `{error}` on refusal. */
  async unbindSlot(targetId: string, componentPath: string, slot: string): Promise<string> {
    const viewer = this.viewer;
    const manager = viewer?.signalBindingManager;
    if (!viewer || !manager) return err('No signal binding manager available');

    const resolved = this._resolveSlot(targetId, componentPath || undefined, slot);
    if (typeof resolved === 'string') return resolved;

    const blocked = this._persistenceBlocked(resolved.entry.target);
    if (blocked) return err(blocked, { persisted: false });

    const persistence = createSignalBindingPersistence(viewer, resolved.entry.target);
    // plan-2233: queued like every bind — never inside another edit's open transaction.
    const out: { applied?: ReturnType<typeof manager.applyMappings> } = {};
    const et = getActiveEditTarget();
    await enqueueBind(et, async () => {
      const before = persistence.read();
      const next = removeMappingForRow(before, resolved.slot);
      if (next.length === before.length) return;
      const applied = out.applied = manager.applyMappings(
        signalBindTargetId(resolved.entry.target),
        resolved.entry.node as Parameters<typeof manager.applyMappings>[1],
        next,
      );
      // Awaited: the op must have landed before the queue lets the next edit open its transaction.
      await writeQueued(persistence, et, mergeAppliedMappings(next, applied));
    });
    const applied = out.applied;
    if (!applied) {
      return err(`Slot "${slot}" carries no binding`, { persisted: false });
    }
    return JSON.stringify({
      targetId: resolved.entry.id,
      componentPath: resolved.slot.componentPath,
      slot: resolved.slot.slot,
      unbound: true,
      remaining: applied.length,
      persisted: !persistence.read().some((m) =>
        m.slot === resolved.slot.slot && m.componentPath === resolved.slot.componentPath),
    });
  }
}

// ─── plan-641 Nachtrag 2026-10-21: `signal.bind` / `signal.unbind` ───────

interface SlotArgs {
  readonly targetId: string;
  readonly componentPath: string;
  readonly slot: string;
}
interface BindArgs extends SlotArgs {
  readonly signal: string;
  /** Batch form (plan-2233): many slots in one queue entry and one undo step. */
  readonly bindings?: readonly BatchEntry[];
  readonly label?: string;
  /** Internal: the hold OBJECT of a queue the caller holds (core/hmi/rv-bind-queue); a JSON value
   *  can never match it (identity), and it is never recorded. */
  readonly _queueHold?: object;
}

const trimmed = (v: unknown): string => String(v ?? '').trim();
const slotRefusal = (a: SlotArgs | undefined): string | null =>
  !trimmed(a?.targetId) ? 'targetId is required' : !trimmed(a?.slot) ? 'slot is required' : null;

const batchOf = (a: BindArgs | undefined): BatchEntry[] | null => (Array.isArray(a?.bindings)
  ? a!.bindings.map((b) => ({
    targetId: trimmed(b?.targetId), componentPath: String(b?.componentPath ?? ''), slot: trimmed(b?.slot),
    signal: b?.signal === null ? null : trimmed(b?.signal),
  }))
  : null);

const signalBind: CommandImpl<BindArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => {
    const batch = batchOf(a);
    const r = batch
      ? (batch.length === 0 ? 'bindings is empty'
        : batch.map((b) => slotRefusal(b) ?? (b.signal === '' ? 'signal is required' : null)).find((x) => x) ?? null)
      : slotRefusal(a) ?? (!trimmed(a?.signal) ? 'signal is required' : null);
    return r ? { reason: r } : true;
  },
  run: async (ctx, a) => {
    const tools = new McpSignalBindTools(() => ctx.viewer);
    const batch = batchOf(a);
    return valueOrThrowToolJson(batch
      ? await tools.bindBatch(batch, a.label || undefined, a._queueHold)
      : await tools.bindSlot(a.targetId, a.componentPath, a.slot, a.signal));
  },
  // M4: explicit, trimmed values — the slot is addressed by args only, never by selection.
  resolveArgs: (_ctx, a) => {
    const batch = batchOf(a);
    if (batch) return { bindings: batch, ...(a.label ? { label: a.label } : {}) } as unknown as BindArgs;
    return {
      targetId: trimmed(a?.targetId), componentPath: String(a?.componentPath ?? ''), slot: trimmed(a?.slot), signal: trimmed(a?.signal),
    };
  },
};

const signalUnbind: CommandImpl<SlotArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => {
    const r = slotRefusal(a);
    return r ? { reason: r } : true;
  },
  run: async (ctx, a) => valueOrThrowToolJson(
    await new McpSignalBindTools(() => ctx.viewer).unbindSlot(a.targetId, a.componentPath, a.slot),
  ),
  resolveArgs: (_ctx, a) => ({ targetId: trimmed(a?.targetId), componentPath: String(a?.componentPath ?? ''), slot: trimmed(a?.slot) }),
};

const slotParams = [
  { name: 'targetId', type: 'string', required: true },
  { name: 'componentPath', type: 'string', required: true },
  { name: 'slot', type: 'string', required: true },
];

/** Build the two binding commands (testable seam: no registry side effect). */
export function createSignalBindCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  const bind: CommandDescriptor<BindArgs, Record<string, unknown>> = {
    id: SIGNAL_BIND_COMMAND,
    // Batch form (plan-2233): `{ bindings: [{ targetId, componentPath, slot, signal | null }], label? }`.
    label: 'Bind signal',
    undoLabel: 'Bind signal',
    readOnly: false,
    macro: true,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    mcp: { tool: 'web_signal_bind', params: [...slotParams, { name: 'signal', type: 'string', required: true }] },
    argsSchema: {
      targetId: 'string', componentPath: 'string', slot: 'string', signal: 'string', bindings: 'object[]', label: 'string',
    },
    eagerImpl: signalBind,
    impl: () => Promise.resolve(signalBind),
  };
  const unbind: CommandDescriptor<SlotArgs, Record<string, unknown>> = {
    id: SIGNAL_UNBIND_COMMAND,
    label: 'Unbind signal',
    undoLabel: 'Unbind signal',
    readOnly: false,
    macro: true,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    mcp: { tool: 'web_signal_unbind', params: slotParams },
    argsSchema: { targetId: 'string', componentPath: 'string', slot: 'string' },
    eagerImpl: signalUnbind,
    impl: () => Promise.resolve(signalUnbind),
  };
  return [bind, unbind,
    {
      id: 'signal.bindingsList', label: 'signal.bindingsList', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { filter: 'string', boundOnly: 'boolean', limit: 'number' },
      impl: async () => {
        const impl: CommandImpl<{ filter?: string; boundOnly?: boolean; limit?: number }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpSignalBindTools(() => ctx.viewer).querySignalBindingsList(a?.filter, a?.boundOnly, a?.limit)),
        };
        return impl;
      },
    },
    {
      id: 'signal.sourcesList', label: 'signal.sourcesList', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { filter: 'string', limit: 'number' },
      impl: async () => {
        const impl: CommandImpl<{ filter?: string; limit?: number }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpSignalBindTools(() => ctx.viewer).querySignalSourcesList(a?.filter, a?.limit)),
        };
        return impl;
      },
    },
    {
      id: 'signal.reconcile', label: 'signal.reconcile', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { interfaceId: 'string' },
      impl: async () => {
        const { querySignalReconcile } = await import('./rv-mcp-signal-automap-tools');
        const impl: CommandImpl<{ interfaceId?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await querySignalReconcile(ctx.viewer, a?.interfaceId)),
        };
        return impl;
      },
    },
    {
      id: 'signal.usage', label: 'signal.usage', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { name: 'string' },
      impl: async () => {
        const { querySignalUsage } = await import('./rv-mcp-signal-usage-tools');
        const impl: CommandImpl<{ name?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await querySignalUsage(ctx.viewer, a?.name ?? '')),
        };
        return impl;
      },
    },
  ] as unknown as CommandDescriptor<never, unknown>[];
}

const registeredSignalBind = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the binding commands. */
export function ensureSignalBindCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registeredSignalBind.has(registry)) return;
  registeredSignalBind.add(registry);
  for (const d of createSignalBindCommandDescriptors()) registry.register(d);
}
