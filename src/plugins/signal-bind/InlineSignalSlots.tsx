// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * InlineSignalSlots — the inline signal-slot rows of the Property Inspector
 * (plan-325 Phase 3).
 *
 * `ComponentSignalSlots` renders EVERY `componentRef + signal` schema field of
 * a component section as a {@link SignalSlotRow} — also when the GLB carries no
 * value (synthetic "not linked" rows, F1). It is the ONLY render path for
 * signal slots: `rv-component-section.tsx` removes these keys from the generic
 * FieldRow pipeline (rendering-precedence contract, S3/S4). Binding runs
 * exclusively through SignalBindingManager + persistence — these rows never
 * call onFieldEdit/onFieldReset.
 *
 * `BehaviorSignalSlots` renders the synthetic behavior slots (Conveyor
 * `Flow.*`, F10) inside the virtual behavior section: always VISIBLE from the
 * descriptor, bindable only once the scoped signal is materialised in the
 * SignalStore.
 *
 * `PLCSignalSlot` renders the ONE synthetic slot of a raw `PLCInput*` /
 * `PLCOutput*` node (plan-418 F6): the node IS the signal, so its component
 * section gets a single `Value` row — the inspector-side twin of the badge and
 * the tree context menu, and the only surface that also SHOWS why a node is
 * not bindable (duplicate name, unregistered signal).
 *
 * No-manager state (A1): with `signalBindingManager === null` the rows render
 * the GLB wiring read-only — no link icon, no picker, no drop target.
 */

import { useCallback, useMemo, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Typography } from '@mui/material';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { getSignalSlotFields } from '../../core/engine/rv-component-registry';
import { PLC_SIGNAL_SLOT } from '../../core/engine/rv-binding-slot-resolver';
import { SIGNAL_TYPES } from '../../core/engine/rv-signal-construction';
import { instanceScope, scopeSignalName } from '../../core/engine/rv-instance-scope';
import {
  computeRowQualifiers,
  SignalSlotRow,
  slotRowKey,
  synthPlcType,
  type PickerSignal,
  type SlotRow,
} from '../../core/hmi/rv-signal-slot-row';
import { SignalSearchOverlay, type SignalSearchItem } from '../../core/hmi/SignalSearchOverlay';
import { baseComponentType, isComponentRef } from '../../core/hmi/rv-inspector-helpers';
import { getConnectSnapshot, subscribeConnectStore } from '../../core/hmi/connect-store';
import { omitUndefined } from '../../core/hmi/rv-omit-undefined';
import { collectConnectSignals } from './SignalBindPopover';
import { slotRejectReason, type DropRejectReason } from './drop-accept';
import {
  buildSlotRowModels,
  collectInternalSignals,
  removeMappingForRow,
  upsertMappingForRow,
} from './slot-row-models';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import { emitSignalBindingApplied } from './binding-applied-pulse';
import {
  findSignalBindTarget,
  signalBindEligibility,
  signalBindTargetId,
  type SignalBindTarget,
} from './signal-bind-target';
import { SLOT_DESCRIPTORS } from './slot-descriptors';
import { slotLabelOverride } from './slot-display-label';

const INK_LOW = 'rgba(255,255,255,0.5)';

function signalPrimitiveOf(signal: string): 'bool' | 'float' | 'int' {
  if (signal.includes('Bool')) return 'bool';
  if (signal.includes('Int')) return 'int';
  return 'float';
}

/** Root-relative component path of `nodePath` under the bind-target root. */
function relativePathUnder(rootPath: string, nodePath: string): string {
  if (nodePath === rootPath) return '.';
  if (rootPath && nodePath.startsWith(`${rootPath}/`)) return nodePath.slice(rootPath.length + 1);
  return nodePath || '.';
}

