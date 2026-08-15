// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-slot-row.tsx — THE shared two-column signal-slot row (plan-325).
 *
 * One row per bindable standard-signal SLOT, rendered identically by the
 * Property Inspector (inline in the component section) and the 3D badge
 * popover. Contract (Entscheidungs-Log, User-Direktive 25.07.):
 *
 *   LEFT  — always the SLOT NAME (label typography, never a chip).
 *   RIGHT — always the ASSIGNMENT: the internal model signal (GLB-wired or an
 *           `sourceKind:'internal'` mapping), a CONNECT signal, or
 *           "not linked".
 *
 * The externally LINKED signal is its own cell AFTER the link icon (User
 * decision 30.07.), so a row reads left to right as
 * `slot name · internal signal · [link] · linked signal`. It used to sit
 * inside the assignment chip as a `source → target` composite; the composite
 * made the two names look like one value and hid which of them CONNECT owns.
 * Both cells render as full signal chips, so the linked signal keeps every
 * affordance the rest of the UI gives a signal (live value, force, Shift+drag).
 *
 * States (plan §2.4): empty · GLB-wired (chain indicator) · CONNECT-bound
 * (status color + label) · direct (no model signal — explained in user terms,
 * the word "Direct" does not appear) · unavailable (dimmed + reason).
 *
 * No-manager mode (`readOnly`, plan A1): the GLB wiring renders as a plain
 * chip — no link icon, no picker, no drop target, no crash.
 *
 * Invariant (plan S3/S4): this row NEVER calls onFieldEdit/onFieldReset —
 * binding runs exclusively through the SignalBindingManager + persistence.
 */

import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import BoltIcon from '@mui/icons-material/Bolt';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import PublicIcon from '@mui/icons-material/Public';
import PushPinIcon from '@mui/icons-material/PushPin';
import type { SvgIconComponent } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import {
  mappingSourceKind,
  type SignalLinkDirection,
  type SignalMapping,
} from '../../plugins/layout-planner/rv-layout-store';
import {
  isBindingPulsing,
  pulseKey,
  subscribeBindingPulse,
} from '../../plugins/signal-bind/binding-applied-pulse';
import type { SlotLiveness } from '../engine/rv-signal-binding-manager';
import { SignalBadge, type SignalDirection } from './rv-signal-badge';
import { InspectorRow } from './rv-inspector-row';
import { useSignalDropTarget, SIGNAL_DROP_SX } from './signal-drop-target';
import { useSignalDropHover } from './signal-drop-hover-store';
import { omitUndefined } from './rv-omit-undefined';
import { dropRejectText, slotRejectReason } from '../../plugins/signal-bind/drop-accept';
import {
  AUTHORITY_SENTENCE,
  NOT_LINKED_CELL,
  authorityExplanation,
} from './signal-vocabulary';

// ── Shared row/picker data shapes (moved here from SignalBindPopover) ────────

/** A signal offered for binding (name + direction + PLC type + optional protocol meta). */
export interface PickerSignal {
  name: string;
  interfaceId?: string;
  topic?: string;
  conflict?: boolean;
  direction: 'input' | 'output' | 'unknown';
  /** Full PLC type (e.g. "PLCInputBool") for the status badge. */
  dataType?: string;
  /** Protocol address (e.g. "%I0.6") — shown as picker subtitle. */
  address?: string;
  /** Free-text comment from the tag table — shown as picker subtitle. */
  comment?: string;
  /** 'internal' = a model signal from the SignalStore (plan-325); default CONNECT. */
  origin?: 'connect' | 'internal';
}

