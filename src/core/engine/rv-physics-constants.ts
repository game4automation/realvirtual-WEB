// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// Physics-zone handover constants (plan-276), fixed empirically by the
// Phase-0 spike `tests/physics-spike-handover.test.ts` (real Rapier 0.19.3
// WASM, 60 Hz fixed timestep). Public module — MUST NOT import Rapier
// (the provider is private and its npm dependency is out-of-band, § 2.8).

/**
 * Linear-velocity threshold (m/s) below which a dynamic body counts as
 * "at rest" for the physics→kinematic handover (F7).
 *
 * Spike measurement (0.4 m drop with 0.5 m/s belt velocity, default friction,
 * restitution 0): after touchdown |linvel| collapses from ~2.8 m/s to <0.01 m/s
 * within ~4 ticks; thresholds 0.005 and 0.01 fired on identical ticks, so the
 * choice is not sensitive in this range. 0.01 m/s (0.17 mm per tick at 60 Hz —
 * visually stationary) keeps headroom over solver noise without delaying the
 * handover. No tested threshold (up to 0.05) ever fired mid-flight or at impact.
 */
export const PHYSICS_SETTLE_LIN_VEL = 0.01; // m/s

/**
 * Number of CONSECUTIVE ticks |linvel| must stay below
 * {@link PHYSICS_SETTLE_LIN_VEL} before a body counts as settled.
 *
 * Spike measurement: with 10 frames the detector fires ~13 ticks (~0.22 s)
 * after touchdown — 5 frames would only save ~5 ticks but is less robust
 * against contact rattling in multi-body/stacking scenes (the spike covers the
 * single-body best case); 15 frames adds latency without extra safety. All
 * combinations fired well within 60 ticks of touchdown and never during flight.
 */
export const PHYSICS_SETTLE_FRAMES = 10; // consecutive ticks

/**
 * Maximum angle (degrees) between the body-local up axis and world up for a
 * settled MU to return to the kinematic pipeline (F7). Bodies beyond the
 * tolerance stay physicsOwned and remain lying (v1 semantics).
 *
 * Spike validation: a cube resting on a 30° ramp measures 30.49°, a cube
 * resting flat measures 0.00° — 25° separates both states with >5° margin.
 */
export const PHYSICS_UPRIGHT_TOLERANCE_DEG = 25; // degrees (F7)

/**
 * Fixed physics timestep (s). Must equal the simulation-loop accumulator step;
 * set once via `world.timestep` — Rapier's `world.step()` takes no dt argument.
 */
export const PHYSICS_FIXED_DT = 1 / 60; // s

// ── Zone robustness (plan-428) ──────────────────────────────────────────────

/**
 * Thickness (m) of the automatic floor plate under the SYNTHETIC WholeScene
 * zone. A real thickness (not a zero-height plane) is mandatory: rapier3d has
 * no half-space collider, and a paper-thin static box is tunnelled by fast
 * bodies. 5 cm is well above the per-tick travel of a body falling at the
 * scene's typical drop heights at 60 Hz.
 */
export const PHYSICS_FLOOR_THICKNESS = 0.05; // m

/**
 * x/z margin (m) the floor plate extends BEYOND the scene AABB, so an MU that
 * leaves the model footprint sideways still lands on the plate instead of
 * dropping past its edge into the RemoveBelowY guard.
 */
export const PHYSICS_FLOOR_MARGIN = 0.5; // m

/**
 * An implicit static box is DISCARDED when its extent reaches this fraction of
 * the scene extent in at least TWO comparable axes (see
 * {@link PHYSICS_SCENE_AXIS_EPSILON}). Broken CAD collider scales produce
 * scene-filling boxes that every MU spawns inside — Rapier's depenetration then
 * shoots the body out at several m/s. Legitimate large geometry (a modelled
 * hall floor) spans the scene in at most one axis pair with real thickness, so
 * 0.9 discriminates without touching authored colliders.
 */
export const PHYSICS_STATIC_BOX_MAX_SCENE_FRACTION = 0.9;

/**
 * A scene axis only counts as COMPARABLE for the oversize guard when its extent
 * is finite and greater than this epsilon (m). Empty (`Box3.empty()`) or planar
 * bounding boxes would otherwise make every box look scene-spanning — with
 * fewer than two comparable axes the guard fails OPEN (box is registered).
 */
export const PHYSICS_SCENE_AXIS_EPSILON = 0.001; // m
