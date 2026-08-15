// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-badge.tsx — Central signal rendering for the WebViewer HMI.
 *
 * Provides:
 * - SignalBadge: Chip-style signal badge (OutBool ●, InBool ○) used by
 *   hierarchy browser, tooltip, and property inspector
 * - useSignalForce: Hook for forcing (pinning) a signal — click-to-force everywhere
 * - useSignalValues: Hook for live signal polling with direction/type info
 * - Utility functions for signal direction, color, and label resolution
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Box, Typography, Chip, Tooltip, Popover, TextField, Button } from '@mui/material';
import { ArrowRightAlt, Close } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalMeta } from '../engine/rv-signal-store';
import type { SignalActivity } from '../engine/rv-signal-activity';
import { getViewerMode, getConnectSnapshot } from './connect-store';
import { componentColor } from './rv-inspector-helpers';
import { navigateToRef } from './rv-reference-display';
import { requestForceConfirm } from './force-confirm-store';
import {
  AUTHORITY_SENTENCE,
  PROVENANCE_DRIVES_TITLE,
  PROVENANCE_REFERENCED_TITLE,
} from './signal-vocabulary';
import { useThrottledSignalValue } from '../../hooks/use-throttled-signal';
import { useSignalDisplaySettings, type SignalTooltipFields, type SignalChipVariant } from './signal-display-store';
import {
  armSignalDrag,
  consumeSignalDragClick,
  useSignalDragActive,
  SIGNAL_DRAG_THRESHOLD_PX,
} from './signal-drag-store';
import {
  describeChannelAuthority,
  makeSignalChannelId,
  remoteWriteOverridesForce,
  type ChannelAuthorityInfo,
} from '../engine/rv-slot-authority';
import { CHIP_RADIUS } from './shared-sx';
import { signalValueColor, signalValueColorForValue } from './signal-colors';
import { omitUndefined } from './rv-omit-undefined';

const REFRESH_MS = 200;
/**
 * Character cap for signal names in NON-DOM contexts (plan-422 F4).
 *
 * The DOM chip no longer uses it. A fixed character count is a guess about
 * width, and it was guessing against a popover column wide enough for the whole
 * name — which is how "PLC_ExitConveyorRun" reached the user as
 * "PLC_ExitCon…". CSS knows the real width; the chip now ellipsises there and
 * carries the full name in its `title`.
 *
 * Kept, and exported, for surfaces where CSS cannot help: anything measured in
 * characters rather than pixels. The 3D badges are NOT such a surface — they
 * are icon sprites (`port-marker-texture.ts`) and have never drawn the signal
 * name at all, so there is no canvas limit here to raise.
 */
export const SIGNAL_CHIP_NAME_MAX = 24;

/** Amber used for the "forced" (operator-pinned) state, matching the ISA amber palette. */
const FORCE_COLOR = '#ffb300';

/**
 * Touch hold that arms a chip drag (plan-422 F6).
 *
 * Matches the `LONG_PRESS_MS` the ConnectPanel signal rows already use for
 * their touch context menu, so the two long presses a user can perform in the
 * same panel take the same amount of time to commit.
 */
const TOUCH_DRAG_LONG_PRESS_MS = 500;

// ── Signal direction ──────────────────────────────────────────────────

/** Signal direction derived from the node's PLCInput/PLCOutput type. */
export type SignalDirection = 'input' | 'output' | 'unknown';

/**
 * Colour of an ACTIVE (TRUE) signal value: green = PLCOutput, red = PLCInput.
 *
 * Kept as the named shorthand for the `strong` step; the value itself lives in
 * `signal-colors.ts`, which also owns the `weak` step and the neutral
 * "no value" step (plan-341 Phase 0). Prefer
 * {@link signalValueColorForValue} wherever a raw value is at hand.
 */
export function signalActiveColor(dir: SignalDirection): string {
  return signalValueColor(dir, true);
}

/** Short badge label from full PLC type — matches hierarchy browser. */
export function signalBadgeLabel(plcType: string): string {
  if (plcType === 'PLCOutputBool') return 'OutBool';
  if (plcType === 'PLCOutputFloat') return 'OutFloat';
  if (plcType === 'PLCOutputInt') return 'OutInt';
  if (plcType === 'PLCInputBool') return 'InBool';
  if (plcType === 'PLCInputFloat') return 'InFloat';
  if (plcType === 'PLCInputInt') return 'InInt';
  if (plcType.startsWith('PLCOutput')) return 'Out:' + plcType.replace('PLCOutput', '');
  if (plcType.startsWith('PLCInput')) return 'In:' + plcType.replace('PLCInput', '');
  return plcType;
}

/**
 * Build the chip label for a display variant (plan-246 F2). Pure & testable.
 *   'full'     → "Name TypeLabel Value"  (type from plcType, "Out"/"In" fallback)
 *   'standard' → "Name Value"
 *   'minimal'  → "I Value" / "O Value"   (direction letter only, no name)
 * The name for 'full'/'standard' is `displayName ?? signalName` — the store key
 * (dot notation) is the natural full name when no friendly displayName is given,
 * so 'full' really shows the complete information at every call site. Without
 * either name, 'full' degrades to "TypeLabel Value" and 'standard' to the value.
 */
export function buildChipLabel(variant: SignalChipVariant, parts: ChipLabelInput): string {
  const { name, tail } = buildChipLabelParts(variant, parts);
  return name ? `${name}  ${tail}` : tail;
}

export interface ChipLabelInput {
  displayName?: string;
  /** SignalStore key (dot notation) — name fallback for 'full'/'standard'. */
  signalName?: string;
  plcType?: string;
  direction: SignalDirection;
  valueStr: string;
}

/**
 * The same label, split where it is allowed to be cut (plan-422 F4).
 *
 * A chip is "name, then reading", and only the first half is expendable. The
 * old single string could not express that: giving it `text-overflow: ellipsis`
 * would eat the VALUE — the one part nobody can infer — so the name had to be
 * pre-cut to 24 characters instead, in a column that was often wide enough for
 * all of it.
 *
 * Splitting moves the decision to where the width actually is. The renderer
 * lets `name` shrink and ellipsise while `tail` keeps its intrinsic size, so a
 * long name gives way to the reading rather than the other way round, and the
 * whole name stays reachable through the chip's `title`.
 */
