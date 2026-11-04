// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Camera, Euler, Quaternion, Vector3 } from 'three';
import { applyMouseLook } from '../../plugins/_shared/camera-look';

export interface SixDofSample {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface SixDofNavInput {
  feed(sample: Readonly<SixDofSample>, source: 'spacemouse' | 'external'): void;
  mode: 'Orbit' | 'Fly';
}

export const SIX_DOF_AXES = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const;

export interface SpaceMouseSettings {
  Mode: 'Orbit' | 'Fly';
  Sensitivity: number;
  DeadZone: number;
  Smoothing: number;
  DominantAxis: boolean;
  LockHorizon: boolean;
  WalkMode: boolean;
  EyeHeight: number;
  InvertTranslation: boolean[];
  InvertRotation: boolean[];
  Button1: SpaceMouseButton;
  Button2: SpaceMouseButton;
}

export type SpaceMouseButton = 'Overview' | 'Next' | 'Previous' | 'Mode' | 'FitSelection';

/** Create independent default settings for a navigation input. */
export function defaultSpaceMouseSettings(): SpaceMouseSettings {
  return {
    Mode: 'Orbit',
    Sensitivity: 1,
    DeadZone: 8,
    Smoothing: 0.6,
    DominantAxis: false,
    LockHorizon: true,
    WalkMode: false,
    EyeHeight: 1700,
    InvertTranslation: [false, false, false],
    InvertRotation: [false, false, false],
    Button1: 'Overview',
    Button2: 'Next',
  };
}

/** Remove the dead zone and rescale the remaining signed input. */
export function deadZone(value: number, threshold: number): number {
  return Math.sign(value) * Math.max(0, Math.abs(value) - threshold) / (1 - threshold);
}

/** Held samples; each producer must send zero when its input ends. Reset on lost ownership. */
export class RVSpaceMouseNav implements SixDofNavInput {
  private readonly raw = [new Float64Array(6), new Float64Array(6)];
  private readonly smooth = [new Float64Array(6), new Float64Array(6)];
  readonly axes = new Float64Array(6);
  private readonly integral = new Float64Array(6);
  private readonly move = new Vector3();
  private readonly offset = new Vector3();
  private readonly forward = new Vector3();
  private readonly inverse = new Quaternion();
  private readonly rotation = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly look = { yaw: 0, pitch: 0 };
  constructor(readonly settings = defaultSpaceMouseSettings()) { }
  get mode(): 'Orbit' | 'Fly' {
    return this.settings.Mode;
  }

  set mode(mode: 'Orbit' | 'Fly') {
    this.settings.Mode = mode;
  }

  feed(sample: Readonly<SixDofSample>, source: 'spacemouse' | 'external'): void {
    const out = this.raw[source === 'spacemouse' ? 0 : 1];
    for (let i = 0; i < 6; i++)
      out[i] = Number.isFinite(sample[SIX_DOF_AXES[i]]) ? Math.max(-1, Math.min(1, sample[SIX_DOF_AXES[i]])) : 0;
  }

  /** Drop held input and smoothing — of both sources, or only of `source` (flystick failure, plan-2215 2.6). */
  reset(source?: 'spacemouse' | 'external'): void {
    for (let i = 0; i < 2; i++) {
      if (source && i !== (source === 'spacemouse' ? 0 : 1))
        continue;
      this.raw[i].fill(0);
      this.smooth[i].fill(0);
    }
    this.axes.fill(0);
  }

