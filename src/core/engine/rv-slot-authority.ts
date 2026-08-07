// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-slot-authority.ts — slot-level write-authority service (plan-320).
 *
 * Names WHO may write a slot: the component as the local stand-in for the
 * missing PLC (`component`), a bound CONNECT source (`bound`), or the operator
 * force (`forced`). Remote ownership (multiuser) stays a SEPARATE upstream
 * layer (plan-320 Phase 3) — it is NOT a fifth authority value.
 *
 * Structure (all module-level registries, axis-ownership pattern):
 *  - **SlotId / SignalChannelId** — branded string keys. A SlotId is the
 *    NUL-separated 4-tuple `elementId \u0000 componentPath \u0000 componentType
 *    \u0000 slot` (same `\u0000` convention as `bindingKey()`/`ownerKey` in
 *    rv-signal-binding-manager.ts — node names regularly contain spaces, so
 *    NUL is the only collision-free separator). `makeSlotId()` is called ONLY
 *    on bind/unbind/claim; the result is cached on the binding/claim entry —
 *    NEVER in the 60 Hz tick().
 *  - **Bidirectional slot↔channel index** — `SlotId → SignalChannelId`
 *    (fan-out explicit) plus an incrementally maintained reverse index
 *    `SignalChannelId → SlotId[]` (required by the Phase-4 shadow gate:
 *    writes arrive at channel level).
 *  - **Claim/release registry** — latent claim STACK per slot: `forced`
 *    overlays `bound` without destroying it; releasing the force restores
 *    `bound` (the redispatch itself stays with the binding manager's
 *    `wasForced` edge). `component` is the claimless default; `none` exists
 *    only for slots without a component (pure `deriveSlotAuthority`).
 *  - **Live-control gate** — the former rv-live-control.ts global set plus the
 *    `liveControlled` instance-flag registrar. Per-tick READERS
 *    (rv-transport-manager sensor grid skip, rv-drives-playback gates,
 *    RVSensor/RVDriveSimple init closures) keep reading their cached boolean
 *    instance field — the service updates the flag on claim/release; no
 *    service lookup or string building happens in any tick.
 *
 * Lifecycle: the STATE OWNER is `rv-viewer.ts` — it calls
 * {@link resetSlotAuthority} unconditionally in its model-switch path
 * (`clearModel()`), NOT via the conditionally gated SignalBindingManager
 * re-creation in `loadModel()`. (The template registries rv-axis-ownership /
 * rv-live-control historically had their reset functions called only from
 * test `afterEach` — this service is actively wired instead.)
 */

// ─── Branded key types ───────────────────────────────────────────────────────

/** Canonical slot identity: elementId \u0000 componentPath \u0000 componentType \u0000 slot. */
export type SlotId = string & { readonly __rvSlotId: unique symbol };

/** Value/force/provider channel identity — the SignalStore signal NAME. */
export type SignalChannelId = string & { readonly __rvSignalChannelId: unique symbol };

/** NUL separator — codebase convention (bindingKey()/ownerKey, provider keys). */
export const SLOT_ID_SEPARATOR = '\u0000';

/**
 * Build the canonical SlotId. `componentType` is folded INTO the key (binding
 * decision: no fourth persistence field — persisted `SignalMapping`s stay at
 * componentPath + slot and the type is re-derived from the active registry
 * instance on reload). Callers pass '' when no registry instance is resolvable
 * (defined, non-throwing fallback for legacy mappings).
 *
 * Allocation rule (ownerKey template): call ONLY on bind/unbind/claim and cache
 * the result — never in the 60 Hz tick().
 */
export function makeSlotId(
  elementId: string,
  componentPath: string,
  componentType: string,
  slot: string,
): SlotId {
  return (
    elementId + SLOT_ID_SEPARATOR
    + componentPath + SLOT_ID_SEPARATOR
    + componentType + SLOT_ID_SEPARATOR
    + slot
  ) as SlotId;
}

/** Brand a SignalStore signal name as a channel id. */
export function makeSignalChannelId(signalName: string): SignalChannelId {
  return signalName as SignalChannelId;
}

/**
 * Writer id of the SignalBindingManager relay — the ONE local writer that is
 * expected on a 'bound' slot. Shared between the binding manager and the
 * Phase-4 shadow write gate so the relay is never flagged against its own
 * claim.
 */
