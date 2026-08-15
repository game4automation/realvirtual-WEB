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

/**
 * Run `body` with `trust` installed, and restore the previous context
 * afterwards — on the error path too.
 *
 * The restore is the part worth centralising. A viewer left stuck in
 * "untrusted" after a foreign load failed would silently refuse to auto-connect
 * for every legitimate model afterwards, and that failure is invisible: nothing
 * breaks, things just quietly stop happening. One implementation, one `finally`,
 * one test.
 */
export async function withLoadTrust<T>(
  slot: TrustSlot,
  trust: LoadTrustContext | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const previous = slot.get();
  slot.set(trust ?? TRUSTED_LOAD);
  try {
    return await body();
  } finally {
    slot.set(previous);
  }
}
