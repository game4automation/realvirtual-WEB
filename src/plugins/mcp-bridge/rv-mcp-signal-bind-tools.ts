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
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { getActiveEditTarget } from '../../core/hmi/rv-edit-target';
import { collectBindingInventory, mergeAppliedMappings } from '../signal-bind/binding-inventory';
import { emitSignalBindingApplied } from '../signal-bind/binding-applied-pulse';
import { enumerateAllBindableTargets } from '../signal-bind/bindable-targets';
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

function err(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: message, ...extra });
}

export class McpSignalBindTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

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
        hint: 'Use web_signal_bindings_list for valid targetId values.',
      });
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
        hint: 'Use web_signal_bindings_list for valid componentPath + slot pairs.',
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

  @McpTool('List every bindable signal slot in the scene with its canonical identity (targetId, componentPath, slot), current external signal, liveness and comment — plus saved links that no longer resolve, with a repair candidate where one is unambiguous. Start here before binding.', { readOnly: true })
  async webSignalBindingsList(
    @McpParam('filter', 'Only rows whose target, component path or slot contains this substring (case-insensitive).', 'string', false) filter?: string,
    @McpParam('boundOnly', 'Only slots that already carry an external signal.', 'boolean', false) boundOnly?: boolean,
    @McpParam('limit', 'Maximum rows returned (default 300).', 'number', false) limit?: number,
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
      slots: matched.slice(0, max),
      // Orphans ride along rather than getting their own tool (user's shrink of
      // the surface, 2026-08-10): a model that has just listed the bindings has
      // the broken ones in the same answer and needs no second round trip.
      orphans: inventory.orphans,
    });
  }

  @McpTool('List signals available as binding sources: live realvirtual CONNECT signals from every connected interface plus internal model signals, each with direction, data type, provider and comment. Use with web_signal_bindings_list to match external names to slots.', { readOnly: true })
  async webSignalSourcesList(
    @McpParam('filter', 'Only signals whose name or comment contains this substring (case-insensitive).', 'string', false) filter?: string,
    @McpParam('limit', 'Maximum signals returned (default 300).', 'number', false) limit?: number,
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

  @McpTool('Bind an external CONNECT signal (or an internal model signal) to one component slot, identified by targetId plus componentPath plus slot. Validates type and direction exactly as a manual drag does, checks the link can be saved before changing anything, and persists it. Unbind with web_signal_unbind.', { readOnly: false })
  async webSignalBind(
    @McpParam('targetId', 'Target id from web_signal_bindings_list (node path or placement id).') targetId: string,
    @McpParam('componentPath', 'Component path of the slot — required whenever a target has the same slot name more than once.') componentPath: string,
    @McpParam('slot', 'Slot name, e.g. "Forward".') slot: string,
    @McpParam('signal', 'Signal name to bind, from web_signal_sources_list.') signal: string,
  ): Promise<string> {
    const viewer = this.viewer;
    const manager = viewer?.signalBindingManager;
    const store = viewer?.signalStore;
    if (!viewer || !manager || !store) return err('No signal binding manager available');

    const resolved = this._resolveSlot(targetId, componentPath || undefined, slot);
    if (typeof resolved === 'string') return resolved;

    if (store.get(signal) === undefined) {
      return err(`Signal "${signal}" not found`, {
        hint: 'Use web_signal_sources_list for bindable signal names.',
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
    const next = upsertMappingForRow(persistence.read(), resolved.slot, source);
    if (!next) return err('The signal carries no provider identity — it cannot be linked');

    const applied = manager.applyMappings(
      signalBindTargetId(resolved.entry.target),
      resolved.entry.node as Parameters<typeof manager.applyMappings>[1],
      next,
    );
    const bound = applied.some((m) =>
      m.slot === resolved.slot.slot && m.componentPath === resolved.slot.componentPath);
    if (!bound) return err('The slot refused the binding at apply time', { persisted: false });
    // Broken links on the same target survive an unrelated bind — see
    // mergeAppliedMappings. Persisting `applied` alone would delete them.
    persistence.write(mergeAppliedMappings(next, applied));
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
    const saved = persistence.read().some((m) =>
      m.slot === resolved.slot.slot
      && m.componentPath === resolved.slot.componentPath
      && m.signal === signal);
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
    });
  }

  @McpTool('Remove the external signal from one component slot, identified by targetId plus componentPath plus slot. Checks the change can be saved before making it. The slot returns to local simulation.', { readOnly: false })
  async webSignalUnbind(
    @McpParam('targetId', 'Target id from web_signal_bindings_list (node path or placement id).') targetId: string,
    @McpParam('componentPath', 'Component path of the slot — required whenever a target has the same slot name more than once.') componentPath: string,
    @McpParam('slot', 'Slot name, e.g. "Forward".') slot: string,
  ): Promise<string> {
    const viewer = this.viewer;
    const manager = viewer?.signalBindingManager;
    if (!viewer || !manager) return err('No signal binding manager available');

    const resolved = this._resolveSlot(targetId, componentPath || undefined, slot);
    if (typeof resolved === 'string') return resolved;

    const blocked = this._persistenceBlocked(resolved.entry.target);
    if (blocked) return err(blocked, { persisted: false });

    const persistence = createSignalBindingPersistence(viewer, resolved.entry.target);
    const before = persistence.read();
    const next = removeMappingForRow(before, resolved.slot);
    if (next.length === before.length) {
      return err(`Slot "${slot}" carries no binding`, { persisted: false });
    }
    const applied = manager.applyMappings(
      signalBindTargetId(resolved.entry.target),
      resolved.entry.node as Parameters<typeof manager.applyMappings>[1],
      next,
    );
    persistence.write(mergeAppliedMappings(next, applied));
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