export function buildChipLabelParts(
  variant: SignalChipVariant,
  parts: ChipLabelInput,
): { name?: string; tail: string } {
  const { displayName, signalName, plcType, direction, valueStr } = parts;
  if (variant === 'minimal') {
    const dir = direction === 'output' ? 'O' : direction === 'input' ? 'I' : '';
    return { tail: dir ? `${dir} ${valueStr}` : valueStr };
  }
  // The name travels WHOLE from here on. Fitting it is a layout question,
  // answered by CSS ellipsis against the real width.
  const name = displayName ?? signalName;
  if (variant === 'standard') {
    return name ? { name, tail: valueStr } : { tail: valueStr };
  }
  // 'full'
  const typeLabel = plcType
    ? signalBadgeLabel(plcType)
    : (direction === 'output' ? 'Out' : direction === 'input' ? 'In' : '');
  const core = typeLabel ? `${typeLabel} ${valueStr}` : valueStr;
  return name ? { name, tail: core } : { tail: core };
}

/** Resolve signal direction and full PLC type from registry or signal store. */
export function resolveSignalInfo(viewer: RVViewer, signalName: string): { direction: SignalDirection; plcType: string } {
  // Primary: check SignalStore (always knows the PLC type, even when Signal.Name differs from node name)
  const storeType = viewer.signalStore?.getType(signalName);
  if (storeType) {
    const direction: SignalDirection = storeType.startsWith('PLCOutput') ? 'output'
      : storeType.startsWith('PLCInput') ? 'input' : 'unknown';
    return { direction, plcType: storeType };
  }
  // Fallback: search registry by node name
  const reg = viewer.registry;
  if (!reg) return { direction: 'unknown', plcType: '' };
  const results = reg.search(signalName);
  if (results.length === 0) return { direction: 'unknown', plcType: '' };
  const types = results[0].types;
  const plcType = types.find(t => t.startsWith('PLCOutput') || t.startsWith('PLCInput')) ?? '';
  const direction: SignalDirection = plcType.startsWith('PLCOutput') ? 'output'
    : plcType.startsWith('PLCInput') ? 'input' : 'unknown';
  return { direction, plcType };
}

// ── useSignalForce hook ───────────────────────────────────────────────

export interface SignalForceController {
  /** True if the signal is currently forced (pinned). */
  forced: boolean;
  /** The forced value, or undefined when not forced. */
  forcedValue: boolean | number | undefined;
  /** True when forcing is wired (viewer + store + a signal name are present). */
  enabled: boolean;
  /**
   * Change the forced value (and start forcing if not yet forced). Always leaves
   * the signal forced — releasing is a separate action ({@link release}).
   *   Bool:    flips the value (forces the opposite of the current/forced value).
   *   Numeric: pins the current live value (no change if already forced).
   */
  toggle: () => void;
  /** Force to an explicit value. */
  force: (value: boolean | number) => void;
  /** Release the force so interface updates flow again. Separate from {@link toggle}. */
  release: () => void;
}

/**
 * Live force-state for a single signal. Re-renders only when *this* signal's
 * forced status changes (subscribes to the store's force-change bus, then
 * diffs). Tolerates an undefined viewer/name (returns a disabled controller).
 */
export function useSignalForce(viewer: RVViewer | undefined, name: string | undefined): SignalForceController {
  const store = viewer?.signalStore ?? null;
  const [forced, setForced] = useState<boolean>(() => !!(name && store?.isForced(name)));
  const [forcedValue, setForcedValue] = useState<boolean | number | undefined>(
    () => (name ? store?.getForcedValue(name) : undefined),
  );

  useEffect(() => {
    if (!store || !name) { setForced(false); setForcedValue(undefined); return; }
    const sync = () => {
      const f = store.isForced(name);
      setForced(f);
      setForcedValue(f ? store.getForcedValue(name) : undefined);
    };
    sync();
    return store.subscribeForce(sync);
  }, [store, name]);

  const toggle = useCallback(async () => {
    if (!store || !name) return;
    // First force in a session is gated by a confirmation (until reload).
    if (!(await requestForceConfirm())) return;
    const raw = store.get(name);
    const typeIsBool = (store.getType(name) ?? '').includes('Bool');
    const isBool = typeof raw === 'boolean' || (raw === undefined && typeIsBool);
    if (isBool) {
      // Flip relative to the currently shown value, then hold it.
      const cur = store.isForced(name) ? store.getForcedValue(name) === true : raw === true;
      store.forceSignal(name, !cur);
    } else if (!store.isForced(name)) {
      // Pin the current live numeric value (explicit editing comes later).
      store.forceSignal(name, typeof raw === 'number' ? raw : 0);
    }
    // forced numeric + toggle → keep value (release is a separate action)
  }, [store, name]);

  const force = useCallback(async (value: boolean | number) => {
    if (!store || !name) return;
    if (!(await requestForceConfirm())) return;
    store.forceSignal(name, value);
  }, [store, name]);

  const release = useCallback(() => {
    if (store && name) store.unforce(name);
  }, [store, name]);

  return { forced, forcedValue, enabled: !!(store && name), toggle, force, release };
}

// ── Numeric signal helpers ────────────────────────────────────────────

/** True if the PLC type is a Bool signal (toggle), false for Int/Float (value entry). */
export function isBoolSignal(plcType: string | undefined): boolean {
  return (plcType ?? '').includes('Bool');
}

/** True if the PLC type is an Int signal (whole numbers only). */
export function isIntSignal(plcType: string | undefined): boolean {
  return (plcType ?? '').includes('Int');
}

// ── Tooltip content ───────────────────────────────────────────────────

/** Human-readable "Direction · Kind" phrase from a PLC type (e.g. "Output · Int"). */
export function signalTypePhrase(plcType: string | undefined, direction: SignalDirection): string {
  const dirWord = direction === 'output' ? 'Output' : direction === 'input' ? 'Input' : '';
  const t = plcType ?? '';
  const kind = t.includes('Bool') ? 'Bool' : t.includes('Int') ? 'Int' : t.includes('Float') ? 'Float' : '';
  if (dirWord && kind) return `${dirWord} · ${kind}`;
  return dirWord || kind || (plcType ?? '');
}

