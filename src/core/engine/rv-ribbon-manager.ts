// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-manager.ts — viewer-owned fixed-update registry for `RibbonPath`
 * components (plan-459, reworked for sections by plan-460).
 *
 * Same shape as {@link ChainManager} and `EnergyChainManager`: the viewer owns
 * the instance, threads it through `ComponentContext` / `RuntimeNodeDeps`, and
 * the components register THEMSELVES. Two call sites, and their order is
 * load-bearing:
 *
 * - `CoreSubsystems.visuals()` calls {@link update} AFTER `drives()`, so the
 *   surface speed of this tick comes from the drive POSITION of this tick. That
 *   ordering is the whole reason a driven roller can read `(pos - last) / dt`
 *   and get a signed speed without a one-tick lag.
 * - `RVViewer.resetSimulation()` calls {@link resetAll} AFTER the `drive.reset()`
 *   loop, never from the `simulation-reset` event, which fires before them.
 *
 * ## Web groups
 *
 * A slitter is N `RibbonPath`s sharing one unwinder. If every path integrated
 * "its" winders on its own, a shared unwinder would lose N times the length per
 * tick, and an empty roll would stop only the path that happened to notice first.
 *
 * So paths that share ANY roller form ONE group (union-find, rebuilt on every
 * register/unregister). Per group and tick:
 *
 *   1. sample every roller's drive ONCE (a roller shared by three strips is read
 *      once and all three see the same number);
 *   2. read each path's SECTION speeds from its driven rollers;
 *   3. clamp: a winder that is empty or full zeroes EVERY section of the whole
 *      group in the same tick; a dancer at a stop clamps DIRECTIONALLY (see
 *      `RVRibbonDancer.clampSpeeds`);
 *   4. integrate each dancer and each winder exactly ONCE, through its owner
 *      (the path with the lexicographically smallest node path — a deterministic
 *      tie-break that does not depend on registration order);
 *   4c. update the TENSION zones of every path (plan-471), with the geometry of
 *      THIS tick and the speeds the clamps of step 3 produced — after the store
 *      moved, before the pose is written;
 *   5. pose every path with its own section speeds.
 *
 * ## What plan-460 removed
 *
 * The `ConnectedDrive` consistency check is gone with the field: there is no
 * longer one speed per group to disagree about — every section reads its own
 * driven roller, and a group with two independent drives is a legitimate model
 * (that is exactly what a dancer is for).
 */

import type { Object3D } from 'three';
import type { RVDrive } from './rv-drive';
import type { ErrorStore } from './rv-error-store';
import { NodeRegistry } from './rv-node-registry';
import type { RVRibbonPath } from './rv-ribbon-path';
import type { RVRibbonWinder } from './rv-ribbon-winder';
import type { RVRibbonDancer } from './rv-ribbon-dancer';
import type { RibbonRollerLike, RibbonSideSign } from './rv-ribbon-roller';

/** Dev-only hint that a scene carries an unusual number of web paths. */
const DEV_WARNING_THRESHOLD = 50;

/** One connected set of paths — everything a shared roller ties together. */
interface RibbonGroup {
  /** Members, sorted by node path; `paths[0]` is the representative. */
  paths: RVRibbonPath[];
  /** Every roller any member owns, deduplicated, in member order. */
  rollers: RibbonRollerLike[];
  /** Every winder any member owns, deduplicated. */
  winders: RVRibbonWinder[];
  /** Every dancer any member owns, deduplicated. */
  dancers: RVRibbonDancer[];
  /** RibbonWinder → the path that integrates it (the smallest sort key). */
  owner: Map<RVRibbonWinder, RVRibbonPath>;
  /** RibbonDancer → the path that integrates it (the smallest sort key). */
  dancerOwner: Map<RVRibbonDancer, RVRibbonPath>;
  /** Dancers whose neighbouring sources disagree across paths — inert, warned once. */
  inertDancers: Set<RVRibbonDancer>;
  /** True once the shared-dancer consistency check has warned for this group. */
  warnedSharedDancer: boolean;
}

/** Rollers already advanced in the current tick (cleared per group). */
const _rotatedThisTick = new Set<RibbonRollerLike>();
const _contactOwners = new Map<RibbonRollerLike, RVRibbonPath>();
const _contactSigns = new Map<RibbonRollerLike, number>();
const _contactConflicts = new WeakSet<RibbonRollerLike>();