/**
 * The path the RESOLVER would use for this node (plan-422 F3).
 *
 * `relativePathUnder` is string arithmetic, and it is only sound when both
 * sides are spelled the same way. The bind-target root always is — it comes
 * from `registry.getPathForNode()`. The inspector's `nodePath` does not: a node
 * is reachable under several registry keys (`doc-node-paths.md`: sanitisation
 * layers, file-global dedup, aliases), and `selectNode()` stores whatever
 * string its caller had — a viewport pick, a hierarchy click, a deep link, an
 * MCP call, or a value restored from `localStorage` that an older build wrote.
 *
 * When that string is an ALIAS the subtraction fails silently: the relative
 * path comes out as the whole alias instead of `.`, no row matches the slot's
 * `componentPath`, and the inspector falls through to "not offered as a link
 * target" — on a node whose slot resolved perfectly well. That is the
 * `RobotAtConveyorPick` report, and it applies to every signal node reached by
 * a non-canonical path.
 *
 * Resolving through the registry first puts both sides in the resolver's own
 * spelling, which is what `relativeComponentPath()` does on the other side of
 * the comparison. Unknown paths are returned untouched — a path the registry
 * cannot resolve has no canonical form to offer.
 */
function canonicalNodePath(viewer: RVViewer | null, nodePath: string): string {
  const registry = viewer?.registry;
  const node = registry?.getNode(nodePath);
  if (!registry || !node) return nodePath;
  return registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node) ?? nodePath;
}

// ── Shared interactive block (rows + picker + persistence) ───────────────────

function BindableSlotRows({ viewer, target, buildRows, disabledReason }: {
  viewer: RVViewer;
  target: SignalBindTarget;
  /** Build the display rows from the CURRENT mappings — invoked after the
   *  persistence subscription so rows never go stale on bind/unbind. */
  buildRows: (mappings: readonly import('../layout-planner/rv-layout-store').SignalMapping[]) => SlotRow[];
  disabledReason?: string;
}) {
  const mgr = viewer.signalBindingManager;
  const persistence = useMemo(() => createSignalBindingPersistence(viewer, target), [viewer, target]);
  const subscribeMappings = useCallback(
    (listener: () => void) => persistence.subscribe(listener),
    [persistence],
  );
  const mappingSnapshot = useCallback(() => JSON.stringify(persistence.read()), [persistence]);
  useSyncExternalStore(subscribeMappings, mappingSnapshot);
  const connectSnap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);

  const rows = buildRows(persistence.read());
  // Rebuilt with `rows` on every render (both are cheap, ≤ a few dozen rows).
  const qualifiers = computeRowQualifiers(rows);

  const [picker, setPicker] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const pickerRow = picker ? rows.find((r) => slotRowKey(r) === picker.key) ?? null : null;

  const signals = useMemo<PickerSignal[]>(() => [
    ...collectConnectSignals(connectSnap.interfaces),
    ...(viewer.signalStore ? collectInternalSignals(viewer.signalStore) : []),
  ], [connectSnap, viewer.signalStore]);

  const searchItems = useMemo<SignalSearchItem[]>(() => signals
    .filter((s) => !pickerRow
      // Self-binding exclusion: the slot's own target signal is never a source.
      || s.origin !== 'internal'
      || s.name !== pickerRow.targetName)
    .map((s) => ({
      name: s.name,
      direction: s.direction,
      plcType: s.dataType && s.dataType.startsWith('PLC') ? s.dataType : synthPlcType(s.direction, s.dataType),
      address: s.address,
      comment: s.comment,
      interfaceId: s.interfaceId,
      topic: s.topic,
      conflict: s.conflict,
      origin: s.origin,
    })), [signals, pickerRow]);

  // Same rule for click, Enter and drag (plan-341 §2.8 a) — see SignalBindPopover.
  const pickerRejectReason = (item: SignalSearchItem): DropRejectReason | null => {
    if (!pickerRow || pickerRow.kind === 'unavailable') return null;
    return slotRejectReason(
      { type: pickerRow.type ?? 'bool', direction: pickerRow.direction ?? 'plcInput' },
      {
        plcType: item.plcType,
        direction: item.direction,
        origin: item.origin ?? 'connect',
        interfaceId: item.interfaceId,
      },
    );
  };

  if (!mgr) return null;
  const targetId = signalBindTargetId(target);

  const persist = (next: import('../layout-planner/rv-layout-store').SignalMapping[]): void => {
    const applied = mgr.applyMappings(targetId, target.node, next);
    persistence.write(applied);
  };

  const bindRow = (row: SlotRow, source: PickerSignal): void => {
    const next = upsertMappingForRow(persistence.read(), row, source);
    if (!next) return;
    persist(next);
    // THE user-initiated boundary (plan-425 F8). Deliberately not inside
    // `persist`, which the unbind path also calls, nor inside applyMappings,
    // which every model load runs.
    emitSignalBindingApplied(viewer, targetId, {
      componentPath: row.componentPath,
      slot: row.slot,
      signal: source.name,
      sourceKind: source.origin === 'internal' ? 'internal' : 'connect',
    });
  };

  return (
    <>
      {rows.map((row) => (
        <SignalSlotRow
          key={slotRowKey(row)}
          row={row}
          targetId={targetId}
          qualifier={qualifiers.get(slotRowKey(row))}
          viewer={viewer}
          signals={signals}
          disabledReason={disabledReason}
          onOpenPicker={(r, anchor) => setPicker({ key: slotRowKey(r), anchor })}
          onUnbind={(r) => persist(removeMappingForRow(persistence.read(), r))}
          onDropSignal={(r, source) => bindRow(r, source)}
        />
      ))}
      <SignalSearchOverlay
        open={!!picker}
        anchorEl={picker?.anchor ?? null}
        onClose={() => setPicker(null)}
        signals={searchItems}
        viewer={viewer}
        title={pickerRow ? `Link ${pickerRow.label ?? pickerRow.slot}` : undefined}
        getRejectReason={pickerRejectReason}
        onPick={(_name, item) => {
          if (!pickerRow || !item) return;
          // omitUndefined: absent optionals must stay ABSENT (plan-422 F1) —
          // a present `undefined` is what the GLB bake has to refuse.
          bindRow(pickerRow, omitUndefined({
            name: item.name,
            interfaceId: item.interfaceId,
            topic: item.topic,
            conflict: item.conflict,
            direction: item.direction,
            dataType: item.plcType,
            address: item.address,
            comment: item.comment,
            origin: item.origin,
          }));
        }}
      />
    </>
  );
}