/** Format a signal value for the tooltip (mirrors the badge's display rules). */
export function formatSignalValue(value: boolean | number | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

/**
 * Compact, human-readable liveness label for a signal's {@link SignalActivity}.
 * Pure & testable. `ageMs` (now − lastUpdateTs) is only used to render the
 * "stale Ns" age; omit it and a bare "stale" is shown.
 *   - `live`      → "live"
 *   - `supplied`  → "supplied"
 *   - `local`     → "local"
 *   - `stale`     → "stale" (or "stale 45s" with an age)
 *   - `no-source` → "no source"
 */
export function activityLabel(activity: SignalActivity, ageMs?: number): string {
  switch (activity) {
    case 'live': return 'live';
    case 'supplied': return 'supplied';
    case 'local': return 'local';
    case 'stale':
      if (ageMs !== undefined && Number.isFinite(ageMs) && ageMs >= 0) {
        return `stale ${Math.round(ageMs / 1000)}s`;
      }
      return 'stale';
    case 'no-source': return 'no source';
    default: return '';
  }
}

/**
 * Planner slot manually driven by a signal — the row shape of
 * `SignalBindingManager.getLinksForSource()` (structural mirror of its
 * `SourceLink`, kept local so the tooltip model stays engine-independent).
 *
 * `slot` is the identity; `componentType`/`label` are the display pair
 * (plan-353 F2) and are optional — see {@link signalLinkedSlotLabel}.
 */
export interface SignalLinkedSlot {
  path: string;
  slot: string;
  placedId: string;
  /** rv_extras component key of the owning instance (e.g. `Drive_Simple`). */
  componentType?: string;
  /** Human-readable slot name; falls back to the raw `slot`. */
  label?: string;
}

/**
 * Display text for one driven slot (plan-353 F2): `componentType · label`.
 *
 * Pure & testable. Two deliberate rules:
 *  - the LABEL is the label SSOT (`resolved.label`) and falls back to the raw
 *    slot key — never a second humanisation of the slot name here;
 *  - a missing `componentType` yields the bare label, NOT a placeholder type.
 *    "Forward" is honest; "Component · Forward" invents a fact.
 *
 * The technical type name is printed verbatim (`Drive_DestinationMotor`), which
 * is what the rest of the binding UI shows too.
 */
export function signalLinkedSlotLabel(link: SignalLinkedSlot): string {
  const name = link.label ?? link.slot;
  return link.componentType ? `${link.componentType} · ${name}` : name;
}

/** Plain-data model the tooltip renders — kept separate so it can be unit-tested. */
export interface SignalTooltipModel {
  name: string;
  typePhrase: string;
  value: string;
  forced: boolean;
  address?: string;
  source?: string;
  comment?: string;
  hint: string;
  /** NEW (plan-234): derived liveness state, when resolved. */
  activity?: SignalActivity;
  /** NEW: compact liveness label ("live" / "stale 45s" / "no source" / "local"). */
  activityLabel?: string;
  /** NEW: component/node bindings for the signal (nearest owner first). */
  boundTo?: Array<{ componentType: string; path: string }>;
  /** Planner slots manually driven by this signal. Resolved lazily while the tooltip is open. */
  linkedSlots?: SignalLinkedSlot[];
  /** NEW (plan-246): originating CONNECT interface name, when resolvable. */
  interfaceOrigin?: string;
  /** CONNECT topic carrying the signal, when the provider is topic-based. */
  topic?: string;
  /** NEW (plan-246): hierarchy path of the signal NODE itself — the tooltip
   *  title becomes clickable and navigates to the signal object. */
  nodePath?: string;
  /** NEW (plan-320): write-authority note ("Force overridden by remote owner",
   *  "A live binding writes this slot", …). Omitted when nothing dominates. */
  authorityNote?: string;
}

/**
 * Compact write-authority note for the signal tooltip (plan-320 Phase 3+5).
 * Pure & testable. The remote-override hint ships WITH Phase 3 so the
 * `remote > forced` ranking is never invisible at the force chip.
 */
export function buildAuthorityNote(args: {
  forced: boolean;
  /** Result of describeChannelAuthority() for the signal, or null/undefined. */
  channelAuthority?: ChannelAuthorityInfo | null;
  /** Result of remoteWriteOverridesForce() — strict ranking + active owner. */
  remoteOverridesForce: boolean;
}): string | undefined {
  const { forced, channelAuthority, remoteOverridesForce } = args;
  if (forced && remoteOverridesForce) return 'Force overridden by remote owner';
  if (channelAuthority) {
    const remoteSuffix = channelAuthority.remoteOwned ? ' · remote owner active' : '';
    // The SHORT form of the slot-row tooltip's sentence (plan-341 Phase 6):
    // same lexemes, consequence clause omitted for the compact note line.
    if (channelAuthority.authority === 'forced') return `${AUTHORITY_SENTENCE.forced}${remoteSuffix}`;
    if (channelAuthority.authority === 'bound') return `${AUTHORITY_SENTENCE.bound}${remoteSuffix}`;
    if (channelAuthority.remoteOwned) return 'Remote owner active';
  }
  return undefined;
}

/**
 * Resolve the CONNECT interface a signal originates from, from its
 * `SignalMeta.source` label (e.g. "MQTT", "MQTT · Data_I_1", "S7 · DB1").
 * Uses the same type-in-source heuristic as `isSourceConnected` — the source
 * label always starts with `iface.type`. Pure & testable; returns the
 * interface id (the user-visible CONNECT interface name) or undefined.
 */
export function resolveInterfaceOrigin(
  source: string | undefined,
  interfaces: ReadonlyArray<{ id: string; type: string }>,
): string | undefined {
  if (!source) return undefined;
  const match = interfaces.find((i) => source === i.type || source.startsWith(`${i.type} `) || source.includes(i.type));
  return match?.id;
}

/** Minimal interface shape for origin resolution (structural subset of ConnectInterface). */
export interface InterfaceOriginCandidate {
  id: string;
  type: string;
  /** `topic` carries the MQTT topic name so the origin can report it (plan-353 F3). */
  topics?: ReadonlyArray<{ topic?: string; signals?: ReadonlyArray<{ name: string }> }>;
  signals?: ReadonlyArray<{ name: string }>;
}

/**
 * Where a signal comes from: the CONNECT interface, plus the topic that carries
 * it when the provider is topic-based (plan-353 F3).
 */
export interface SignalOrigin {
  interfaceId: string;
  /** MQTT topic the signal was found under; absent for flat/heuristic hits. */
  topic?: string;
}

/**
 * Resolve a signal's originating CONNECT interface (plan-246 F6, extended by
 * plan-353 F3 to carry the topic).
 *
 * Primary: SIGNAL MEMBERSHIP — the connect-store snapshot knows every
 * interface's signal lists (topic-nested + flat); if the signal name appears
 * there, that interface's id is the origin, and a topic-nested hit reports its
 * topic as well. Fallback: the source-label heuristic
 * ({@link resolveInterfaceOrigin}) for signals not in the snapshot (e.g. legacy
 * metadata after a gateway restart) — that path knows no topic.
 *
 * Multiple membership is resolved DETERMINISTICALLY by first find, scanning
 * interfaces in order and, within an interface, topics before the flat list.
 * The same signal name genuinely can sit on two interfaces (a mirrored signal);
 * picking "the first" is arbitrary but STABLE, which is what a tooltip needs —
 * an origin that flips between renders would be worse than an imperfect one.
 *
 * Pure & testable.
 */
export function resolveInterfaceOriginForSignal(
  signalName: string | undefined,
  source: string | undefined,
  interfaces: ReadonlyArray<InterfaceOriginCandidate>,
): SignalOrigin | undefined {
  if (signalName) {
    for (const iface of interfaces) {
      for (const topic of iface.topics ?? []) {
        if (topic.signals?.some((s) => s.name === signalName)) {
          return topic.topic !== undefined
            ? { interfaceId: iface.id, topic: topic.topic }
            : { interfaceId: iface.id };
        }
      }
      if (iface.signals?.some((s) => s.name === signalName)) return { interfaceId: iface.id };
    }
  }
  const interfaceId = resolveInterfaceOrigin(source, interfaces);
  return interfaceId !== undefined ? { interfaceId } : undefined;
}

/**
 * Build the (pure) tooltip data model for a signal. Always returns name + type
 * phrase + value + hint; address/source/comment are only present when metadata
 * supplies them. `boundTo`/`activity`/`activityLabel` are new optional inputs —
 * omit them and the shape is exactly as before (backward compatible).
 * Extracted as a pure function so it is testable without React.
 */
export function buildSignalTooltipModel(args: {
  name: string;
  plcType: string | undefined;
  direction: SignalDirection;
  shown: boolean | number | undefined;
  forced: boolean;
  meta: SignalMeta | undefined;
  hint: string;
  boundTo?: Array<{ componentType: string; path: string }>;
  linkedSlots?: SignalLinkedSlot[];
  activity?: SignalActivity;
  activityLabel?: string;
  interfaceOrigin?: string;
  topic?: string;
  nodePath?: string;
  authorityNote?: string;
}): SignalTooltipModel {
  const {
    name, plcType, direction, shown, forced, meta, hint, boundTo, linkedSlots,
    activity, activityLabel, interfaceOrigin, topic, nodePath, authorityNote,
  } = args;
  return {
    name,
    typePhrase: signalTypePhrase(plcType, direction),
    value: formatSignalValue(shown),
    forced,
    address: meta?.address ?? undefined,
    source: meta?.source ?? undefined,
    comment: meta?.comment ?? undefined,
    hint,
    ...(boundTo && boundTo.length > 0 ? { boundTo } : {}),
    ...(linkedSlots && linkedSlots.length > 0 ? { linkedSlots } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...(activityLabel !== undefined ? { activityLabel } : {}),
    ...(interfaceOrigin !== undefined ? { interfaceOrigin } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(nodePath !== undefined ? { nodePath } : {}),
    ...(authorityNote !== undefined ? { authorityNote } : {}),
  };
}

/** Short node path for the binding line — last two segments (e.g. "Conveyor01/EndStop"). */
function shortNodePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join('/');
}

/** Leaf node label for a manually driven slot (the slot itself supplies the second identity). */
function leafNodeName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Max binding rows rendered in the tooltip before collapsing into "+N more" (plan-246 risk table). */
export const MAX_TOOLTIP_BINDING_ROWS = 8;

interface TooltipBindingRow {
  key: string;
  path: string;
  label: string;
  color: string;
  /**
   * Dim right-hand qualifier (plan-353 §3.1): WHICH node this row belongs to.
   * `label` answers "what" (`Drive_Simple · Forward`) and repeats across rows
   * when one signal drives the same slot on several placements — without the
   * node name those rows would be indistinguishable. Optional: blocks whose
   * label already contains the path (Referenced by) leave it out.
   */
  secondary?: string;
}

/** Shared clickable provenance block used for manual and GLB-name bindings. */
function TooltipBindingBlock({
  title,
  rows,
  viewer,
}: {
  title: string;
  rows: TooltipBindingRow[];
  viewer?: RVViewer;
}) {
  if (rows.length === 0) return null;
  const shownRows = rows.slice(0, MAX_TOOLTIP_BINDING_ROWS);
  const moreRows = rows.length - shownRows.length;
  return (
    <Box sx={{ mt: 0.5, pt: 0.35, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <Typography component="div" sx={{ fontSize: 9, fontWeight: 700, opacity: 0.7 }}>
        {title}
      </Typography>
      {shownRows.map((row) => (
        <Box
          key={row.key}
          component="div"
          onClick={(e) => { e.stopPropagation(); navigateToRef(viewer ?? null, row.path); }}
          sx={{
            display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25,
            cursor: viewer ? 'pointer' : 'default',
            ...(viewer ? { '&:hover': { textDecoration: 'underline' } } : {}),
          }}
        >
          <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: row.color, flexShrink: 0 }} />
          <Typography component="span" sx={{ fontSize: 10, color: row.color }}>
            {row.label}
          </Typography>
          {row.secondary && (
            <Typography
              component="span"
              sx={{ fontSize: 9, opacity: 0.5, ml: 'auto', pl: 1, flexShrink: 0 }}
            >
              {row.secondary}
            </Typography>
          )}
        </Box>
      ))}
      {moreRows > 0 && (
        <Typography component="div" sx={{ fontSize: 9, opacity: 0.55, mt: 0.25 }}>
          +{moreRows} more
        </Typography>
      )}
    </Box>
  );
}

/** Render the SignalBadge hover tooltip from its data model. `fields` gates which
 *  optional lines are visible (user setting); the name is always shown. The
 *  tooltip is interactive (plan-246 F7): every binding row is clickable and
 *  navigates to the bound component via navigateToRef. */
function SignalTooltipContent({ model, viewer, fields }: { model: SignalTooltipModel; viewer?: RVViewer; fields: SignalTooltipFields }) {
  const valueLine = model.typePhrase
    ? `${model.typePhrase} · ${model.value}${model.forced ? ' (forced)' : ''}`
    : `${model.value}${model.forced ? ' (forced)' : ''}`;
  const addressLine = model.address
    ? (model.source ? `${model.address}  ·  ${model.source}` : model.address)
    : (model.source ?? '');
  const driveRows: TooltipBindingRow[] = (model.linkedSlots ?? []).map((link, index) => {
    // The COLOUR still comes from the registry (it knows a node's components
    // even when the binding carried no type), but the TEXT is the binding's own
    // display pair (plan-353 F2) — one label source, no second derivation.
    const componentTypes = viewer?.registry?.getComponentTypes(link.path) ?? [];
    const componentType = link.componentType
      ?? componentTypes.find((type) => type !== 'LayoutObject')
      ?? componentTypes[0]
      ?? 'Component';
    return {
      key: `${link.placedId}\u0000${link.slot}\u0000${index}`,
      path: link.path,
      label: signalLinkedSlotLabel(link),
      secondary: leafNodeName(link.path),
      color: componentColor(componentType),
    };
  });
  const referencedRows: TooltipBindingRow[] = (model.boundTo ?? []).map((binding, index) => ({
    key: `${binding.path}\u0000${binding.componentType}\u0000${index}`,
    path: binding.path,
    label: `${binding.componentType} · ${shortNodePath(binding.path)}`,
    color: componentColor(binding.componentType),
  }));
  return (
    <Box sx={{ py: 0.25, lineHeight: 1.4 }}>
      {/* Title — clickable when the signal NODE itself is navigable (plan-246):
          selects the signal object in hierarchy/scene, like the binding rows. */}
      <Typography
        component="div"
        onClick={model.nodePath && viewer
          ? (e) => { e.stopPropagation(); navigateToRef(viewer, model.nodePath!); }
          : undefined}
        sx={{
          fontSize: 11, fontWeight: 700,
          ...(model.nodePath && viewer
            ? { cursor: 'pointer', '&:hover': { color: '#4fc3f7', textDecoration: 'underline' } }
            : {}),
        }}
      >
        {model.name}
      </Typography>
      {/* Liveness, line 2 — fixed position directly under the name (plan-353 F5).
          `activityLabel` was computed and carried in the model since plan-234 but
          never rendered: the tooltip could show a stale value with no hint that
          it was stale. Ungated for the same reason the interface origin is
          ungated — it qualifies the VALUE above it, so hiding it would leave a
          number without its trust level. Deliberately NOT colour-coded: the
          badge dot already carries the colour signal, and a second palette for
          the same fact is how the two start disagreeing. */}
      {model.activityLabel && (
        <Typography
          component="div"
          data-testid="signal-activity-label"
          sx={{ fontSize: 10, opacity: 0.7 }}
        >
          {model.activityLabel}
        </Typography>
      )}
      {fields.value && (
        <Typography component="div" sx={{ fontSize: 10, opacity: 0.85 }}>{valueLine}</Typography>
      )}
      {fields.address && addressLine && (
        <Typography component="div" sx={{ fontSize: 10, opacity: 0.85, fontFamily: 'monospace' }}>
          {addressLine}
        </Typography>
      )}
      {/* Interface origin is a fixed tooltip element per spec (F6) — not gated
          by the address toggle; shown whenever it is resolvable. */}
      {model.interfaceOrigin && (
        <Typography component="div" sx={{ fontSize: 10, opacity: 0.7 }}>
          Interface · {model.interfaceOrigin}
        </Typography>
      )}
      {model.topic && (
        <Typography component="div" sx={{ fontSize: 10, opacity: 0.7, fontFamily: 'monospace' }}>
          Topic · {model.topic}
        </Typography>
      )}
      {/* Manual SignalMapping provenance is structural and therefore intentionally
          independent of the optional decorative `fields.binding` setting.
          Title (plan-353 F4): "Drives these slots" says WHAT the rows are —
          slots this signal writes — and can no longer be read as the reverse
          direction of the "Referenced by" block right below it. */}
      <TooltipBindingBlock title={PROVENANCE_DRIVES_TITLE} rows={driveRows} viewer={viewer} />
      {/* "Referenced by" is the SAME concept as the property inspector's footer
          (components pointing AT this object), so it deliberately keeps the same
          word — one term per thing. Both read it from the vocabulary module. */}
      {fields.binding && (
        <TooltipBindingBlock title={PROVENANCE_REFERENCED_TITLE} rows={referencedRows} viewer={viewer} />
      )}
      {/* Write-authority note (plan-320): who dominates this slot right now.
          Amber matches the force palette — the note most often concerns forces. */}
      {model.authorityNote && (
        <Typography component="div" data-testid="signal-authority-note" sx={{ fontSize: 10, color: FORCE_COLOR }}>
          {model.authorityNote}
        </Typography>
      )}
      {fields.comment && model.comment && (
        <Typography component="div" sx={{ fontSize: 10, opacity: 0.7, fontStyle: 'italic', maxWidth: 240 }}>
          {model.comment}
        </Typography>
      )}
      {model.hint && (
        <Typography component="div" sx={{ fontSize: 9, opacity: 0.5, mt: 0.25 }}>
          {model.hint}
        </Typography>
      )}
    </Box>
  );
}

// ── SignalBadge ───────────────────────────────────────────────────────

/**
 * Chip-style signal badge: "OutBool ●" / "InBool ○" with direction coloring.
 *
 * When `viewer` and `signalName` are supplied the badge becomes interactive:
 * - Bool signals: clicking toggles the force state (see {@link useSignalForce}).
 * - Int/Float signals: clicking opens a small value-entry popover where the
 *   operator types the value to force.
 * A forced signal gets an amber ring + lock icon and shows its pinned value.
 *
 * `raw` is optional: when omitted (undefined) and `viewer` + `signalName` are given,
 * the badge subscribes to the SignalStore and tracks the live value itself — so a
 * plain `<SignalBadge viewer signalName direction plcType />` is a live status chip.
 * Callers that already poll can keep passing `raw` (then no self-subscription runs).
 */
export function SignalBadge({
  direction,
  plcType,
  raw,
  viewer,
  signalName,
  displayName,
  address,
  comment,
  variant,
  dragSource,
  origin,
  relationSource,
}: {
  direction: SignalDirection;
  plcType?: string;
  raw?: boolean | number | undefined;
  viewer?: RVViewer;
  signalName?: string;
  /** When set, the chip includes this name (e.g. "EntryConveyorStart OutBool ○") and
   *  the tooltip titles with it. Use the friendly name; `signalName` stays the store key. */
  displayName?: string;
  /** Protocol address (e.g. "%I0.6") for the tooltip — overrides store meta when given. */
  address?: string;
  /** Comment for the tooltip — overrides store meta when given. */
  comment?: string;
  /** Per-usage display variant override — wins over the global Settings default (plan-246 F3). */
  variant?: SignalChipVariant;
  /** Explicit interface provenance for CONNECT-originated drag sources. */
  dragSource?: { interfaceId: string; topic?: string };
  /**
   * Explicit provenance for the drag payload (plan-341 §2.8 a). Set it wherever
   * the surface knows the answer — the picker does, via `SignalSearchItem`.
   * When absent, the arm path derives it from the CONNECT membership.
   */
  origin?: 'connect' | 'internal';
  /** Optional source rendered before the signal as one source-to-target composite chip. */
  relationSource?: string;
}) {
  const fc = useSignalForce(viewer, signalName);
  const display = useSignalDisplaySettings();
  // Tooltips are globally suppressed while ANY signal drag is in progress (F5).
  const dragActive = useSignalDragActive();
  // Self-track the live value when the caller didn't supply `raw`. Throttled via a
  // shared flush so a list of live badges can't re-render at the signal rate
  // (up to 60 Hz) and starve the sim loop on the main thread. See useThrottledSignalValue.
  const selfLive = raw === undefined && !!viewer?.signalStore && !!signalName;
  const liveRaw = useThrottledSignalValue(
    selfLive ? viewer!.signalStore ?? null : null,
    selfLive ? signalName : undefined,
  );
  const effectiveRaw = raw !== undefined ? raw : (selfLive ? liveRaw : undefined);
  // When forced, the pinned value is authoritative for display.
  const shown = fc.forced ? fc.forcedValue : effectiveRaw;
  const isActive = shown === true;
  const isBool = typeof shown === 'boolean' || shown === undefined;
  // Hue = direction, intensity = state (plan-341 Phase 0). FALSE keeps the
  // direction hue at the `weak` step instead of collapsing to a flat grey;
  // only a genuinely absent reading falls back to the neutral step.
  const valueColor = signalValueColorForValue(direction, shown);
  const color = fc.forced ? FORCE_COLOR : valueColor;
  const valueStr = shown === undefined ? '—'
    : isBool ? (isActive ? '●' : '○')
    : typeof shown === 'number' ? (Number.isInteger(shown) ? String(shown) : shown.toFixed(1))
    : String(shown);
  // Per-usage `variant` prop wins over the global Settings default (F3).
  const effectiveVariant = variant ?? display.chipVariant;
  const labelParts = buildChipLabelParts(effectiveVariant, { displayName, signalName, plcType, direction, valueStr });
  const label = labelParts.name ? `${labelParts.name}  ${labelParts.tail}` : labelParts.tail;
  /** Names give way; readings do not (plan-422 F4). */
  const ELIDE_SX = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
  const labelNode = labelParts.name ? (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.5, minWidth: 0 }}>
      <Box component="span" sx={ELIDE_SX}>{labelParts.name}</Box>
      <Box component="span" sx={{ flexShrink: 0 }}>{labelParts.tail}</Box>
    </Box>
  ) : labelParts.tail;
  const chipLabel = relationSource ? (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, minWidth: 0, whiteSpace: 'nowrap' }}
    >
      <Box component="span" sx={ELIDE_SX}>{relationSource}</Box>
      <ArrowRightAlt data-testid="slot-chain-arrow" sx={{ fontSize: 10, flexShrink: 0 }} />
      <Box component="span" sx={{ minWidth: 0, overflow: 'hidden' }}>{labelNode}</Box>
    </Box>
  ) : labelNode;

  // Numeric signals get a value-entry popover; bool signals toggle directly.
  // `plcType` is authoritative; fall back to the displayed value's runtime type.
  const numeric = plcType ? !isBoolSignal(plcType) : !isBool;
  const intOnly = isIntSignal(plcType);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  // Tooltip open state — the full binding/activity lookup runs ONLY while the
  // tooltip is open (plan-234 §10-F3), never per row-render / 60-Hz tick.
  const [tipOpen, setTipOpen] = useState(false);

  // Pull descriptive metadata (address/source/comment) for tooltip AND drag payload.
  // Explicit address/comment props override the store meta (e.g. picker-supplied).
  const storeMeta = signalName ? viewer?.signalStore?.getSignalMeta(signalName) : undefined;
  const meta = (address !== undefined || comment !== undefined || storeMeta)
    ? { ...storeMeta, address: address ?? storeMeta?.address, comment: comment ?? storeMeta?.comment }
    : undefined;

  const onChipClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    // A click that concluded a Shift+press or a drag must NEVER force (F4).
    if (consumeSignalDragClick()) return;
    if (!fc.enabled) return;
    if (numeric) setAnchorEl(e.currentTarget);
    else fc.toggle();
  }, [fc, numeric]);

  // Shift+pointerdown arms a drag (F4/F8) — every badge with a signalName is a
  // drag source. Movement ≥ 4 px promotes to dragging; a plain Shift+Click
  // (no movement) neither forces nor drags.
  const metaAddress = meta?.address;
  const metaComment = meta?.comment;
  const metaSource = meta?.source;
  /**
   * The drag payload of this chip.
   *
   * Provenance is resolved ONCE, here (plan-341 §2.8 a): the explicit props
   * first (the picker and the CONNECT row both know), CONNECT membership by
   * name as the fallback. A payload without `origin` is refused as
   * `no-provider`, so this is the one place that must not leave it to chance.
   */
  const buildDragPayload = useCallback((name: string) => {
    const explicitInterfaceId = dragSource?.interfaceId;
    const membership = explicitInterfaceId || origin === 'internal'
      ? undefined
      : resolveInterfaceOriginForSignal(name, metaSource, getConnectSnapshot().interfaces);
    const resolvedInterfaceId = explicitInterfaceId ?? membership?.interfaceId;
    // omitUndefined: an optional the source does not have must stay ABSENT.
    // Carried as a present `undefined` it reaches the persisted mapping and
    // the GLB bake refuses the whole file over it (plan-422 F1).
    return omitUndefined({
      name,
      direction,
      plcType,
      address: metaAddress,
      comment: metaComment,
      source: metaSource,
      interfaceId: resolvedInterfaceId,
      // Topic follows its interface (plan-353 F3): from the explicit source when
      // there is one, otherwise from the membership hit — which now reports the
      // MQTT topic it found the signal under instead of dropping it. A dragged
      // signal therefore keeps its topic even when the drag started from a
      // surface that only knew the name.
      topic: explicitInterfaceId ? dragSource?.topic : membership?.topic,
      origin: origin ?? (resolvedInterfaceId ? 'connect' : 'internal'),
    });
  }, [direction, plcType, metaAddress, metaComment, metaSource, origin, dragSource?.interfaceId, dragSource?.topic]);

  /** Pending touch long-press; see {@link onChipPointerDown}. */
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const cancelLongPress = useCallback(() => {
    if (!longPress.current) return;
    clearTimeout(longPress.current.timer);
    longPress.current = null;
  }, []);
  useEffect(() => cancelLongPress, [cancelLongPress]);

  /**
   * One pointerdown, three gestures (plan-422 F6).
   *
   * - **Shift + press** — the historical path, byte for byte: the drag arms
   *   immediately and the trailing click is swallowed whatever happens.
   * - **Plain press (mouse/pen)** — arms too, but `clickOnRelease` keeps the
   *   force click intact for a release that never crossed the threshold. The
   *   event is deliberately NOT `preventDefault`ed here: swallowing it would
   *   take the click with it, which is the very thing being preserved.
   * - **Touch** — no Shift, no hover, and a press that becomes a drag competes
   *   with scrolling. So a LONG press arms it and any movement before the timer
   *   fires hands the gesture back to the scroller. A tap never arms and
   *   reaches the chip as an ordinary click.
   */
  const onChipPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!signalName || e.button !== 0) return;

    if (e.pointerType === 'touch') {
      cancelLongPress();
      const { clientX: x, clientY: y } = e;
      longPress.current = {
        x, y,
        timer: setTimeout(() => {
          longPress.current = null;
          // A long press is a deliberate drag attempt, not a tap — releasing it
          // without movement must not force. Hence no `clickOnRelease`.
          armSignalDrag(buildDragPayload(signalName), x, y);
        }, TOUCH_DRAG_LONG_PRESS_MS),
      };
      return;
    }

    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      armSignalDrag(buildDragPayload(signalName), e.clientX, e.clientY);
      return;
    }

    // stopPropagation, but NOT preventDefault: an ancestor that also arms a
    // drag (the ConnectPanel signal row) would otherwise re-arm over this one
    // and, in re-arming, suppress the very click being preserved. The click
    // event itself is separate and still reaches this chip.
    e.stopPropagation();
    armSignalDrag(buildDragPayload(signalName), e.clientX, e.clientY, { clickOnRelease: true });
  }, [signalName, buildDragPayload, cancelLongPress]);

  /** Movement before the long-press timer fires is a scroll, not a drag. */
  const onChipPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const pending = longPress.current;
    if (!pending) return;
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) >= SIGNAL_DRAG_THRESHOLD_PX) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  const chip = (
    <Chip
      label={chipLabel}
      data-testid={relationSource ? 'slot-chain-chip' : undefined}
      // The whole label in plain text, so an ellipsised name is never a dead
      // end even without the rich tooltip (plan-422 F4).
      title={label}
      size="small"
      onClick={fc.enabled ? onChipClick : undefined}
      onPointerDown={signalName ? onChipPointerDown : undefined}
      onPointerMove={signalName ? onChipPointerMove : undefined}
      onPointerUp={signalName ? cancelLongPress : undefined}
      onPointerCancel={signalName ? cancelLongPress : undefined}
      // Release is a SEPARATE action — the ✕ only appears while forced.
      onDelete={fc.forced ? (e) => { e.stopPropagation(); fc.release(); } : undefined}
      deleteIcon={fc.forced ? <Close sx={{ fontSize: 8 }} /> : undefined}
      sx={{
        height: 16,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        borderRadius: CHIP_RADIUS,
        bgcolor: color + '22',
        color: color,
        border: `${fc.forced ? '1.5px' : '1px'} solid ${color}${fc.forced ? 'cc' : '44'}`,
        flexShrink: 0,
        cursor: fc.enabled ? 'pointer' : 'default',
        ...((displayName || signalName) ? { maxWidth: '100%', minWidth: 0 } : {}),
        '& .MuiChip-label': { px: 0.4, py: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
        '& .MuiChip-deleteIcon': { color: color + 'cc', ml: -0.1, mr: 0.1, '&:hover': { color } },
        ...(fc.enabled && !fc.forced ? { '&:hover': { borderColor: FORCE_COLOR + '88' } } : {}),
      }}
    />
  );

  if (!fc.enabled) return chip;

  // Interaction hint — rendered as the last tooltip line so both gestures are
  // discoverable: click = force, Shift+drag = create a signal link (plan-246).
  const hint = (fc.forced
    ? (numeric ? 'Click to set value, ✕ to release' : 'Click to change value, ✕ to release')
    : (numeric ? 'Click to set forced value' : 'Click to force'))
    + ' · Shift+drag to link';

  // Binding + liveness + interface origin are resolved lazily, ONLY while the
  // tooltip is open — the per-signal registry walk + activity derivation never
  // run on the row/tick path (plan-234 §10-F3 preserved).
  const tooltipModel = useMemo<SignalTooltipModel>(() => {
    let boundTo: Array<{ componentType: string; path: string }> | undefined;
    let linkedSlots: SignalLinkedSlot[] | undefined;
    let activity: SignalActivity | undefined;
    let actLabel: string | undefined;
    let interfaceOrigin: string | undefined;
    let topic: string | undefined;
    let nodePath: string | undefined;
    if (tipOpen && viewer && signalName) {
      const store = viewer.signalStore;
      nodePath = store?.getPath(signalName);
      const refs = viewer.registry?.getComponentsForSignal(signalName, nodePath);
      if (refs && refs.length > 0) {
        boundTo = refs.map((r) => ({ componentType: r.componentType, path: r.sourcePath }));
      }
      linkedSlots = viewer.signalBindingManager?.getLinksForSource().get(signalName);
      if (store) {
        const now = Date.now();
        activity = store.getActivity(signalName, now, getViewerMode());
        const ts = store.getLastUpdateTs(signalName);
        actLabel = activityLabel(activity, ts !== undefined ? now - ts : undefined);
      }
      // Origin: signal membership in the CONNECT snapshot first, source-label
      // fallback. The membership hit now also carries the MQTT topic (plan-353
      // F3), so a signal the tooltip resolved BY NAME shows its topic line too
      // — previously only an explicit drag source could supply one.
      const resolvedOrigin = resolveInterfaceOriginForSignal(
        signalName, meta?.source, getConnectSnapshot().interfaces,
      );
      interfaceOrigin = dragSource?.interfaceId ?? resolvedOrigin?.interfaceId;
      topic = dragSource?.topic ?? resolvedOrigin?.topic;
    }
    // Authority note (plan-320): remote-override hint is computed even while
    // the tooltip is closed (cheap flag reads) so the FORCED chip is never
    // silently overridden; the channel authority lookup stays tip-gated.
    const authorityNote = buildAuthorityNote({
      forced: fc.forced,
      channelAuthority: tipOpen && signalName
        ? describeChannelAuthority(makeSignalChannelId(signalName))
        : undefined,
      remoteOverridesForce: remoteWriteOverridesForce(),
    });
    return buildSignalTooltipModel({
      name: displayName ?? signalName ?? '',
      plcType,
      direction,
      shown,
      forced: fc.forced,
      meta,
      hint,
      boundTo,
      linkedSlots,
      activity,
      activityLabel: actLabel,
      interfaceOrigin,
      topic,
      nodePath,
      authorityNote,
    });
    // shown/fc.forced/meta are display inputs; tipOpen gates the heavy lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tipOpen,
    viewer,
    signalName,
    displayName,
    plcType,
    direction,
    shown,
    fc.forced,
    storeMeta,
    address,
    comment,
    hint,
    dragSource?.interfaceId,
    dragSource?.topic,
  ]);

  // The tooltip is only worth keeping open (interactive + leaveDelay) when it
  // actually contains something clickable: a navigable signal node title or
  // binding rows. Otherwise it closes immediately on leave and lets pointer
  // events through — a purely informative tooltip must never block the rows
  // beneath it.
  const tooltipClickable = !!viewer
    && (
      !!tooltipModel.nodePath
      || (tooltipModel.linkedSlots?.length ?? 0) > 0
      || (display.tooltip.binding && (tooltipModel.boundTo?.length ?? 0) > 0)
    );

  return (
    <>
      <Tooltip
        title={<SignalTooltipContent model={tooltipModel} viewer={viewer} fields={display.tooltip} />}
        // Interactive (plan-246 F7) ONLY while clickable content exists: the
        // cursor may move into the tooltip to click binding rows; a moderate
        // leaveDelay keeps it from vanishing on the way over. Controlled open
        // enforces the global drag suppression (F5).
        // enterDelay/enterNextDelay: scanning quickly across a signal list must
        // not spawn tooltips that then sit over the neighboring rows — the rich
        // tooltip only opens after a deliberate dwell, and never instantly on
        // the next chip after one was open.
        // Right placement: signal lists live in left-docked panels, so the tooltip
        // opens over the 3D scene instead of covering the rows below the cursor.
        placement="right"
        open={tipOpen && !dragActive}
        enterDelay={450}
        enterNextDelay={450}
        disableInteractive={!tooltipClickable}
        leaveDelay={tooltipClickable ? 150 : 0}
        onOpen={() => setTipOpen(true)}
        onClose={() => setTipOpen(false)}
      >
        {chip}
      </Tooltip>
      {numeric && (
        <ForceValuePopover
          anchorEl={anchorEl}
          onClose={() => setAnchorEl(null)}
          // Prefill with the current (forced or live) numeric value.
          current={typeof shown === 'number' ? shown : 0}
          intOnly={intOnly}
          onForce={(v) => { void fc.force(v); }}
        />
      )}
    </>
  );
}