export const SIGNAL_BINDING_RELAY_WRITER_ID = 'component:signal-binding-manager';

// ─── Remote-ownership layer + authority ranking (plan-320 Phase 3) ───────────

/**
 * Rollout flag for the remote-vs-force ranking (plan-320 Phase 3):
 *  - `strict` (default) — `remote > forced`: while a remote session owner is
 *    active, remote writes override operator forces (target ranking
 *    `remote > forced > bound > component`).
 *  - `legacy` — the pre-plan-320 behavior (`forced > remote`): the store's
 *    force check drops remote writes like any other interface update. Pure
 *    rollback lever, no code revert needed.
 */
export type AuthorityRanking = 'strict' | 'legacy';

let _authorityRanking: AuthorityRanking = 'strict';

/** Configure the remote-vs-force ranking (viewer options; default 'strict'). */
export function setAuthorityRanking(ranking: AuthorityRanking): void {
  _authorityRanking = ranking;
}

/** The currently configured remote-vs-force ranking. */
export function getAuthorityRanking(): AuthorityRanking {
  return _authorityRanking;
}

/**
 * Whether a remote session owner currently pre-empts local write authority.
 *
 * Remote ownership is the UPSTREAM layer above the slot authority union — it
 * is NOT a fifth authority value (binding decision). The MultiuserPlugin
 * raises the flag BEFORE the first snapshot signal dispatch (atomic snapshot,
 * R4-1) and it stays raised across transport drops until the session is left
 * (deterministic reconnect state); `resetSlotAuthority()` clears it on every
 * model switch so a new model never inherits foreign ownership (9.8).
 */
let _remoteOwnershipActive = false;

/** Raise/clear the upstream remote-ownership layer (MultiuserPlugin). */
export function setRemoteOwnershipActive(active: boolean): void {
  _remoteOwnershipActive = active;
}

/** True while a remote session owner pre-empts local write authority. */
export function isRemoteOwnershipActive(): boolean {
  return _remoteOwnershipActive;
}

/**
 * True when a remote write may pass through an operator force — the central
 * ranking decision (`remote > forced` under 'strict' with an active remote
 * owner). Consulted by the SignalStore ONLY in its already-forced branch
 * (hot-path rule: no ranking lookup on ordinary writes) and by the force UI
 * for the "overridden by remote owner" hint.
 */
export function remoteWriteOverridesForce(): boolean {
  return _remoteOwnershipActive && _authorityRanking === 'strict';
}

// ─── Bidirectional slot ↔ channel index ─────────────────────────────────────

const _slotToChannel = new Map<SlotId, SignalChannelId>();
const _channelToSlots = new Map<SignalChannelId, SlotId[]>();

/**
 * Register (or move) the channel a slot writes/reads. Maintains the reverse
 * index incrementally — two slots on one channel are two entries with the
 * same channel (fan-out explicit, test 9.2).
 */
export function registerSlotChannel(slotId: SlotId, channelId: SignalChannelId): void {
  const previous = _slotToChannel.get(slotId);
  if (previous === channelId) return;
  if (previous !== undefined) removeReverse(previous, slotId);
  _slotToChannel.set(slotId, channelId);
  let slots = _channelToSlots.get(channelId);
  if (!slots) {
    slots = [];
    _channelToSlots.set(channelId, slots);
  }
  slots.push(slotId);
}

/** Remove a slot from both index directions. */
export function unregisterSlotChannel(slotId: SlotId): void {
  const channel = _slotToChannel.get(slotId);
  if (channel === undefined) return;
  _slotToChannel.delete(slotId);
  removeReverse(channel, slotId);
}

function removeReverse(channel: SignalChannelId, slotId: SlotId): void {
  const slots = _channelToSlots.get(channel);
  if (!slots) return;
  const idx = slots.indexOf(slotId);
  if (idx >= 0) slots.splice(idx, 1);
  if (slots.length === 0) _channelToSlots.delete(channel);
}

/** The channel a slot is indexed against, or undefined. */
export function channelForSlot(slotId: SlotId): SignalChannelId | undefined {
  return _slotToChannel.get(slotId);
}