// ── ComponentSignalSlots ─────────────────────────────────────────────────────

export interface ComponentSignalSlotsProps {
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
  nodePath: string;
  /** Concrete component key of the section (may carry a `_N` dedup suffix). */
  componentType: string;
  /** The component's rv_extras data (read-only GLB fallback without a manager). */
  data: Record<string, unknown>;
}

export function ComponentSignalSlots({ viewer, signalStore, nodePath, componentType, data }: ComponentSignalSlotsProps) {
  const base = baseComponentType(componentType);
  const fields = getSignalSlotFields(base);

  const node = viewer?.registry?.getNode(nodePath) ?? null;
  const mgr = viewer?.signalBindingManager ?? null;
  const target = useMemo(
    () => (viewer && mgr && node ? findSignalBindTarget(viewer, node) : null),
    [viewer, mgr, node],
  );
  const eligibility = useMemo(
    () => (viewer && target ? signalBindEligibility(viewer, target) : null),
    [viewer, target],
  );

  if (fields.length === 0) return null;

  // ── No-manager / no-target state (A1): read-only GLB wiring, no controls ──
  if (!viewer || !mgr || !target) {
    return (
      <>
        {fields.map((f) => {
          const raw = data[f.field];
          let targetName: string | undefined;
          if (typeof raw === 'string' && raw) targetName = signalStore?.get(raw) !== undefined ? raw : signalStore?.nameForPath(raw) ?? raw;
          else if (isComponentRef(raw)) targetName = signalStore?.nameForPath(raw.path) ?? (raw.path.split('/').pop() ?? undefined);
          const row: SlotRow = {
            kind: 'mapped-signal',
            componentPath: '.',
            slot: f.field,
            label: slotLabelOverride(base, f.field),
            type: signalPrimitiveOf(f.signal),
            direction: f.direction,
            targetName,
          };
          return <SignalSlotRow key={f.field} row={row} viewer={viewer ?? undefined} readOnly />;
        })}
      </>
    );
  }

  const targetId = signalBindTargetId(target);
  const rootPath = viewer.registry?.getPathForNode(target.node) ?? NodeRegistry.computeNodePath(target.node);
  const relPath = relativePathUnder(rootPath, canonicalNodePath(viewer, nodePath));
  const fieldNames = new Set(fields.map((f) => f.field));

  const buildRows = (mappings: readonly import('../layout-planner/rv-layout-store').SignalMapping[]): SlotRow[] => {
    const allRows = buildSlotRowModels(viewer, mgr, targetId, target.node, mappings);
    const myRows = allRows.filter((r) => (r.kind === 'unavailable'
      ? fieldNames.has(r.slot)
      : r.componentPath === relPath
        && (r.componentType === undefined || baseComponentType(r.componentType) === base)));

    // Schema order first, then any extra resolver rows; synthesize rows for
    // schema fields the resolver could not produce (no active instance) so
    // every slot ALWAYS appears (F1).
    const bySlot = new Map(myRows.map((r) => [r.slot, r] as const));
    const ordered: SlotRow[] = [];
    for (const f of fields) {
      const row = bySlot.get(f.field);
      if (row) {
        ordered.push(row);
        bySlot.delete(f.field);
      } else {
        ordered.push({
          kind: 'unavailable',
          slot: f.field,
          label: slotLabelOverride(base, f.field),
          reason: `No active ${base} instance provides this slot in the loaded scene`,
        });
      }
    }
    for (const row of bySlot.values()) ordered.push(row);
    return ordered;
  };

  return (
    <>
      {eligibility && !eligibility.eligible && (
        <Box sx={{ px: 1, py: 0.25 }}>
          <Typography sx={{ fontSize: 11, color: INK_LOW }}>
            Signal linking unavailable — {eligibility.reason}
          </Typography>
        </Box>
      )}
      <BindableSlotRows
        viewer={viewer}
        target={target}
        buildRows={buildRows}
        disabledReason={eligibility && !eligibility.eligible ? eligibility.reason : undefined}
      />
    </>
  );
}