// ── ForceValuePopover ─────────────────────────────────────────────────

/**
 * Small inline value-entry popover anchored to a numeric signal chip.
 * Prefilled with the current/forced value; Enter or "Force" submits, Escape or
 * an outside click cancels. Empty/invalid input does not force.
 */
function ForceValuePopover({ anchorEl, onClose, current, intOnly, onForce }: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  current: number;
  intOnly: boolean;
  onForce: (value: number) => void;
}) {
  const open = anchorEl !== null;
  const [text, setText] = useState<string>('');

  // Reset the field to the current value each time the popover opens.
  useEffect(() => {
    if (open) {
      setText(intOnly ? String(Math.round(current)) : String(current));
    }
  }, [open, current, intOnly]);

  const parse = useCallback((s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return intOnly ? Math.round(n) : n;
  }, [intOnly]);

  const submit = useCallback(() => {
    const v = parse(text);
    if (v === null) return;  // empty/invalid → no force
    onForce(v);
    onClose();
  }, [parse, text, onForce, onClose]);

  const valid = parse(text) !== null;

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      // Stop the click reaching the badge row / scene behind it.
      onClick={(e) => e.stopPropagation()}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, p: 1 }}>
        <TextField
          autoFocus
          type="text"
          size="small"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          inputProps={{ inputMode: intOnly ? 'numeric' : 'decimal' }}
          sx={{ width: 110, '& input': { fontSize: 13, py: 0.5 } }}
        />
        <Button
          size="small"
          variant="contained"
          color="warning"
          disabled={!valid}
          onClick={submit}
          sx={{ textTransform: 'none', minWidth: 0 }}
        >
          Force
        </Button>
      </Box>
    </Popover>
  );
}