/** One row's data: the slot descriptor + its resolved store name + current mapping. */
export interface SlotRow {
  /** Missing only in legacy tests/callers; interpreted as mapped-signal. */
  kind?: 'mapped-signal' | 'direct-property' | 'direct-feedback' | 'unavailable';
  /** Missing only in legacy tests/callers; interpreted as the placement root. */
  componentPath?: string;
  /** rv_extras component key of the owning registry instance (row filtering). */
  componentType?: string;
  slot: string;
  /**
   * Display name of the slot (plan-341 Phase 4). `slot` above stays the
   * IDENTITY — row keys, SlotIds, testids, persisted mappings and auto-matcher
   * tokens all use it verbatim. Undefined = print the raw name (the default,
   * and what every slot without a display entry keeps doing).
   */
  label?: string;
  type?: 'bool' | 'float' | 'int';
  direction?: SignalLinkDirection;
  aliases?: string[];
  /** Present only when the component declares a slot without the required runtime contract. */
  reason?: string;
  /** Real SignalStore name of the internal signal (for the live chip). */
  targetName?: string;
  mapping?: SignalMapping;
  /** plan-320 Phase 5: current write authority of the slot (bound slots only). */
  authority?: 'component' | 'bound' | 'forced';
  /** plan-320 Phase 5: upstream remote-ownership layer active. */
  remoteOwned?: boolean;
  /** plan-320 Phase 5: canWriteSlot() reason for a local-simulation writer. */
  authorityReason?: string;
  /** Provider-specific liveness of the active binding (status label). */
  liveness?: SlotLiveness;
  /** CONNECT source the ASSIGNED internal signal is itself relayed from (chain). */
  chainSource?: string;
}

export type BindableRowKind = Exclude<NonNullable<SlotRow['kind']>, 'unavailable'>;

/** Stable composite identity of a row (componentPath + kind + slot). */
export function slotRowKey(row: Pick<SlotRow, 'componentPath' | 'kind' | 'slot'>): string {
  return `${row.componentPath ?? '.'}\u0000${row.kind ?? 'mapped-signal'}\u0000${row.slot}`;
}

/**
 * Disambiguating prefixes for a row set: when the same slot name occurs on more
 * than one component of the element (an aggregate placement with two sensors →
 * two `IsOccupied` rows), the slot name alone does not say WHICH component the
 * row belongs to. Returns `slotRowKey → qualifier` for the affected rows only —
 * unique slot names stay unprefixed.
 */
export function computeRowQualifiers(rows: readonly SlotRow[]): Map<string, string> {
  const bySlot = new Map<string, SlotRow[]>();
  for (const row of rows) {
    const list = bySlot.get(row.slot);
    if (list) list.push(row);
    else bySlot.set(row.slot, [row]);
  }
  const out = new Map<string, string>();
  for (const list of bySlot.values()) {
    if (list.length < 2) continue;
    for (const row of list) {
      const path = row.componentPath;
      // The element root ('.') has no meaningful name of its own — fall back to
      // the component type so the row stays distinguishable.
      const qualifier = path && path !== '.'
        ? path.slice(path.lastIndexOf('/') + 1)
        : row.componentType ?? '';
      if (qualifier) out.set(slotRowKey(row), qualifier);
    }
  }
  return out;
}

/** Synthesize a PLC type string (e.g. "PLCInputBool") so the badge shows the proper In/Out·Kind label. */
export function synthPlcType(direction: SignalDirection, dataType?: string): string {
  const t = (dataType ?? '').toLowerCase();
  const kind = t.includes('float') || t.includes('real') ? 'Float'
    : t.includes('int') ? 'Int'
    : t.includes('bool') ? 'Bool' : '';
  if (direction === 'unknown' || kind === '') return '';
  return `PLC${direction === 'output' ? 'Output' : 'Input'}${kind}`;
}

/** Map a slot's PLC link direction to the SignalBadge direction (named from the PLC angle). */
export function linkDirToSignalDir(dir: SignalLinkDirection): SignalDirection {
  return dir === 'plcOutput' ? 'output' : 'input';
}

// ── Design tokens (DESIGN.md floors — Label 11px, Ink Low 0.5) ──────────────