/** All slots indexed against a channel (fan-out view). Never undefined. */
export function slotsForChannel(channelId: SignalChannelId): readonly SlotId[] {
  return _channelToSlots.get(channelId) ?? EMPTY_SLOTS;
}

const EMPTY_SLOTS: readonly SlotId[] = [];

// ─── Authority derivation (pure) ─────────────────────────────────────────────

/**
 * Who currently writes a slot.
 *  - `none`      — slot without a component (nothing local would write it).
 *  - `component` — claimless default: the component simulates the missing PLC.
 *  - `bound`     — a live CONNECT/internal binding overrides the component.
 *  - `forced`    — operator force overlays everything below (latent stack).
 */
export type SlotAuthority = 'none' | 'component' | 'bound' | 'forced';

/** Input to {@link deriveSlotAuthority} — plain data, no service lookup. */
export interface SlotAuthorityState {
  /** Whether a component exists for the slot (false → 'none'). */
  hasComponent: boolean;
  /** Whether a live binding currently claims the slot. */
  bound: boolean;
  /** Whether an operator force currently overlays the slot. */
  forced: boolean;
}

/**
 * Pure authority derivation (type style of rv-signal-activity.ts). The
 * ranking within this service is `forced > bound > component`; the upstream
 * remote-ownership layer (Phase 3) is consulted by callers, never encoded as
 * a fifth value here.
 */
export function deriveSlotAuthority(state: SlotAuthorityState): SlotAuthority {
  if (!state.hasComponent) return 'none';
  if (state.forced) return 'forced';
  if (state.bound) return 'bound';
  return 'component';
}

// ─── Claim/release registry (latent stack) ───────────────────────────────────

interface SlotClaims {
  bound: boolean;
  forced: boolean;
}

const _claims = new Map<SlotId, SlotClaims>();

function claimsFor(slotId: SlotId): SlotClaims {
  let claims = _claims.get(slotId);
  if (!claims) {
    claims = { bound: false, forced: false };
    _claims.set(slotId, claims);
  }
  return claims;
}

function pruneClaims(slotId: SlotId, claims: SlotClaims): void {
  if (!claims.bound && !claims.forced) _claims.delete(slotId);
}

/** A live binding takes the slot ('bound'). Idempotent. */
export function claimBound(slotId: SlotId): void {
  claimsFor(slotId).bound = true;
}

/** The binding released the slot (unbind/disconnect) — falls back to 'component'. */
export function releaseBound(slotId: SlotId): void {
  const claims = _claims.get(slotId);
  if (!claims) return;
  claims.bound = false;
  pruneClaims(slotId, claims);
}

/**
 * Operator force overlays the slot ('forced') — a LATENT claim: an underlying
 * 'bound' claim is kept, not displaced. Idempotent.
 */
export function claimForced(slotId: SlotId): void {
  claimsFor(slotId).forced = true;
}

/**
 * Force released — restores 'bound' when the binding claim is still present
 * (latent stack, wasForced template). The value redispatch after unforce is
 * the binding manager's job, not this registry's.
 */
export function releaseForced(slotId: SlotId): void {
  const claims = _claims.get(slotId);
  if (!claims) return;
  claims.forced = false;
  pruneClaims(slotId, claims);
}

/**
 * Current authority of a slot. `component` is the claimless default — 'none'
 * (no component at all) is only derivable via {@link deriveSlotAuthority}
 * because this registry only ever learns about slots that have components.
 */
export function getSlotAuthority(slotId: SlotId): SlotAuthority {
  const claims = _claims.get(slotId);
  if (!claims) return 'component';
  if (claims.forced) return 'forced';
  if (claims.bound) return 'bound';
  return 'component';
}

/** Diagnostics/tests: number of slots with at least one active claim. */
export function claimedSlotCount(): number {
  return _claims.size;
}

/** UI summary of the dominating authority on a value channel (plan-320 Phase 5). */
export interface ChannelAuthorityInfo {
  /** Highest authority among the slots indexed against the channel. */
  authority: SlotAuthority;
  /** True when the upstream remote-ownership layer pre-empts local writers. */
  remoteOwned: boolean;
}