// ── SignalRow ─────────────────────────────────────────────────────────

/** Label on left, SignalBadge on right. Pass `viewer` + `signalName` to enable click-to-force. */
export function SignalRow({ label, direction, plcType, raw, viewer, signalName }: {
  label: string;
  direction: SignalDirection;
  plcType?: string;
  raw: boolean | number | undefined;
  viewer?: RVViewer;
  signalName?: string;
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, minHeight: 18 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
      <SignalBadge direction={direction} plcType={plcType} raw={raw} viewer={viewer} signalName={signalName} />
    </Box>
  );
}

// ── useSignalValues hook ─────────────────────────────────────────────

export interface SignalInfo {
  value: string;
  raw: boolean | number | undefined;
  direction: SignalDirection;
  plcType: string;
}

/** True when two polled snapshots are indistinguishable for every consumer.
 *  `Object.is` on `raw` so a NaN float reading does not read as "changed". */
function signalValueMapsEqual(
  a: ReadonlyMap<string, SignalInfo>,
  b: ReadonlyMap<string, SignalInfo>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [name, next] of b) {
    const prev = a.get(name);
    if (!prev) return false;
    if (!Object.is(prev.raw, next.raw)) return false;
    if (prev.value !== next.value) return false;
    if (prev.direction !== next.direction) return false;
    if (prev.plcType !== next.plcType) return false;
  }
  return true;
}