const INK_LOW = 'rgba(255,255,255,0.5)';
const ROW_FONT = 11;
/** Minimum interactive hit target (plan-325 A11y floor). */
const HIT_MIN = 24;
/**
 * Both signal cells shrink instead of pushing the row open (User decision
 * 30.07.: "as much room as possible for the chips"). A fixed ceiling was wrong
 * — it truncated in the wide Property Inspector exactly as hard as in the
 * narrow 3D popover. `minWidth: 0` is what lets a flex item fall below its
 * content width at all; the chip's own max-width then follows the cell and its
 * middle truncation keeps the distinguishing suffix visible.
 */
const SHRINKABLE_CELL = { display: 'flex', minWidth: 0, overflow: 'hidden' } as const;

/**
 * The success pulse (plan-425 F8): one ~600 ms instrument-blue glow, then gone.
 *
 * A chip that goes from "not linked" to a name and a `false` looks much as it
 * did, which in a table of thirty slots makes a successful drop easy to doubt.
 * The pulse is the acknowledgement; it is emphatically not a status — nothing
 * here loops, and `prefers-reduced-motion` gets the same glow held briefly
 * rather than a movement, so the feedback survives for people who switch
 * animation off.
 */
function pulseSx(active: boolean): Record<string, unknown> {
  if (!active) return {};
  return {
    borderRadius: 0.5,
    animation: 'rv-binding-pulse 600ms ease-out 1',
    '@keyframes rv-binding-pulse': {
      '0%': { boxShadow: '0 0 0 0 rgba(79,195,247,0.85)', backgroundColor: 'rgba(79,195,247,0.28)' },
      '100%': { boxShadow: '0 0 0 6px rgba(79,195,247,0)', backgroundColor: 'transparent' },
    },
    '@media (prefers-reduced-motion: reduce)': {
      animation: 'none',
      backgroundColor: 'rgba(79,195,247,0.28)',
    },
  };
}

/** Subscribe to the pulse for one slot. `undefined` target ⇒ never pulses. */
function useBindingPulse(
  targetId: string | undefined,
  componentPath: string | undefined,
  slot: string,
): boolean {
  const key = targetId !== undefined
    ? pulseKey(targetId, componentPath ?? '', slot)
    : null;
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => (key ? subscribeBindingPulse(key, listener) : () => {}),
      [key],
    ),
    useCallback(() => (key ? isBindingPulsing(key) : false), [key]),
  );
}

/**
 * Human-readable `canWriteSlot()` reasons — distinct from the plan-317
 * slot-availability wording ("no model signal").
 *
 * The sentences come from the shared vocabulary (plan-341 Phase 6), so this
 * tooltip and the signal-badge authority note say the same thing about the same
 * fact — the note is the same sentence WITHOUT the consequence clause, never a
 * second phrasing of it.
 */
export const AUTHORITY_REASON_TEXT: Record<string, string> = {
  'ok': AUTHORITY_SENTENCE.ok,
  'authority-bound': authorityExplanation('bound'),
  'authority-forced': authorityExplanation('forced'),
  'authority-remote': authorityExplanation('remote'),
};

// ── Status token (plan-341 §2.8 c) ───────────────────────────────────────────
//
// Liveness and authority used to render as TWO adjacent elements in the same
// green, without a separator and with a tooltip on only one of them ("live"
// followed by "bound" reads as one phrase). They now collapse into AT MOST ONE
// token per row with exactly ONE tooltip, chosen by a priority list — first
// matching rule wins. See resolveSlotStatusToken() for which levels need a
// binding and which (the write locks `remote`/`forced`) do not.
//
// Colour rule (Entscheidungs-Log 29.07.): neither red nor green appears here.
// Saturated red means "PLC input is TRUE" and green means "PLCOutput", so the
// four warning levels share ONE amber and are told apart by ICON + LABEL only.
// Amber is held to the same bar as the value steps, and that bar is WCAG 1.4.11
// (3:1, non-text contrast) — see the header of signal-colors.ts for why. The
// DESIGN.md warning amber #ffa726 reaches 4.15:1 / APCA Lc 50.2 against the
// #505050 worst case, so it clears that floor comfortably and this token needs
// no palette of its own: system amber IS the status amber (User decision
// 29.07.). The lighter #FCC270 that the earlier 4.5:1 target forced is gone.

