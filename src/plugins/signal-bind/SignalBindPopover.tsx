// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalBindPopover — content for the Signal-Linking context popover (3D badge).
 *
 * Pure, prop-driven content (no positioning): the generic AnchoredPopover supplies
 * the floating shell. Lists the element's bindable SLOTS as shared
 * {@link SignalSlotRow} rows (plan-325): LEFT the slot name, RIGHT the assigned
 * signal (internal model signal or CONNECT signal) — the same two-column mental
 * model as the inline inspector rows. Clicking the link icon / the assignment
 * opens the reusable SignalSearchOverlay (CONNECT + model signals).
 *
 * Bulk actions (Auto-assign / Unbind all) moved to the component-section header
 * actions in the Property Inspector (plan-325 F5) — the popover is the in-scene
 * quick path only.
 *
 * The connected wrapper (`SignalBindPopoverConnected`) reads the active target from
 * `signalBindStore`, builds rows via the SHARED `buildSlotRowModels` (identical to
 * the inline inspector — plan §9.10), and self-registers under id `'signal-bind'`.
 */

import { useCallback, useMemo, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Typography } from '@mui/material';
import type { RVViewer } from '../../core/rv-viewer';
import type { SignalMapping, SignalLinkDirection } from '../layout-planner/rv-layout-store';
import type { ElementBindingState } from '../../core/engine/rv-signal-binding-manager';
import {
  computeRowQualifiers,
  SignalSlotRow,
  slotRowKey,
  synthPlcType,
  type BindableRowKind,
  type PickerSignal,
  type SlotRow,
} from '../../core/hmi/rv-signal-slot-row';
import { SignalSearchOverlay, type SignalSearchItem } from '../../core/hmi/SignalSearchOverlay';
import { mapDiscoveredDirection, signalBindStore } from './signal-bind-store';
import { signalBindTargetId } from './signal-bind-target';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import {
  buildSlotRowModels,
  collectInternalSignals,
  removeMappingForRow,
  upsertMappingForRow,
} from './slot-row-models';
import { emitSignalBindingApplied } from './binding-applied-pulse';
import { slotRejectReason, type DropRejectReason } from './drop-accept';
import { signalProviderKey } from '../../core/engine/rv-signal-provider';
import { popoverContentRegistry } from '../../core/hmi/popover-store';
import { getConnectSnapshot, subscribeConnectStore, type ConnectInterface } from '../../core/hmi/connect-store';
import { BINDING_STATE_LABEL } from '../../core/hmi/signal-vocabulary';
import { omitUndefined } from '../../core/hmi/rv-omit-undefined';

// Re-exports: the row/picker shapes moved to the shared core row (plan-325);
// existing imports from this module keep working.
export type { PickerSignal, SlotRow } from '../../core/hmi/rv-signal-slot-row';

/** Header label per element state — the shared vocabulary record (plan-341
 *  Phase 6); the 3D badge sprite reads the SAME one. */
const STATE_LABEL: Record<ElementBindingState, string> = BINDING_STATE_LABEL;

/**
 * Panel palette for the header dot. Deliberately NOT shared with the 3D
 * `SIGNAL_BADGE_STATE_COLOR`: the marker palette is tuned against the scene,
 * this one against the panel background, so the values differ on purpose while
 * the LABELS above are identical.
 */
const STATE_COLOR: Record<ElementBindingState, string> = {
  unbound: '#808080',
  live: '#66bb6a',
  pending: '#4fc3f7',
  disconnected: '#ffa726',
  conflict: '#ef5350',
};

/** Compact uppercase group header; the label already carries PLC direction. */
function SectionHeader({ label }: { label: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5, mb: 0.25, px: 1 }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
        {label}
      </Typography>
    </Box>
  );
}

export interface SignalBindPopoverProps {
  /** Header label (element name). */
  label: string;
  /** Bindable slots of this element. */
  slots: readonly SlotRow[];
  /** Signals available for binding (CONNECT + internal model signals). */
  signals: readonly PickerSignal[];
  /** Element binding state (drives the header status dot). */
  state: ElementBindingState;
  /** Viewer for live signal status (optional — inert chips without it, e.g. in tests). */
  viewer?: RVViewer;
  /** Bind/replace one slot to a signal. */
  onBind: (
    slot: string,
    signal: string,
    direction: SignalLinkDirection,
    source?: PickerSignal,
    componentPath?: string,
    kind?: BindableRowKind,
  ) => void;
  /** Unbind one slot. */
  onUnbind: (slot: string, componentPath?: string, kind?: BindableRowKind) => void;
  onClose: () => void;
}

/** Pure content — no store, no positioning. Title + close live in the popover
 *  titlebar (AnchoredPopover), so this renders no header of its own. */