/** Per-path section speeds of the current tick, reused across groups. */
const _speedsByPath = new Map<RVRibbonPath, number[]>();

export class RibbonManager {
  private readonly _stoppedPaths = new Set<RVRibbonPath>();
  private readonly _blockedDrives = new Set<RVDrive>();
  private readonly _stopMessages = new Set<string>();

  constructor(private readonly errorStore?: ErrorStore) {}

  private _trip(group: RibbonGroup, source: Object3D, reason: string): void {
    if (group.paths.some((path) => this._stoppedPaths.has(path))) return;
    for (const path of group.paths) this._stoppedPaths.add(path);
    const key = NodeRegistry.computeNodePath(source);
    this.errorStore?.setActive(key, true, `${source.name}: ${reason}. Line stopped - reset required.`);
    this._stopMessages.add(key);
  }

  private _checkLineStop(group: RibbonGroup): boolean {
    for (const winder of group.winders) {
      if (winder.brakeFault) this._trip(group, winder.node, 'brake fault');
      else if (winder.role === 'unwind' && winder.isEmpty) this._trip(group, winder.node, 'unwinder roll empty');
      else if (winder.role === 'rewind' && winder.isFull) this._trip(group, winder.node, 'rewinder roll full');
    }
    for (const path of group.paths) {
      if (path.zones.some((zone) => zone.broken)) this._trip(group, path.node, 'fabric torn');
    }
    if (!group.paths.some((path) => this._stoppedPaths.has(path))) return false;
    for (const roller of group.rollers) {
      const drive = roller.driveOnNode?.();
      if (drive) {
        drive.setMotionBlocked?.(this, true);
        this._blockedDrives.add(drive);
      }
    }
    for (const path of group.paths) _speedsByPath.get(path)?.fill(0);
    return true;
  }

  private _releaseStops(): void {
    for (const drive of this._blockedDrives) drive.setMotionBlocked?.(this, false);
    this._blockedDrives.clear();
    this._stoppedPaths.clear();
    for (const key of this._stopMessages) this.errorStore?.remove(key);
    this._stopMessages.clear();
  }

  private readonly _paths = new Set<RVRibbonPath>();
  private _groups: RibbonGroup[] = [];
  private _groupsDirty = true;
  private _warnedAboutCount = false;
  /**
   * plan-460 R4 #4: the deprecation warning for `ConnectedDrive` / `SpeedSource`
   * is emitted ONCE per loaded document. The manager owns the flag because it is
   * the object whose lifetime IS the document (`clear()` on a model switch);
   * a per-path flag would warn once per path instead.
   */
  private _warnedDeprecatedFields = false;
  /**
   * Same lifetime rule for the shared-wrap-side warning of
   * {@link _validateSharedSides}: once per loaded document, cleared in `clear()`.
   */
  private _warnedSharedSides = false;
  /**
   * Path -> the `sidesVersion` its wrap sides last had when
   * {@link _validateSharedSides} looked at them. A `RibbonSide: Auto` roller is
   * re-resolved on EVERY solve, so a travelling dancer can flip the side of a
   * roller shared with a sibling strip long after the groups were built; without
   * this the conflict would only ever be caught at load.
   */
  private readonly _sidesSeen = new Map<RVRibbonPath, SharedStateSnapshot>();
  /** Once-per-document latch for the sample-grid mismatch warning. */
  private _warnedSharedStep = false;

  /** Signal write façade, injected by the viewer. Absent in plain unit tests. */
  private _write: ((address: string, value: number | boolean) => void) | null = null;
  private _previewing = false;

  /**
   * s — simulation time accumulated across {@link update} calls, used ONLY as
   * the phase of the tension alarm pulse.
   *
   * Simulation time, deliberately not the wall clock: a paused viewer must show
   * a still picture, and a screenshot taken at 4x speed has to be reproducible.
   */
  private _tensionClock = 0;

  get size(): number {
    return this._paths.size;
  }

  /** Registered paths in stable insertion order. */
  get paths(): readonly RVRibbonPath[] {
    return Array.from(this._paths);
  }

  /** Solve the current definition once without integrating or writing runtime outputs. */
  solvePreview(rebuildTopology = false): boolean {
    const write = this._write;
    const previewing = this._previewing;
    try {
      this._write = null;
      this._previewing = true;
      if (rebuildTopology) {
        for (const path of this._paths) path.rebuildTopology();
        this._groupsDirty = true;
      }
      return this.update(0);
    } finally {
      this._write = write;
      this._previewing = previewing;
    }
  }