  /**
   * Apply one frame of held input. Orbit rotates rigidly about `pivot` and carries it along with the pan;
   * `target` is rebuilt on the new view axis at the pivot depth, so a later OrbitControls lookAt keeps the view.
   * Fly moves the pivot to the rebuilt target.
   */
  step(dt: number, camera: Camera, target: Vector3, pivot: Vector3 = target): boolean {
    if (!(dt > 0) || !Number.isFinite(dt))
      return false;
    dt = Math.min(dt, 0.1);
    this.axes.fill(0);
    this.integral.fill(0);
    const tau = this.settings.Smoothing === 0 ? 0 : -1 / (60 * Math.log(Math.min(0.95, this.settings.Smoothing)));
    const decay = tau ? Math.exp(-dt / tau) : 0;
    for (let s = 0; s < 2; s++) {
      let dominant = 0;
      for (let i = 1; i < 6; i++)
        if (Math.abs(this.raw[s][i]) > Math.abs(this.raw[s][dominant]))
          dominant = i;
      for (let i = 0; i < 6; i++) {
        let v = this.settings.DominantAxis && i !== dominant
          ? 0
          : deadZone(this.raw[s][i], this.settings.DeadZone / 100);
        if ((i < 3 ? this.settings.InvertTranslation[i] : this.settings.InvertRotation[i - 3]))
          v = -v;
        const old = this.smooth[s][i];
        this.smooth[s][i] = v + (old - v) * decay;
        this.axes[i] += this.smooth[s][i];
        this.integral[i] += v * dt + (old - v) * tau * (1 - decay);
      }
    }
    let active = false;
    for (let i = 0; i < 6; i++) {
      this.axes[i] = Math.max(-1, Math.min(1, this.axes[i]));
      this.integral[i] = Math.max(-dt, Math.min(dt, this.integral[i]));
      if (Math.abs(this.integral[i]) > 1e-7)
        active = true;
    }
    if (!active)
      return false;
    const a = this.integral;
    const speed = this.settings.Sensitivity;
    const distance = Math.max(0.01, camera.position.distanceTo(pivot));
    const focus = Math.max(0.01, camera.position.distanceTo(target));
    this.inverse.copy(camera.quaternion).invert();
    this.euler.setFromQuaternion(camera.quaternion, 'YXZ');
    this.look.yaw = this.euler.y;
    this.look.pitch = this.euler.x;
    const roll = this.euler.z;
    // Yaw about world up and pitch about the camera X. Roll only in Fly without Lock Horizon:
    // OrbitControls has no roll and would snap an orbit roll back on its next update.
    applyMouseLook(this.look, -a[4], -a[3], speed, this.rotation);
    if (this.mode === 'Fly' && !this.settings.LockHorizon) {
      this.euler.set(0, 0, roll + a[5] * speed);
      camera.quaternion.copy(this.rotation);
      this.rotation.setFromEuler(this.euler);
      camera.quaternion.multiply(this.rotation);
    } else
      camera.quaternion.copy(this.rotation);
    if (this.mode === 'Orbit') {
      this.offset.copy(camera.position).sub(pivot);
      this.rotation.copy(camera.quaternion).multiply(this.inverse);
      this.move.copy(this.offset).applyQuaternion(this.rotation).multiplyScalar(Math.exp(a[2] * speed));
      // Rotating the camera preserves the orbit radius and pivot.
      camera.position.copy(pivot).add(this.move);
      this.move.set(a[0] * distance * speed, a[1] * distance * speed, 0).applyQuaternion(camera.quaternion);
      camera.position.add(this.move);
      pivot.add(this.move);
      // Like NavigationController._orbit: target on the view axis at the pivot depth; a pivot behind
      // the camera keeps the previous focus distance.
      this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      this.offset.copy(pivot).sub(camera.position);
      let depth = this.offset.dot(this.forward);
      if (!(depth > 0.01))
        depth = focus;
      target.copy(camera.position).addScaledVector(this.forward, depth);
    } else {
      this.move.set(a[0], this.settings.WalkMode ? 0 : a[1], a[2]);
      this.move.applyQuaternion(camera.quaternion);
      if (this.settings.WalkMode)
        this.move.y = 0;
      camera.position.addScaledVector(this.move, distance * speed);
      this.move.set(0, 0, -distance).applyQuaternion(camera.quaternion);
      target.copy(camera.position).add(this.move);
      pivot.copy(target);
    }
    camera.updateMatrixWorld();
    return true;
  }
}