const STATUS_AMBER = '#ffa726';
const INK_HIGH = 'rgba(255,255,255,0.92)';

/** One resolved status token: what the row shows, in what colour, and why. */
export interface SlotStatusToken {
  /** Priority level 1-8 from the matrix — exported for tests and diagnostics. */
  level: number;
  label: string;
  color: string;
  icon: SvgIconComponent;
  tooltip: string;
}

/**
 * Resolve the single status token of a row (plan-341 §2.8 c).
 *
 * Two classes of level, with DIFFERENT preconditions — the distinction matters
 * and an earlier "one token per BOUND row" shorthand got it wrong:
 *
 *  - **Liveness** levels (`conflict`, `disconnected`, `pending`, `live`,
 *    `live · hold`, and the bare `bound` fallback) describe an ACTIVE BINDING.
 *    They cannot exist without one, so they never appear on an unbound row.
 *  - **Authority** levels `remote` and `forced` describe a WRITE LOCK that
 *    exists independently of any binding (plan-320): an operator force pins the
 *    slot's own model signal and holds incoming writes off, and a remote session
 *    owner pre-empts local writers. Hiding those on an unbound row would leave
 *    the pin invisible — nobody could tell why the slot stopped responding.
 *
 * `unavailable` rows carry no token at all, and neither does an unbound row
 * without a lock: it already says "– not linked", and `component` authority
 * there would only restate that.
 *
 * Authority is only NAMED when it deviates from what liveness already implies —
 * `live` implies `bound`, so the word disappears at level 6 and only resurfaces
 * at level 7, where the binding is live but the local simulation still writes.
 */
export function resolveSlotStatusToken(row: SlotRow, bound: boolean): SlotStatusToken | null {
  if (row.kind === 'unavailable') return null;
  const authorityTip = AUTHORITY_REASON_TEXT[row.authorityReason ?? 'ok'] ?? row.authorityReason ?? '';

  if (bound && row.liveness === 'conflict') {
    return {
      level: 1, label: 'conflict', color: STATUS_AMBER, icon: ErrorOutlineIcon,
      tooltip: row.authorityReason
        ? `Conflicting writers on this slot — ${authorityTip}`
        : 'Conflicting writers on this slot',
    };
  }
  if (row.remoteOwned) {
    return {
      level: 2, label: 'remote', color: STATUS_AMBER, icon: PublicIcon,
      tooltip: AUTHORITY_SENTENCE.remote,
    };
  }
  if (row.authority === 'forced') {
    return {
      level: 3, label: 'forced', color: STATUS_AMBER, icon: PushPinIcon,
      tooltip: AUTHORITY_REASON_TEXT['authority-forced'],
    };
  }
  // Everything below needs a binding to exist at all.
  if (!bound) return null;
  if (row.liveness === 'disconnected') {
    return {
      level: 4, label: 'disconnected', color: STATUS_AMBER, icon: LinkOffIcon,
      tooltip: 'The signal provider was lost — the last value is held',
    };
  }
  if (row.liveness === 'pending') {
    return {
      level: 5, label: 'pending', color: INK_HIGH, icon: HourglassEmptyIcon,
      tooltip: 'Waiting for CONNECT',
    };
  }
  // `authority` may be absent (callers that never resolved it). Absent is not a
  // DEVIATION, so it must not push a demonstrably live binding down to level 8
  // and swallow the liveness — only an explicit `component` authority does.
  if ((row.liveness === 'live' || row.liveness === 'hold') && row.authority !== 'component') {
    // A plainly live binding gets NO token (User decision 30.07.): both chips
    // in the row already show their live value, so the word only restated them
    // — and it did so in the width the two signal names need. `hold` stays:
    // "the value you see is frozen" is precisely what the chips cannot say.
    if (row.liveness === 'live') return null;
    return {
      level: 6, label: 'live · hold', color: INK_HIGH, icon: BoltIcon,
      tooltip: `${AUTHORITY_SENTENCE.bound} — the current value is held`,
    };
  }
  if (row.liveness === 'live' && row.authority === 'component') {
    return {
      level: 7, label: 'live · local', color: INK_HIGH, icon: BoltIcon,
      tooltip: 'The binding is live, but the local simulation writes this slot',
    };
  }
  return {
    level: 8, label: 'bound', color: INK_HIGH, icon: LinkIcon,
    tooltip: authorityTip || 'This slot is linked to a signal',
  };
}