  /** The current groups (diagnostics + tests). */
  get groups(): ReadonlyArray<{
    paths: readonly RVRibbonPath[];
    winders: readonly RVRibbonWinder[];
    dancers: readonly RVRibbonDancer[];
  }> {
    this._ensureGroups();
    return this._groups;
  }

  /**
   * Claim the once-per-document deprecation warning. Returns `true` for the
   * FIRST caller after a `clear()`, `false` for everyone after it.
   */
  noteDeprecatedFields(): boolean {
    if (this._warnedDeprecatedFields) return false;
    this._warnedDeprecatedFields = true;
    return true;
  }

  /**
   * Wire the signal sink once. A winder writes `DiameterMm`, `WoundLengthMm`,
   * `Empty` and `Full` through it, a dancer `PositionMm`, `AtMin` and `AtMax` —
   * never directly, so the writer identity stays the viewer's and a test can
   * observe every write with one spy.
   */
  setSignalWriter(write: ((address: string, value: number | boolean) => void) | null): void {
    this._write = write;
  }

  register(path: RVRibbonPath): void {
    this._paths.add(path);
    this._groupsDirty = true;
    if (
      import.meta.env.DEV
      && !this._warnedAboutCount
      && this._paths.size > DEV_WARNING_THRESHOLD
    ) {
      this._warnedAboutCount = true;
      console.warn(
        `[RibbonManager] ${this._paths.size} web paths are registered; `
        + 'consider fewer strips or a lower SamplesPerMeter for best performance',
      );
    }
  }

  unregister(path: RVRibbonPath): void {
    this._paths.delete(path);
    this._stoppedPaths.delete(path);
    if (this._paths.size === 0) this._releaseStops();
    _speedsByPath.delete(path);
    this._sidesSeen.delete(path);
    this._groupsDirty = true;
  }

  /** The path that integrates `winder`, or `null` when it belongs to none. */
  ownerOf(winder: RVRibbonWinder): RVRibbonPath | null {
    this._ensureGroups();
    for (const group of this._groups) {
      const owner = group.owner.get(winder);
      if (owner) return owner;
    }
    return null;
  }

  /** The path that integrates `dancer`, or `null` when it belongs to none. */
  dancerOwnerOf(dancer: RVRibbonDancer): RVRibbonPath | null {
    this._ensureGroups();
    for (const group of this._groups) {
      const owner = group.dancerOwner.get(dancer);
      if (owner) return owner;
    }
    return null;
  }

