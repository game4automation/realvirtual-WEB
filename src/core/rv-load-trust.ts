// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Where the bytes of a load came from, in trust terms (plan-386 F17).
 *
 * A leaf module on purpose: everything that has to *ask* about trust — the
 * interface manager, the CONNECT plugin, the share boot — can import this
 * without dragging in the viewer, and the rule itself can be tested without
 * standing up a renderer.
 *
 * ## Why a load parameter and not a store flag
 *
 * The side effects this exists to prevent happen **during** the load, one
 * layer down: the signal binding manager is constructed and the logic systems
 * are attached before `loadModel()` ever returns (R10). A flag set afterwards
 * would arrive too late by construction.
 *
 * ## Second condition, not a replacement
 *
 * This sits *next to* the plan-397 signature chain (`signatureState` /
 * `allowUntrustedLogic` / gated frames), not in place of it. An unsigned
 * foreign GLB has `signatureState: 'none'` and is therefore invisible to the
 * signature gate: "nobody vouched for where this came from" is a different
 * question from "is this signature valid", and both must be able to hold the
 * brake.
 *
 * ## What it gates, and what it deliberately does not
 *
 * It gates every path that reaches **out of the tab**: interface auto-connect,
 * the CONNECT gateway's per-model WebSocket stream, and the construction of the
 * `SignalBindingManager` that binds model slots to live external signals.
 *
 * It does **not** stop the local simulation. A shared link exists so the
 * receiver stands in front of a *running* machine (Entscheidungs-Log:
 * *Kinematik im Viewer — ja, Simulation läuft*); drives, logic steps and
 * transport run entirely inside the page and touch nothing outside it.
 * Freezing them would remove the feature in the name of protecting it.
 */

export type LoadTrustContext = {
  /** `false` for content arriving via `?glb=` — see above. */
  trusted: boolean;
  /** Host the bytes came from, for the origin badge and log lines. */
  sourceOrigin?: string;
};

/** Shared frozen default, so every pre-existing caller keeps today's behaviour. */
export const TRUSTED_LOAD: LoadTrustContext = Object.freeze({ trusted: true });

/** Read/write access to whichever field holds the in-flight context. */
export interface TrustSlot {
  get(): LoadTrustContext;
  set(next: LoadTrustContext): void;
}

/** One open `withLoadTrust` scope. */
type TrustScope = { readonly token: symbol; readonly trust: LoadTrustContext };

/**
 * The open scopes per slot, plus the value the slot held before the FIRST of
 * them opened. Module-level and keyed by the slot object so the stack costs the
 * slot's owner nothing — a `TrustSlot` stays the two-method accessor it is.
 */
const _scopeStacks = new WeakMap<TrustSlot, { base: LoadTrustContext; scopes: TrustScope[] }>();

/**
 * Run `body` with `trust` installed, and take that context back out afterwards
 * — on the error path too.
 *
 * ## Why a scope STACK and not a `previous` snapshot (plan-442 F6)
 *
 * The obvious implementation — remember `slot.get()`, restore it in a
 * `finally` — is correct only while scopes nest. Loads do not always nest: a
 * second `loadModel()` can start while the first is still inside `loadGLB`, and
 * then the two scopes OVERLAP. With a snapshot the older run's exit restores a
 * value the newer run is still using, and the newer run's exit restores the
 * OLDER run's context instead of the original one:
 *
 * ```
 * base A → run 1 opens C1 → run 2 snapshots previous = C1, opens C2
 *        → run 1 exits, restores A   (C2 is silently gone, run 2 still running)
 *        → run 2 exits, restores C1  (the slot ends on C1, never A)
 * ```
 *
 * That is not a cosmetic drift: the slot decides whether interfaces
 * auto-connect and whether a `SignalBindingManager` is built, so a viewer
 * stranded in the wrong trust context either reaches out of the tab when it
 * should not, or quietly stops doing so forever. Token-gating the restore does
 * not fix it — it only turns the second wrong write into no write at all,
 * leaving C1 standing.
 *
 * So the slot keeps a stack instead: entering pushes, leaving removes THIS
 * scope wherever it sits, and the slot always shows the newest scope still
 * open — or, when the last one closes, the value from before the first one
 * opened. Both completion orders end on the base value, nested use behaves
 * exactly as it always did, and a throwing body still leaves through the
 * `finally`.
 *
 * That the older, overtaken run reads the younger run's context while both are
 * open is the intended reading of latest-wins: its trust-dependent decisions
 * are discarded together with the run itself.
 */
export async function withLoadTrust<T>(
  slot: TrustSlot,
  trust: LoadTrustContext | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const token = Symbol('rv-load-trust-scope');
  enterLoadTrustScope(slot, token, trust ?? TRUSTED_LOAD);
  try {
    return await body();
  } finally {
    exitLoadTrustScope(slot, token);
  }
}

/** Open a trust scope. Exported for tests; production code uses {@link withLoadTrust}. */
export function enterLoadTrustScope(
  slot: TrustSlot,
  token: symbol,
  trust: LoadTrustContext,
): void {
  let state = _scopeStacks.get(slot);
  if (!state) {
    // First scope on this slot — whatever it holds now is what the last exit
    // has to put back.
    state = { base: slot.get(), scopes: [] };
    _scopeStacks.set(slot, state);
  }
  state.scopes.push({ token, trust });
  slot.set(trust);
}

/** Close the trust scope opened under `token`, wherever it sits in the stack. */
export function exitLoadTrustScope(slot: TrustSlot, token: symbol): void {
  const state = _scopeStacks.get(slot);
  if (!state) return;
  const i = state.scopes.findIndex((s) => s.token === token);
  if (i < 0) return;
  state.scopes.splice(i, 1);
  if (state.scopes.length === 0) {
    slot.set(state.base);
    // Dropped rather than kept with an empty stack, so the next first scope
    // captures the base value as it is THEN.
    _scopeStacks.delete(slot);
    return;
  }
  slot.set(state.scopes[state.scopes.length - 1].trust);
}