/** Explanation for command/feedback slots without a model signal (user domain,
 *  the word "Direct" stays out of the UI — plan §2.4). */
const NO_MODEL_SIGNAL_TOOLTIP =
  'This slot has no model signal — values go straight to the component, so forcing is unavailable.';

function activateOnKey(handler: () => void) {
  return (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
}

// ── SignalSlotRow ────────────────────────────────────────────────────────────

export interface SignalSlotRowProps {
  row: SlotRow;
  /** Viewer for live signal chips (optional — inert chips without it, e.g. tests). */
  viewer?: RVViewer;
  /** CONNECT signals for chip metadata lookup (type/address/comment). */
  signals?: readonly PickerSignal[];
  /**
   * No-manager mode (plan A1): render the GLB wiring read-only — no link
   * icon, no picker, no drop target. Used when `signalBindingManager === null`.
   */
  readOnly?: boolean;
  /** Disables interactions and dims the row, showing the reason. */
  disabledReason?: string;
  onOpenPicker?: (row: SlotRow, anchor: HTMLElement) => void;
  onUnbind?: (row: SlotRow) => void;
  /** Apply a dropped signal to this slot — same codepath as the picker selection. */
  onDropSignal?: (row: SlotRow, signal: PickerSignal) => void;
  /**
   * Owning-component prefix shown before the slot name, set only where the slot
   * name repeats within the surface (see {@link computeRowQualifiers}).
   */
  qualifier?: string;
  /**
   * Bind target this row belongs to. Only used to recognise the success pulse
   * addressed to this slot (plan-425 F8) — omitted, the row simply never pulses,
   * which is the right behaviour for a surface that cannot bind anything.
   */
  targetId?: string;
}

export function SignalSlotRow({
  row, viewer, signals, readOnly, disabledReason, onOpenPicker, onUnbind, onDropSignal, qualifier,
  targetId,
}: SignalSlotRowProps) {
  const interactive = !readOnly && !disabledReason;
  // One short flash when THIS slot was just linked. The subscription is keyed by
  // the slot's full identity, so a second target that happens to share a
  // component path and slot name does not borrow the acknowledgement.
  const pulse = useBindingPulse(targetId, row.componentPath, row.slot);
  // Display name vs. identity (plan-341 Phase 4): everything a human reads uses
  // `displayLabel`, everything that identifies the row keeps using `row.slot`.
  const displayLabel = row.label ?? row.slot;
  const direction = row.direction ?? 'plcInput';
  const type = row.type ?? 'bool';
  const internalDir = linkDirToSignalDir(direction);

  // Stable row identity — the same key the transition stream reports back.
  const rowKey = slotRowKey(row);

  // Why THIS row would refuse the dragged payload. `unavailable` and disabled
  // rows register too (plan-341 §2.4 "reject-only targets"): they used to be
  // absent from the registry entirely, which is why they could never state a
  // reason — the pointer simply died on them.
  const unavailableReason = row.kind === 'unavailable'
    ? (row.reason ?? 'This slot is not available in the current component implementation')
    : disabledReason ?? (onDropSignal ? undefined : 'This surface cannot bind signals');

  const dropRef = useSignalDropTarget({
    reject: (p) => slotRejectReason({ type, direction, unavailableReason }, p),
    describe: () => ({ targetId: rowKey, accessibleLabel: displayLabel }),
    onDrop: (p) => {
      // Guaranteed inert on a reject-only row: the registry only calls onDrop
      // after `reject()` returned null, and unavailableReason never does.
      if (!onDropSignal) return;
      // omitUndefined: an absent optional must stay ABSENT, not become a present
      // `undefined` the GLB bake has to refuse (plan-422 F1).
      onDropSignal(row, omitUndefined({
        name: p.name,
        interfaceId: p.interfaceId,
        topic: p.topic,
        direction: p.direction,
        dataType: p.plcType,
        address: p.address,
        comment: p.comment,
        origin: p.origin,
      }));
    },
  });

  // The hovered row's verdict — the ONE thing a DOM attribute cannot deliver.
  const hover = useSignalDropHover(rowKey);
  const rejectReason = hover?.reason ?? null;
  const rejectText = rejectReason ? dropRejectText(rejectReason) : null;
  /** No-manager mode keeps its promise: read-only rows are not drop targets. */
  const registerDrop = !readOnly;

  if (row.kind === 'unavailable') {
    return (
      <Tooltip title={rejectText ?? row.reason ?? 'This slot is not available in the current component implementation'}>
        <Box
          ref={registerDrop ? dropRef : undefined}
          data-testid={`slot-row-unavailable-${row.slot}`}
          data-rv-slot-kind="unavailable"
          sx={registerDrop ? { px: 1, ...SIGNAL_DROP_SX } : { px: 1 }}
        >
          <InspectorRow
            label={displayLabel}
            labelTitle={displayLabel}
            labelColor={INK_LOW}
            minHeight={HIT_MIN}
            alignField="end"
            dot={rejectReason ? <LinkOffIcon data-testid={`slot-reject-${row.slot}`} sx={{ fontSize: 12, color: INK_LOW }} /> : undefined}
          >
            <Typography sx={{ fontSize: ROW_FONT, color: INK_LOW, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Unavailable — {row.reason}
            </Typography>
          </InspectorRow>
        </Box>
      </Tooltip>
    );
  }

  const mapping = row.mapping;
  const bound = !!mapping?.signal;
  const sourceKind = mapping ? mappingSourceKind(mapping) : 'connect';
  const isDirectKind = row.kind === 'direct-property' || row.kind === 'direct-feedback';

  // The CONNECT picker signal backing the mapping (metadata for the chip).
  const connectMeta = bound && signals
    ? signals.find((signal) =>
      signal.name === mapping!.signal
      && (sourceKind === 'internal'
        ? signal.origin === 'internal' || (!signal.interfaceId && !mapping!.interfaceId)
        : signal.interfaceId === mapping!.interfaceId && signal.topic === mapping!.topic))
    : undefined;
  const connectDragSource = connectMeta?.interfaceId
    ? { interfaceId: connectMeta.interfaceId, topic: connectMeta.topic }
    : undefined;

  const openPicker = (anchor: HTMLElement): void => {
    if (interactive && onOpenPicker) onOpenPicker(row, anchor);
  };

  // ── Assignment cell (right column) ──
  let assignment: ReactNode;

  if (bound && sourceKind === 'internal') {
    // Assigned internal model signal — chip of the model signal; the chain
    // indicator shows that signal's own external CONNECT mapping when present.
    assignment = (
      <SignalBadge
        viewer={viewer}
        signalName={mapping!.signal}
        direction={internalDir}
        plcType={viewer?.signalStore?.getType(mapping!.signal) ?? synthPlcType(internalDir, type)}
        address={connectMeta?.address}
        comment={connectMeta?.comment}
        dragSource={connectDragSource}
        variant="standard"
      />
    );
  } else if (bound && row.kind === 'mapped-signal' && row.targetName) {
    // CONNECT-bound slot WITH a model signal: the assignment stays the internal
    // signal (relay target); the CONNECT source appears as the chain.
    assignment = (
      <SignalBadge
        viewer={viewer}
        signalName={row.targetName}
        direction={internalDir}
        plcType={synthPlcType(internalDir, type)}
        address={connectMeta?.address}
        comment={connectMeta?.comment}
        dragSource={connectDragSource}
        variant="standard"
      />
    );
  } else if (bound) {
    // Command/feedback slot without a model signal: CONNECT chip directly.
    assignment = (
      <SignalBadge
        viewer={viewer}
        signalName={mapping!.signal}
        direction={connectMeta?.direction ?? internalDir}
        plcType={synthPlcType(connectMeta?.direction ?? internalDir, connectMeta?.dataType ?? type)}
        address={connectMeta?.address}
        comment={connectMeta?.comment}
        dragSource={connectDragSource}
        variant="standard"
      />
    );
  } else if (row.kind === 'mapped-signal' && row.targetName) {
    // GLB-wired, not mapped: internal chip only.
    assignment = (
      <SignalBadge
        viewer={viewer}
        signalName={row.targetName}
        direction={internalDir}
        plcType={synthPlcType(internalDir, type)}
        variant="standard"
      />
    );
  } else {
    // Two texts, one visible at a time — the swap is pure CSS, driven by the
    // row's `data-rv-drop-state` (see SIGNAL_DROP_SX). React state here would
    // re-render every empty row on every pointermove of a drag.
    assignment = (
      <>
        <Typography className="rv-slot-empty-text" sx={{ fontSize: ROW_FONT, color: INK_LOW, whiteSpace: 'nowrap' }}>
          {NOT_LINKED_CELL}
        </Typography>
        <Typography
          className="rv-slot-drop-hint"
          aria-hidden
          sx={{ fontSize: ROW_FONT, fontWeight: 600, color: '#4fc3f7', whiteSpace: 'nowrap' }}
        >
          Drop here
        </Typography>
      </>
    );
  }

  // The externally linked CONNECT signal — rendered as its OWN cell after the
  // link icon. Absent where the assignment already IS the CONNECT signal (a
  // command/feedback slot without a model signal): repeating it there would
  // print the same name twice in one row.
  const linkedSignal = bound && sourceKind === 'internal'
    ? row.chainSource
    : bound && row.kind === 'mapped-signal' && row.targetName
      ? mapping!.signal
      : undefined;

  // Exactly ONE status token per bound row, exactly ONE tooltip (plan-341 §2.8 c).
  const status = resolveSlotStatusToken(row, bound);
  const StatusIcon = status?.icon;

  const rowBody = (
    <InspectorRow
      label={qualifier ? (
        <>
          <Box component="span" sx={{ color: INK_LOW }}>{qualifier}&nbsp;·&nbsp;</Box>
          {displayLabel}
        </>
      ) : displayLabel}
      labelTitle={qualifier ? `${qualifier} · ${displayLabel}` : displayLabel}
      labelColor={disabledReason ? INK_LOW : 'text.primary'}
      minHeight={HIT_MIN}
      alignField="end"
      fullWidthField
      opacity={disabledReason ? 0.6 : 1}
      // The reason WINS over the row's own tooltip while the pointer is on it:
      // during a drag that is the only question the user is asking.
      rowTooltip={rejectText ?? disabledReason ?? (isDirectKind ? NO_MODEL_SIGNAL_TOOLTIP : '')}
      // The 14 px gutter was reserved and permanently empty on slot rows — the
      // rejection icon costs no space and shifts no layout (plan-341 §2.5).
      dot={rejectReason
        ? <LinkOffIcon data-testid={`slot-reject-${row.slot}`} sx={{ fontSize: 12, color: INK_LOW }} />
        : undefined}
    >
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, justifyContent: 'flex-end',
        // Never colour alone: the struck-through assignment says "this will not
        // land here" without borrowing red, which now means "PLC input is TRUE".
        ...(rejectReason ? { textDecoration: 'line-through' } : null),
      }}>
        {interactive ? (
          <Box
            role="button"
            tabIndex={0}
            aria-label={`change signal for ${displayLabel}`}
            onClick={(e) => openPicker(e.currentTarget)}
            onKeyDown={activateOnKey(() => {
              const el = document.activeElement as HTMLElement | null;
              if (el) openPicker(el);
            })}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              minWidth: HIT_MIN,
              minHeight: HIT_MIN,
              cursor: 'pointer',
              '&:focus-visible': { outline: '1px solid #4fc3f7', outlineOffset: 1, borderRadius: 0.5 },
              ...pulseSx(pulse),
            }}
          >
            {assignment}
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, ...pulseSx(pulse) }}>
            {assignment}
          </Box>
        )}
        {/* Liveness AND authority in one token (plan-341 §2.8 c) — never colour
            alone: each level carries its own icon and label. */}
        {status && StatusIcon && (
          <Tooltip title={status.tooltip}>
            <Box
              data-testid={`slot-status-${row.slot}`}
              data-rv-status-level={status.level}
              sx={{
                display: 'flex', alignItems: 'center', gap: 0.25,
                color: status.color, whiteSpace: 'nowrap',
              }}
            >
              <StatusIcon sx={{ fontSize: 12 }} />
              <Typography sx={{ fontSize: ROW_FONT, fontWeight: 600, color: 'inherit', whiteSpace: 'nowrap' }}>
                {status.label}
              </Typography>
            </Box>
          </Tooltip>
        )}
        {interactive && (bound ? (
          <Tooltip title="Unlink" placement="top">
            <IconButton
              size="small"
              aria-label={`unbind ${displayLabel}`}
              onClick={() => onUnbind?.(row)}
              sx={{ width: HIT_MIN, height: HIT_MIN, p: 0.5, color: '#4fc3f7' }}
            >
              <LinkOffIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Link signal" placement="top">
            <IconButton
              size="small"
              aria-label={`signal for ${displayLabel}`}
              onClick={(e) => openPicker(e.currentTarget)}
              sx={{ width: HIT_MIN, height: HIT_MIN, p: 0.5, color: INK_LOW, '&:hover': { color: '#4fc3f7' } }}
            >
              <LinkIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        ))}
        {/* Third cell: the linked (CONNECT) signal as a full signal chip — same
            affordances as every other signal in the UI (live value, force,
            Shift+drag, tooltip with address/interface/topic). `origin` is stated
            explicitly: this cell only ever shows a CONNECT source. */}
        {linkedSignal && (
          <Box data-testid={`slot-linked-${row.slot}`} sx={SHRINKABLE_CELL}>
            <SignalBadge
              viewer={viewer}
              signalName={linkedSignal}
              direction={connectMeta?.direction ?? internalDir}
              plcType={viewer?.signalStore?.getType(linkedSignal)
                ?? synthPlcType(connectMeta?.direction ?? internalDir, connectMeta?.dataType ?? type)}
              address={connectMeta?.address}
              comment={connectMeta?.comment}
              dragSource={connectDragSource}
              origin="connect"
              variant="standard"
            />
          </Box>
        )}
      </Box>
    </InspectorRow>
  );

  return (
    <Box
      ref={registerDrop ? dropRef : undefined}
      data-testid={row.componentPath === undefined && row.kind === undefined
        ? `slot-row-${row.slot}`
        : `slot-row-${row.componentPath}-${row.kind}-${row.slot}`}
      data-rv-slot-kind={row.kind ?? 'mapped-signal'}
      data-rv-component-path={row.componentPath ?? '.'}
      sx={registerDrop ? { ...SIGNAL_DROP_SX } : undefined}
    >
      {rowBody}
    </Box>
  );
}