  /**
   * Advance every group. Returns `true` when at least one path changed anything
   * visible; the caller marks render AND shadow dirty on `true` (a web moved by
   * a live signal never touches the drive loop's shadow flag).
   */
  update(dt: number): boolean {
    if (this._paths.size === 0) return false;
    this._ensureGroups();
    if (dt > 0) this._tensionClock += dt;
    let changed = false;

    for (const group of this._groups) {
      // Resolve Auto in the current pose, then agree on ONE conversion for a
      // shared shaft. Conflicting threading cannot drive one web.
      _contactOwners.clear();
      _contactSigns.clear();
      for (const path of group.paths) {
        if (path.refreshMotionGeometry()) changed = true;
        for (let i = 0; i < path.rollers.length; i++) {
          const roller = path.rollers[i];
          const sign = path.contactSignAt(i);
          const owner = _contactOwners.get(roller);
          if (!owner) {
            _contactOwners.set(roller, path);
            _contactSigns.set(roller, sign);
          } else if (_contactSigns.get(roller) !== sign) {
            _contactSigns.set(roller, 0);
            if (!_contactConflicts.has(roller)) {
              _contactConflicts.add(roller);
              console.warn(`[RibbonPath] "${roller.node.name}" has incompatible contact directions on shared paths; its web speed is zero. Check the threading of the shared roller.`);
            }
          }
        }
      }
      for (const roller of group.rollers) {
        const sign = _contactSigns.get(roller) ?? 1;
        roller.setContactMotion(sign);
        if (sign !== 0) _contactConflicts.delete(roller);
      }
      // 1. One drive read per roller, before any path asks for a speed.
      for (const roller of group.rollers) roller.sampleDrive(dt);

      // 2. Section speeds, per path.
      for (const path of group.paths) {
        const sections = path.readSectionSpeeds();
        let speeds = _speedsByPath.get(path);
        if (!speeds || speeds.length !== sections.length) {
          speeds = new Array<number>(sections.length).fill(0);
          _speedsByPath.set(path, speeds);
        }
        for (let k = 0; k < sections.length; k++) speeds[k] = sections[k].speed;
      }

      // 3a. Winder limits are GROUP-WIDE and absolute: an empty unwinder must
      //     stop every strip in the SAME tick, not the next.
      //     `stopped` is handed on to step 4c: a group stop zeroes every tension
      //     boundary slot, which PRESERVES every strain rather than relaxing it.
      let stopped = this._checkLineStop(group);
      for (const winder of group.winders) {
        if (stopped) break;
        for (const path of group.paths) {
          const speeds = _speedsByPath.get(path);
          if (!speeds) continue;
          const idx = indexOfRoller(path, winder);
          if (idx < 0) continue;
          const k = path.sectionOfRoller(idx);
          if (winder.clampSpeed(speeds[k], dt) === 0 && speeds[k] !== 0) { stopped = true; break; }
        }
      }
      if (stopped) {
        for (const path of group.paths) {
          const speeds = _speedsByPath.get(path);
          if (speeds) speeds.fill(0);
        }
      }

      // 3b. Dancer limits are DIRECTIONAL and group-wide (see RVRibbonDancer).
      this._validateSharedDancers(group);
      for (const dancer of group.dancers) {
        if (group.inertDancers.has(dancer)) continue;
        for (const path of group.paths) {
          const speeds = _speedsByPath.get(path);
          if (!speeds) continue;
          const idx = indexOfRoller(path, dancer);
          if (idx < 0) continue;
          const down = path.sectionOfRoller(idx);
          dancer.clampSpeeds(speeds, down - 1, down);
        }
      }

      // 4a. Each dancer is integrated exactly once, by its owner path.
      for (const dancer of group.dancers) {
        if (group.inertDancers.has(dancer)) continue;
        const owner = group.dancerOwner.get(dancer);
        const speeds = owner ? _speedsByPath.get(owner) : undefined;
        if (!owner || !speeds) continue;
        const idx = indexOfRoller(owner, dancer);
        if (idx < 0) continue;
        const down = owner.sectionOfRoller(idx);
        dancer.advance(speeds[down - 1] ?? 0, speeds[down] ?? 0, dt);
        changed = true;
      }

      // 4b. Each winder is integrated exactly once, with the speed of ITS section.
      for (const winder of group.winders) {
        const owner = group.owner.get(winder);
        const speeds = owner ? _speedsByPath.get(owner) : undefined;
        if (!owner || !speeds) continue;
        const idx = indexOfRoller(owner, winder);
        if (idx < 0) continue;
        const v = speeds[owner.sectionOfRoller(idx)] ?? 0;
        if (v !== 0) winder.advance(v, dt);
      }

      // 4a'. The dancers draw their own track and readout. Every dancer of the
      //      group, INERT ones included: a dancer showing a collapsed travel
      //      range is how a misconfigured one becomes visible.
      for (const dancer of group.dancers) dancer.updateTravelVisual();

      // 4b'. Winder speed control. AFTER the radii of 4b and the carriages of
      //      4a, because both are what it divides by and regulates on, and
      //      BEFORE nothing in particular: it writes a drive SET-POINT that the
      //      next tick's `sampleDrive` reads back out of the axis position.
      stopped = this._checkLineStop(group) || stopped;
      if (!stopped && !this._previewing) this._controlWinderSpeeds(group);

      // 4c. Tension (plan-471). It runs here, not in step 5, because the zone
      //     lengths must come from the geometry of THIS tick — the dancer moved
      //     in 4a — while the sampling and the band write stay in step 5. A path
      //     without tension returns immediately and enters no new code at all.
      for (const path of group.paths) {
        const speeds = _speedsByPath.get(path);
        if (!speeds) continue;
        path.prepareTension(dt, speeds, stopped);
      }

      stopped = this._checkLineStop(group) || stopped;

      // 5. A roller shared by several strips (the unwinder, the idlers before
      //    the slitter) turns ONCE per tick: the set remembers who turned it.
      _rotatedThisTick.clear();
      for (const path of group.paths) {
        const speeds = _speedsByPath.get(path);
        if (!speeds) continue;
        if (path.updatePose(dt, speeds, _rotatedThisTick)) changed = true;
      }

      // 6. The shared-state check again, but only when something actually moved.
      //    `updatePose` above is where a dirty path re-solves — `resolveAutoSides`
      //    re-decides and the capacity rule may coarsen the sample grid — so this
      //    is the first moment the new values exist.
      if (this._sharedStateMoved(group.paths)) this._validateSharedSides(group.paths);

      // 6b. The tension TINT is a material write and deliberately runs outside
      //     the geometry path (Auflage A1): a web whose deviation grows while
      //     its rollers stand still changes colour without being re-sampled.
      for (const path of group.paths) path.updateTensionVisuals(this._tensionClock);

      if (this._write) {
        for (const winder of group.winders) winder.writeSignals(this._write);
        for (const dancer of group.dancers) dancer.writeSignals(this._write);
        for (const path of group.paths) path.writeTensionSignals(this._write);
      }
    }
    return changed;
  }