export function SignalBindPopover({
  slots, signals, state, viewer, onBind, onUnbind,
}: SignalBindPopoverProps) {
  // Open search overlay for a slot (anchored to the clicked trigger).
  const [picker, setPicker] = useState<{ key: string; anchor: HTMLElement } | null>(null);

  const pickerRow = picker ? slots.find(s => slotRowKey(s) === picker.key) ?? null : null;

  const searchItems = useMemo<SignalSearchItem[]>(
    () => signals
      .filter((s) => !pickerRow
        // Self-binding exclusion (plan-325): the slot's own target signal is
        // never offered as its source.
        || s.origin !== 'internal'
        || s.name !== pickerRow.targetName)
      .map(s => ({
        name: s.name,
        direction: s.direction,
        plcType: s.dataType && s.dataType.startsWith('PLC') ? s.dataType : synthPlcType(s.direction, s.dataType),
        address: s.address, comment: s.comment,
        interfaceId: s.interfaceId, topic: s.topic, conflict: s.conflict,
        origin: s.origin,
      })),
    [signals, pickerRow],
  );

  /**
   * The picker asks the SAME question the drop asks (plan-341 §2.8 a): one
   * `slotRejectReason` for click, Enter and drag. Before this, the picker was
   * tolerant and the drag was strict, so the same pair could be bindable one
   * way and refused the other.
   */
  const pickerRejectReason = useCallback((item: SignalSearchItem): DropRejectReason | null => {
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
  }, [pickerRow]);

  const bindSignal = (row: SlotRow, source: PickerSignal | null) => {
    if (row.kind === 'unavailable' || !row.direction) return;
    if (!source || source.conflict) {
      if (!source) onUnbind(row.slot, row.componentPath, row.kind);
      return;
    }
    const dir = mapDiscoveredDirection(source.direction, row.direction);
    const legacyRow = row.componentPath === undefined && row.kind === undefined;
    // Internal picks and provider-identified CONNECT picks carry the source;
    // a bare-name legacy pick binds without one (tests/embeds).
    const carrySource = source.origin === 'internal' || !!source.interfaceId;
    if (legacyRow) {
      if (carrySource) onBind(row.slot, source.name, dir, source);
      else onBind(row.slot, source.name, dir);
    } else if (carrySource) {
      onBind(row.slot, source.name, dir, source, row.componentPath, row.kind as BindableRowKind | undefined);
    } else {
      onBind(row.slot, source.name, dir, undefined, row.componentPath, row.kind as BindableRowKind | undefined);
    }
  };

  // Owning-component prefixes for slot names that repeat across components.
  const qualifiers = useMemo(() => computeRowQualifiers(slots), [slots]);

  // Group slots by PLC direction — inputs (viewer→PLC commands) vs. outputs (PLC→viewer status).
  const unavailable = useMemo(() => slots.filter(s => s.kind === 'unavailable'), [slots]);
  const feedback = useMemo(() => slots.filter(s => s.kind !== 'unavailable' && s.direction !== 'plcOutput'), [slots]);
  const controls = useMemo(() => slots.filter(s => s.kind !== 'unavailable' && s.direction === 'plcOutput'), [slots]);

  const renderRow = (row: SlotRow) => (
    <SignalSlotRow
      key={slotRowKey(row)}
      row={row}
      qualifier={qualifiers.get(slotRowKey(row))}
      viewer={viewer}
      signals={signals}
      onOpenPicker={(r, anchor) => setPicker({ key: slotRowKey(r), anchor })}
      onUnbind={(r) => onUnbind(r.slot, r.componentPath, r.kind as BindableRowKind | undefined)}
      onDropSignal={(r, source) => bindSignal(r, source)}
    />
  );

  return (
    // Horizontally resizable (User 31.07.): the chips shrink before the row
    // does, so on long signal names the only real remedy is more width. The
    // former hard 560 ceiling made that impossible — now it is the START width
    // and the user can drag the bottom-right corner out to the viewport.
    // `overflow: auto` is not decoration: CSS `resize` is ignored while
    // overflow is `visible`. Not persisted — the popover is per-selection.
    <Box
      data-testid="signal-bind-popover"
      sx={{
        // Opens at its content width: a two-slot sensor stays narrow, a drive
        // with long signal names opens wide enough to read them. `max-width` is
        // what keeps that honest — it caps the runaway case AND doubles as the
        // drag ceiling, since CSS `resize` can never exceed max-width.
        width: 'fit-content',
        minWidth: 320,
        maxWidth: 'min(900px, calc(100vw - 32px))',
        resize: 'horizontal',
        overflow: 'auto',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: STATE_COLOR[state] }} />
        <Typography data-testid="signal-bind-state" sx={{ fontSize: 11, color: STATE_COLOR[state] }}>
          {STATE_LABEL[state]}
        </Typography>
      </Box>
      {slots.length === 0 && (
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', py: 1 }}>
          No bindable signals on this element.
        </Typography>
      )}

      {controls.length > 0 && <SectionHeader label="PLC Outputs" />}
      {controls.map(renderRow)}
      {feedback.length > 0 && <SectionHeader label="PLC Inputs" />}
      {feedback.map(renderRow)}
      {unavailable.length > 0 && <SectionHeader label="Unavailable" />}
      {unavailable.map(renderRow)}

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
          bindSignal(pickerRow, omitUndefined({
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
    </Box>
  );
}

/** Flatten CONNECT signals while preserving provider identity and duplicate-name conflicts. */
export function collectConnectSignals(interfaces: readonly ConnectInterface[]): PickerSignal[] {
  const out: PickerSignal[] = [];
  for (const iface of interfaces) {
    for (const topic of iface.topics ?? []) {
      for (const s of topic.signals ?? []) {
        out.push({
          name: s.name, interfaceId: iface.id, topic: topic.topic,
          direction: s.type.startsWith('PLCOutput') ? 'output' : 'input',
          dataType: s.type, address: s.protocolAddress, comment: s.comment,
        });
      }
    }
    for (const s of iface.signals ?? []) {
      out.push({
        name: s.name, interfaceId: iface.id,
        direction: s.type.startsWith('PLCOutput') ? 'output' : 'input',
        dataType: s.type,
        address: s.protocolAddress,
        comment: s.comment,
      });
    }
  }
  const providersByName = new Map<string, Set<string>>();
  for (const signal of out) {
    let providers = providersByName.get(signal.name);
    if (!providers) { providers = new Set(); providersByName.set(signal.name, providers); }
    if (signal.interfaceId) providers.add(signalProviderKey({ interfaceId: signal.interfaceId, topic: signal.topic }));
  }
  for (const signal of out) signal.conflict = (providersByName.get(signal.name)?.size ?? 0) > 1;
  return out;
}

// ── Connected wrapper (reads signalBindStore + viewer; self-registers) ──

function SignalBindPopoverConnected({ viewer }: { viewer: RVViewer }) {
  const target = useSyncExternalStore(signalBindStore.subscribe, signalBindStore.getSnapshot);
  const persistence = useMemo(() => target ? createSignalBindingPersistence(viewer, target) : null, [viewer, target]);
  const subscribeMappings = useCallback((listener: () => void) => persistence?.subscribe(listener) ?? (() => {}), [persistence]);
  const mappingSnapshot = useCallback(() => JSON.stringify(persistence?.read() ?? []), [persistence]);
  useSyncExternalStore(subscribeMappings, mappingSnapshot);

  const mgr = viewer.signalBindingManager;
  // Re-render when CONNECT interfaces/signals change (so late-imported signals appear).
  // Global exact 1:1 auto-bind is handled centrally by the layout-planner (no popover needed).
  const connectSnap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);

  if (!target || !mgr || !persistence) return null;

  const targetId = signalBindTargetId(target);
  const mappings = persistence.read();

  // SHARED row-model builder (plan-325 §9.10): identical to the inline
  // inspector rows — same resolver, same mapping match, same authority.
  const rows: SlotRow[] = buildSlotRowModels(viewer, mgr, targetId, target.node, mappings);

  // Available signals: CONNECT (dedup/conflict-marked) + internal model signals.
  const signals: PickerSignal[] = [
    ...collectConnectSignals(connectSnap.interfaces),
    ...(viewer.signalStore ? collectInternalSignals(viewer.signalStore) : []),
  ];

  const persist = (next: SignalMapping[]) => {
    const applied = mgr.applyMappings(targetId, target.node, next);
    persistence.write(applied);
  };

  const setMapping = (
    slot: string,
    signal: string,
    direction: SignalLinkDirection,
    source?: PickerSignal,
    componentPath?: string,
    kind?: BindableRowKind,
  ) => {
    if (!source) return;
    const next = upsertMappingForRow(mappings, { slot, componentPath, kind, direction }, source);
    if (!next) return;
    persist(next);
    // Same boundary as the inline drop (plan-425 F8) — the picker is the other
    // way a person makes a link, and it must acknowledge the same way.
    emitSignalBindingApplied(viewer, targetId, {
      componentPath,
      slot,
      signal: source.name,
      sourceKind: source.origin === 'internal' ? 'internal' : 'connect',
    });
  };

  return (
    <SignalBindPopover
      label={target.label ?? target.node.name}
      slots={rows}
      signals={signals}
      viewer={viewer}
      state={mgr.getElementState(targetId)}
      onBind={setMapping}
      onUnbind={(slot, componentPath, kind) =>
        persist(removeMappingForRow(mappings, { slot, componentPath, kind }))}
      onClose={() => signalBindStore.clear()}
    />
  );
}

// Self-register as the 'signal-bind' popover content. The AnchoredPopover passes
// the viewer from React context; we read it via the hook.
import { useViewer } from '../../hooks/use-viewer';
function SignalBindPopoverRoot() {
  const viewer = useViewer();
  return <SignalBindPopoverConnected viewer={viewer} />;
}
popoverContentRegistry.register('signal-bind', SignalBindPopoverRoot);