/** Poll signal values with direction/type info for a list of signal names.
 *
 *  Returns the SAME Map reference while nothing changed (plan-344 Phase 3.2).
 *  Before that, every 200-ms tick built a fresh Map and committed it
 *  unconditionally, so the new reference re-rendered every consumer
 *  (`rv-metadata-field-renderer`, `MetadataTooltipContent`) 5×/s even on a
 *  completely idle model. Same pattern as `useThrottledSignalValue`. */
export function useSignalValues(viewer: RVViewer, signalNames: string[]): Map<string, SignalInfo> {
  const [values, setValues] = useState<Map<string, SignalInfo>>(new Map());

  const sigMeta = useMemo(() => {
    const map = new Map<string, { direction: SignalDirection; plcType: string }>();
    for (const name of signalNames) {
      map.set(name, resolveSignalInfo(viewer, name));
    }
    return map;
  }, [viewer, signalNames.join(',')]);

  const formatSignal = useCallback((raw: boolean | number | undefined): string => {
    if (raw === undefined) return '—';
    if (typeof raw === 'boolean') return raw ? 'True' : 'False';
    if (typeof raw === 'number') {
      return Number.isInteger(raw) ? String(raw) : raw.toFixed(2);
    }
    return String(raw);
  }, []);

  useEffect(() => {
    if (signalNames.length === 0) return;
    const tick = () => {
      const next = new Map<string, SignalInfo>();
      for (const name of signalNames) {
        const raw = viewer.signalStore?.get(name);
        const meta = sigMeta.get(name);
        next.set(name, {
          value: formatSignal(raw),
          raw,
          direction: meta?.direction ?? 'unknown',
          plcType: meta?.plcType ?? '',
        });
      }
      // Keep the previous reference when nothing changed — a new Map identity is
      // what makes consumers re-render, so it must mean "something changed".
      setValues((prev) => (signalValueMapsEqual(prev, next) ? prev : next));
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, signalNames.join(','), formatSignal, sigMeta]);

  return values;
}