  /**
   * Hold every speed-controlled winder of `group` at the line speed.
   *
   * ## What the line speed IS
   *
   * The surface speed of the group's MASTER: the fastest driven roller that is
   * not itself speed-controlled. In a web line that is the nip / pull roll, which
   * is precisely what every winder in the line is slaved to — and it has to be
   * defined by exclusion, because a controlled winder's own speed is the output
   * of this function and would otherwise be its own reference.
   *
   * A group with no master at all (every driven roller is a controlled winder)
   * has nothing to follow, so nothing is written and the authored speeds stand.
   *
   * ## Which dancer a winder regulates on
   *
   * Only the one that measures what THIS drive did — the dancer bounding the
   * winder's own section, and only when the winder is that section's single
   * driven roller. In the demo slitter that gives each rewinder its own carriage
   * and gives the unwinder none: the nip sits in the unwinder's section, so the
   * store after it is not the unwinder's to regulate, and `Dancer` collapses to
   * `LineSpeed` there — which is the correct machine, not a fallback.
   */
  private _controlWinderSpeeds(group: RibbonGroup): void {
    let master = 0;
    for (const roller of group.rollers) {
      if (!roller.isDriven) continue;
      if (isControlledWinder(roller)) continue;
      const v = roller.surfaceSpeedMmPerS;
      if (Math.abs(v) > Math.abs(master)) master = v;
    }
    if (master === 0) return;

    for (const winder of group.winders) {
      if (winder.SpeedControl === 'None') continue;
      winder.controlDriveSpeed(master, this._dancerErrorFor(group, winder));
    }
  }

  /** mm — `positionMm - HomeMm` of the dancer `winder` may regulate on, else 0. */
  private _dancerErrorFor(group: RibbonGroup, winder: RVRibbonWinder): number {
    if (winder.SpeedControl !== 'Dancer') return 0;
    const owner = group.owner.get(winder);
    if (!owner) return 0;
    const idx = indexOfRoller(owner, winder);
    if (idx < 0) return 0;
    const k = owner.sectionOfRoller(idx);
    // The winder must be the ONE driven roller of its section; otherwise the
    // store beside it is fed by something else and this drive cannot hold it.
    if (owner.sections[k]?.driven !== winder) return 0;
    for (const dancer of owner.dancers) {
      const di = indexOfRoller(owner, dancer);
      if (di < 0) continue;
      // A dancer OWNS the section it leaves, so it bounds section `ds` from
      // upstream and section `ds - 1` from downstream.
      const ds = owner.sectionOfRoller(di);
      if (ds === k || ds === k + 1) return dancer.positionMm - dancer.HomeMm;
    }
    return 0;
  }

  /**
   * plan-460 R3 #5: a dancer may be shared by several paths only when BOTH of
   * its neighbouring sections resolve to the same driven roller for every one of
   * them — in practice, when it sits BEFORE the slit. Otherwise there is no
   * single `(v_up, v_down)` pair to integrate, and picking one path's would move
   * the carriage by a number the other path does not see. Such a dancer goes
   * inert for the WHOLE group (its carriage stays at `HomeMm`), warned once.
   */
  private _validateSharedDancers(group: RibbonGroup): void {
    for (const dancer of group.dancers) {
      let refUp: unknown;
      let refDown: unknown;
      let first = true;
      let conflict = false;
      for (const path of group.paths) {
        const idx = indexOfRoller(path, dancer);
        if (idx < 0) continue;
        const down = path.sectionOfRoller(idx);
        const sections = path.sections;
        const up = sections[down - 1]?.driven ?? null;
        const dn = sections[down]?.driven ?? null;
        if (first) { refUp = up; refDown = dn; first = false; continue; }
        if (up !== refUp || dn !== refDown) { conflict = true; break; }
      }
      if (!conflict) { group.inertDancers.delete(dancer); continue; }
      if (!group.inertDancers.has(dancer)) {
        group.inertDancers.add(dancer);
        dancer.reset();
      }
      if (!group.warnedSharedDancer) {
        group.warnedSharedDancer = true;
        console.warn(
          `[RibbonManager] "${dancer.node.name}" is shared by web paths whose neighbouring driven `
          + 'rollers differ; a dancer can only be shared before the slit. It is held at HomeMm '
          + 'for every path of the group.',
        );
      }
    }
  }