// ── PLCSignalSlot (plan-418 F6 — the one slot of a raw PLC signal node) ──────

/** Human sentences for the resolver's fail-closed reasons. */
const PLC_UNAVAILABLE_TEXT: Record<string, string> = {
  'signal-not-registered': 'This signal is not registered in the loaded model — nothing to link to',
  'duplicate-signal-name': 'Another node registers the same signal name — linking one would drive both',
};

/** Whether a component section belongs to a raw PLC signal node. */
export function isPLCSignalComponent(componentType: string): boolean {
  return SIGNAL_TYPES.includes(baseComponentType(componentType));
}

export interface PLCSignalSlotProps {
  viewer: RVViewer | null;
  nodePath: string;
  /** Concrete component key of the section (may carry a `_N` dedup suffix). */
  componentType: string;
}

export function PLCSignalSlot({ viewer, nodePath, componentType }: PLCSignalSlotProps) {
  const base = baseComponentType(componentType);
  const node = viewer?.registry?.getNode(nodePath) ?? null;
  const mgr = viewer?.signalBindingManager ?? null;
  const target = useMemo(
    () => (viewer && mgr && node ? findSignalBindTarget(viewer, node) : null),
    [viewer, mgr, node],
  );
  const eligibility = useMemo(
    () => (viewer && target ? signalBindEligibility(viewer, target) : null),
    [viewer, target],
  );

  if (!SIGNAL_TYPES.includes(base)) return null;

  // No manager / no resolvable target (A1 parity): a single read-only row that
  // still states the slot exists. Without a manager there is nothing to bind.
  if (!viewer || !mgr || !target) {
    return (
      <SignalSlotRow
        row={{ kind: 'unavailable', slot: PLC_SIGNAL_SLOT, reason: 'Signal linking is not available in this session' }}
        viewer={viewer ?? undefined}
        readOnly
      />
    );
  }

  const targetId = signalBindTargetId(target);
  const rootPath = viewer.registry?.getPathForNode(target.node) ?? NodeRegistry.computeNodePath(target.node);
  const relPath = relativePathUnder(rootPath, canonicalNodePath(viewer, nodePath));

  const buildRows = (mappings: readonly import('../layout-planner/rv-layout-store').SignalMapping[]): SlotRow[] => {
    const allRows = buildSlotRowModels(viewer, mgr, targetId, target.node, mappings);
    // The active row of THIS node — in a Planner placement the resolver keeps
    // the node's relative path, so the same filter works for both target kinds.
    const mine = allRows.find((r) => r.kind !== 'unavailable'
      && r.slot === PLC_SIGNAL_SLOT
      && r.componentPath === relPath
      && r.componentType !== undefined
      && baseComponentType(r.componentType) === base);
    if (mine) return [mine];

    // Unavailable rows carry no componentPath, so they are only unambiguously
    // ours when this node IS the bind target root.
    const unavailable = relPath === '.'
      ? allRows.find((r) => r.kind === 'unavailable' && r.slot === PLC_SIGNAL_SLOT)
      : undefined;
    const reason = unavailable?.reason;
    return [{
      kind: 'unavailable',
      slot: PLC_SIGNAL_SLOT,
      reason: (reason && PLC_UNAVAILABLE_TEXT[reason]) ?? reason
        ?? 'This signal is not offered as a link target in the loaded scene',
    }];
  };

  return (
    <>
      {eligibility && !eligibility.eligible && (
        <Box sx={{ px: 1, py: 0.25 }}>
          <Typography sx={{ fontSize: 11, color: INK_LOW }}>
            Signal linking unavailable — {eligibility.reason}
          </Typography>
        </Box>
      )}
      <BindableSlotRows
        viewer={viewer}
        target={target}
        buildRows={buildRows}
        disabledReason={eligibility && !eligibility.eligible ? eligibility.reason : undefined}
      />
    </>
  );
}