/**
 * Dominating authority of a channel for UI display (badge/tooltip/popover):
 * the highest-ranking claim among all slots bound onto the channel
 * (`forced > bound > component`), plus the upstream remote-ownership flag.
 * Returns null when no slot is indexed against the channel (nothing claimed
 * a slot writing this signal). Display-path only — never called per tick.
 */
export function describeChannelAuthority(channelId: SignalChannelId): ChannelAuthorityInfo | null {
  const slots = _channelToSlots.get(channelId);
  if (!slots || slots.length === 0) return null;
  let highest: SlotAuthority = 'component';
  for (const slotId of slots) {
    const authority = getSlotAuthority(slotId);
    if (authority === 'forced') { highest = 'forced'; break; }
    if (authority === 'bound') highest = 'bound';
  }
  return { authority: highest, remoteOwned: _remoteOwnershipActive };
}

// ─── Live-control gate (migrated from rv-live-control.ts) ────────────────────

/** Set of instance-scoped signal names currently under live control. */
const _controlled = new Set<string>();

/** Mark or unmark a scoped signal name as live-controlled. */
export function setSignalLiveControlled(scopedName: string, controlled: boolean): void {
  if (controlled) _controlled.add(scopedName);
  else _controlled.delete(scopedName);
}

/** True when the given instance-scoped signal name is currently live-controlled. */
export function isSignalLiveControlled(scopedName: string): boolean {
  return _controlled.size > 0 && _controlled.has(scopedName);
}

/**
 * True when ANY live-controlled signal name starts with `prefix` — the generic
 * "is this component wired?" check. A placed component scopes ALL its signals
 * with `<root>.`, so `prefix = '<root>.'` matches exactly its own signals (and
 * never a sibling `<root>_2.`). Empty prefix (standalone, no LayoutObject
 * scope) → true when anything at all is live-controlled.
 *
 * SDK contract surface: `self.isWired` (material-flow-self.ts) delegates here —
 * signature and semantics are frozen for third-party behaviors.
 */
export function isAnyLiveControlled(prefix: string): boolean {
  if (_controlled.size === 0) return false;
  if (!prefix) return true;
  for (const name of _controlled) if (name.startsWith(prefix)) return true;
  return false;
}

/** Number of live-controlled signals (fast "any active?" check + test aid). */
export function liveControlledCount(): number {
  return _controlled.size;
}

/** Clear all live-control state. Used on service reset / test reset. */
export function clearLiveControl(): void {
  _controlled.clear();
}

// ─── liveControlled instance-flag registrar (hot-path read rule) ─────────────

/** Minimal shape of components/drives carrying a cached liveControlled flag. */
export interface LiveControlledCarrier {
  liveControlled?: boolean;
}

/**
 * Instances whose `liveControlled` flag was raised through the service —
 * tracked so {@link resetSlotAuthority} can clear stale flags on a model
 * switch even when the owning manager's dispose path was skipped.
 */
const _flaggedInstances = new Set<LiveControlledCarrier>();

/**
 * Update the cached boolean `liveControlled` field of a component/drive
 * instance. Per-tick readers keep reading the plain field (no service lookup,
 * no string building in the tick) — the service only maintains the flag on
 * claim/release and remembers raised flags for the model-switch reset.
 */
export function setInstanceLiveControlled(
  instance: LiveControlledCarrier | null | undefined,
  controlled: boolean,
): void {
  if (!instance) return;
  instance.liveControlled = controlled;
  if (controlled) _flaggedInstances.add(instance);
  else _flaggedInstances.delete(instance);
}

// ─── Model-switch reset (state owner: rv-viewer.ts) ─────────────────────────

/**
 * Unconditional full reset — claims, slot↔channel indexes, live-control gate,
 * raised instance flags. Wired ACTIVELY into the model-switch path of
 * `rv-viewer.ts` (`clearModel()`), independent of any feature-flag gating.
 */
export function resetSlotAuthority(): void {
  _claims.clear();
  _slotToChannel.clear();
  _channelToSlots.clear();
  _controlled.clear();
  for (const instance of _flaggedInstances) instance.liveControlled = false;
  _flaggedInstances.clear();
  // Phase 3: a model switch never inherits foreign remote ownership (9.8).
  // The RANKING config is intentionally NOT reset — it is viewer configuration,
  // not model state.
  _remoteOwnershipActive = false;
}