  /**
   * Restore every path's authored state — wound lengths, radii, roller angles,
   * dancer positions and texture offsets. Called from
   * `RVViewer.resetSimulation()` AFTER the drives were reset (see the header).
   */
  resetAll(): void {
    this._releaseStops();
    this._tensionClock = 0;
    for (const path of this._paths) path.reset();
  }

  /**
   * Strips slit at the SAME roller are one web up to that roller: they share
   * every roller before the cut, so their wrap SIDE at each of those rollers
   * must agree. It can fail to: with `RibbonSide: Auto` the side is resolved per
   * PATH, from the roller's position between ITS own neighbours, and two strips
   * that leave the slit roller in different directions can therefore resolve it
   * differently — which puts the shared, full-width part of the web on two
   * different tangent lines at once. That is physically impossible, and on
   * screen it is a web that visibly splits before it is cut.
   *
   * Diagnosed, never repaired: the fix is a modelling one (move the offending
   * roller, or pin `RibbonSide` explicitly on the shared rollers), and silently
   * overriding an authored side would hide it. Warned ONCE per document — the
   * manager owns the flag for the same reason it owns the deprecation one.
   */
  private _validateSharedSides(members: readonly RVRibbonPath[]): void {
    for (const path of members) {
      this._sidesSeen.set(path, { sides: path.sidesVersion, step: path.sampleStepMm });
    }
    const bySlit = new Map<RibbonRollerLike, RVRibbonPath[]>();
    for (const path of members) {
      const slit = path.slitRoller;
      if (!slit) continue;
      const strips = bySlit.get(slit);
      if (strips) strips.push(path);
      else bySlit.set(slit, [path]);
    }

    // EVERY slit group, always. The warnings latch, the LOOP does not: a machine
    // with two cutters would otherwise have its second group silently skipped
    // because the first one had a side conflict — and `_sharedStateMoved` would
    // by then have recorded a snapshot for it, so it would never be looked at
    // again either.
    for (const [slit, strips] of bySlit) {
      if (strips.length < 2) continue;
      this._validateSharedGrid(strips, slit);
      // The first strip (sort-key order, the pre-slit owner) is the reference:
      // its resolved sides are the ones actually drawn for the shared part.
      const reference = new Map<RibbonRollerLike, RibbonSideSign>();
      collectSharedSides(strips[0], slit, reference);
      let conflicted = false;
      for (let k = 1; k < strips.length && !conflicted; k++) {
        const path = strips[k];
        const mine = new Map<RibbonRollerLike, RibbonSideSign>();
        collectSharedSides(path, slit, mine);
        for (const [roller, side] of mine) {
          const expected = reference.get(roller);
          if (expected === undefined || expected === 0 || side === 0 || side === expected) continue;
          // One report per GROUP is enough to name the fault, and one per
          // DOCUMENT is enough not to drown the console.
          conflicted = true;
          if (this._warnedSharedSides) break;
          this._warnedSharedSides = true;
          console.warn(
            `[RibbonManager] "${path.node.name}" and "${strips[0].node.name}" are slit at `
            + `"${slit.node.name}" but wrap the shared roller "${roller.node.name}" on opposite `
            + `sides (${sideName(expected)} vs ${sideName(side)}). Up to the slit they are ONE web `
            + 'and cannot take two different tangent lines; check the roller positions after the '
            + 'slit or set RibbonSide explicitly on the shared rollers. Both strips keep drawing.',
          );
          break;
        }
      }
    }
  }