// ── BehaviorSignalSlots (F10 — synthetic behavior slots, e.g. Conveyor Flow.*) ─

export interface BehaviorSignalSlotsProps {
  viewer: RVViewer;
  root: Object3D;
  /** Stamped behavior marker type (e.g. `ConveyorBehavior`). */
  markerType: string;
}

export function BehaviorSignalSlots({ viewer, root, markerType }: BehaviorSignalSlotsProps) {
  const stripped = markerType.replace(/Behavior$/, '');
  // The descriptor key that actually matched — also the display-label key.
  const descriptorKey = SLOT_DESCRIPTORS[stripped] ? stripped : markerType;
  const descriptors = SLOT_DESCRIPTORS[descriptorKey] ?? [];

  const mgr = viewer.signalBindingManager;
  const target = useMemo(
    () => (mgr ? findSignalBindTarget(viewer, root) : null),
    [viewer, mgr, root],
  );

  if (descriptors.length === 0) return null;

  const store = viewer.signalStore;
  const scope = instanceScope(root);

  // ALWAYS one row per descriptor (F10): materialised → bindable resolver row;
  // not yet materialised → visible but disabled with an explanation.
  const buildRows = (mappings: readonly import('../layout-planner/rv-layout-store').SignalMapping[]): SlotRow[] => {
    const resolvedRows: SlotRow[] = mgr && target
      ? buildSlotRowModels(viewer, mgr, signalBindTargetId(target), target.node, mappings)
        .filter((r) => r.kind !== 'unavailable' && descriptors.some((d) => d.slot === r.slot))
      : [];
    const bySlot = new Map(resolvedRows.map((r) => [r.slot, r] as const));
    return descriptors.map((d) => {
      const row = bySlot.get(d.slot);
      if (row) return row;
      const scoped = scopeSignalName(scope, d.slot);
      const materialised = store ? store.get(scoped) !== undefined : false;
      return {
        kind: 'unavailable',
        slot: d.slot,
        label: slotLabelOverride(descriptorKey, d.slot),
        reason: materialised
          ? 'Signal linking is not available for this slot'
          : 'Signal not yet available — it materialises when the behavior publishes it',
      };
    });
  };

  if (!mgr || !target) {
    return (
      <>
        {buildRows([]).map((row) => (
          <SignalSlotRow key={row.slot} row={row} viewer={viewer} readOnly />
        ))}
      </>
    );
  }

  return <BindableSlotRows viewer={viewer} target={target} buildRows={buildRows} />;
}