  /**
   * Strips slit at one roller are cut at the same SAMPLE only while they sample
   * the shared part on the same absolute grid. They normally do — the grid is
   * `1000 / SamplesPerMeter` — but the capacity rule coarsens it for a path that
   * outgrew its sample buffer, so an 80 m strip can end up on 32 samples/m while
   * its 6 m sibling stays on 64, and the shared arrival point then rounds to two
   * different places.
   *
   * Reported, not repaired: forcing the coarser grid on every sibling would
   * quietly halve the resolution of strips that were fine, and forcing the finer
   * one would re-overflow the buffer this rule exists to protect. The modelling
   * answer is to lower `SamplesPerMeter` for the whole slitter, or to shorten the
   * long strip. Warned ONCE per document, like the side check.
   */
  private _validateSharedGrid(strips: readonly RVRibbonPath[], slit: RibbonRollerLike): void {
    if (this._warnedSharedStep) return;
    const reference = strips[0];
    for (let k = 1; k < strips.length; k++) {
      const path = strips[k];
      // Both are exact multiples of a power-of-two-halved 1000/N, so an exact
      // comparison is right; a tolerance would only hide a real mismatch.
      if (path.sampleStepMm === reference.sampleStepMm) continue;
      this._warnedSharedStep = true;
      console.warn(
        `[RibbonManager] "${path.node.name}" and "${reference.node.name}" are slit at `
        + `"${slit.node.name}" but sample the shared web on different grids `
        + `(${path.sampleStepMm.toFixed(3)} mm vs ${reference.sampleStepMm.toFixed(3)} mm per `
        + 'sample), so the cut lands on a slightly different point for each of them. One of them '
        + 'outgrew its sample buffer and had its density reduced; give the whole slitter a lower '
        + 'SamplesPerMeter, or shorten the longest strip.',
      );
      return;
    }
  }

  /**
   * True when any member resolved a wrap side differently, or moved to a
   * different sample grid, since the last time the shared-state check ran. Also
   * UPDATES the remembered snapshot, so a group whose sides keep moving is
   * checked once per change and not once per tick.
   */
  private _sharedStateMoved(members: readonly RVRibbonPath[]): boolean {
    let moved = false;
    for (const path of members) {
      const seen = this._sidesSeen.get(path);
      if (seen && seen.sides === path.sidesVersion && seen.step === path.sampleStepMm) continue;
      this._sidesSeen.set(path, { sides: path.sidesVersion, step: path.sampleStepMm });
      moved = true;
    }
    return moved;
  }

  /** Dispose every registered path before the model's geometry is destroyed. */
  clear(): void {
    this._releaseStops();
    while (this._paths.size > 0) {
      const path = this._paths.values().next().value as RVRibbonPath | undefined;
      if (!path) break;
      path.dispose();
      this._paths.delete(path);
    }
    this._groups = [];
    this._groupsDirty = true;
    this._warnedAboutCount = false;
    // A new document gets its own deprecation warning (R4 #4).
    this._warnedDeprecatedFields = false;
    this._warnedSharedSides = false;
    this._warnedSharedStep = false;
    this._sidesSeen.clear();
    this._tensionClock = 0;
    _speedsByPath.clear();
    this._write = null;
  }

  // -- Grouping ---------------------------------------------------

  private _ensureGroups(): void {
    if (!this._groupsDirty) return;
    this._groupsDirty = false;
    this._groups = [];

    // Union-find over "shares a roller". Small N (a slitter is tens of strips,
    // not thousands), so the plain parent-array form is the readable one.
    const paths = [...this._paths].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const parent = paths.map((_, i) => i);
    const find = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r];
      while (parent[i] !== r) {
        const next = parent[i];
        parent[i] = r;
        i = next;
      }
      return r;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    // Any shared roller joins two paths: a slitter's strips share the unwinder
    // AND the idlers before the cutter, and all of them are one web.
    const byRoller = new Map<RibbonRollerLike, number>();
    for (let i = 0; i < paths.length; i++) {
      for (const roller of paths[i].rollers) {
        const seen = byRoller.get(roller);
        if (seen === undefined) byRoller.set(roller, i);
        else union(seen, i);
      }
    }

    const buckets = new Map<number, RVRibbonPath[]>();
    for (let i = 0; i < paths.length; i++) {
      const root = find(i);
      const bucket = buckets.get(root);
      if (bucket) bucket.push(paths[i]);
      else buckets.set(root, [paths[i]]);
    }

    for (const members of buckets.values()) {
      // Label lanes. The strips of one group run a few hundred millimetres apart
      // along the ROLLER axis, so a camera looking anywhere near that axis
      // projects all of their zone labels onto the same spot and the readout
      // becomes an unreadable pile of overprinted text. Each strip therefore
      // hangs its labels at its own fraction ALONG the web, where the strips are
      // never parallel to each other for long. One strip keeps the midpoint it
      // always had.
      for (let i = 0; i < members.length; i++) {
        members[i].labelLane = i;
        members[i].labelLaneCount = members.length;
      }
      const rollers: RibbonRollerLike[] = [];
      const seenRollers = new Set<RibbonRollerLike>();
      const winders: RVRibbonWinder[] = [];
      const dancers: RVRibbonDancer[] = [];
      const owner = new Map<RVRibbonWinder, RVRibbonPath>();
      const dancerOwner = new Map<RVRibbonDancer, RVRibbonPath>();
      // `members` is already in sort-key order, so the FIRST path that names a
      // winder or dancer is the lexicographically smallest one — the owner rule.
      for (const path of members) {
        for (const roller of path.rollers) {
          if (seenRollers.has(roller)) continue;
          seenRollers.add(roller);
          rollers.push(roller);
        }
        for (const winder of path.winders) {
          if (!owner.has(winder)) {
            owner.set(winder, path);
            winders.push(winder);
          }
        }
        for (const dancer of path.dancers) {
          if (!dancerOwner.has(dancer)) {
            dancerOwner.set(dancer, path);
            dancers.push(dancer);
          }
        }
      }
      // Of the strips slit at one roller, the first (sorted) draws the shared
      // full-width web before it; the others draw only their own strip.
      // That same first strip also OWNS the shared strain upstream of the blade
      // (plan-471 SOL R1 #5): it integrates the full-width sheet and the others
      // adopt its zones instead of integrating a second copy of the same web.
      // `members` order is the tick order of step 4c, and the owner is by
      // construction the first of its blade's strips, so it is always prepared
      // before the strips that read it.
      const preSlitOwner = new Map<RibbonRollerLike, RVRibbonPath>();
      for (const path of members) {
        const slit = path.slitRoller;
        if (!slit) {
          path.setDrawsPreSlit(true);
          path.setPreSlitTensionSource(null);
          continue;
        }
        const owner = preSlitOwner.get(slit);
        if (!owner) {
          preSlitOwner.set(slit, path);
          path.setDrawsPreSlit(true);
          path.setPreSlitTensionSource(null);
        } else {
          path.setDrawsPreSlit(false);
          path.setPreSlitTensionSource(owner);
        }
      }
      this._validateSharedSides(members);
      this._groups.push({
        paths: members, rollers, winders, dancers, owner, dancerOwner,
        inertDancers: new Set<RVRibbonDancer>(), warnedSharedDancer: false,
      });
    }
  }
}

/** What the shared-state check last saw for one path (see `_sharedStateMoved`). */
interface SharedStateSnapshot {
  sides: number;
  /** mm — the path's absolute sample grid step. */
  step: number;
}

/** `path`'s resolved side at every roller up to and INCLUDING `slit`. */
function collectSharedSides(
  path: RVRibbonPath,
  slit: RibbonRollerLike,
  out: Map<RibbonRollerLike, RibbonSideSign>,
): void {
  const rollers = path.rollers;
  for (let i = 0; i < rollers.length; i++) {
    out.set(rollers[i], path.resolvedSideAt(i));
    if (rollers[i] === slit) return;
  }
}

/** `+1` / `-1` as the name the user typed in the inspector. */
function sideName(side: RibbonSideSign): string {
  return side > 0 ? 'Left' : side < 0 ? 'Right' : 'Auto';
}

/**
 * True for a winder whose speed this manager writes — i.e. one that may not
 * serve as the line-speed reference, because its speed IS the output.
 *
 * A structural test rather than `instanceof RVRibbonWinder`: the manager is
 * imported by the winder's own module graph, and a value import here would close
 * the cycle. `SpeedControl` is unique to a winder, so the shape is enough.
 */
function isControlledWinder(roller: RibbonRollerLike): boolean {
  const control = (roller as unknown as { SpeedControl?: unknown }).SpeedControl;
  return typeof control === 'string' && control !== 'None';
}

/** Index of `roller` in `path.rollers`, or `-1`. */
function indexOfRoller(path: RVRibbonPath, roller: RibbonRollerLike): number {
  const rollers = path.rollers;
  for (let i = 0; i < rollers.length; i++) if (rollers[i] === roller) return i;
  return -1;
}
