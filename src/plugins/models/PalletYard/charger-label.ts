// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PalletYard charger labels (plan-612 CP1d-a a2, Thomas 2026-10-18: "Ladestand
 * am Lader, waehrend ein Stapler dort laedt").
 *
 * While a vehicle charges (`leg === 'charging'` and the battery in charge mode —
 * from `startCharge` until `chargeDone`), a label "⚡ 63 %" floats above that
 * charger. The value is the projected state of charge on SIMULATION time (the
 * same projection as `_rvStateOfCharge`), so it rises during the charge in every
 * mode (FastForward, Animated). The label appears with the first frame of the
 * charge and is gone with the first frame after `chargeDone`. It does not depend
 * on the DES badge toggle — always on.
 *
 * Render load (#206): `update()` runs in the plugin's existing `onRender`; it
 * redraws the canvas texture at most every {@link CHARGER_LABEL_REFRESH_MS} wall
 * milliseconds and only when the WHOLE percent changed. That redraw
 * (`texture.needsUpdate`) is the only thing it triggers — no `markRenderDirty`.
 * A reset (new runtime epoch), a rebind (another runtime) or `clear()` removes
 * every sprite. Shared label contract (`createLabelSprite`): overlay layer like
 * the DES badges, no depth, not tone-mapped, never a raycast target.
 */

import { Vector3, type CanvasTexture, type Object3D, type Sprite } from 'three';
import { HIGHLIGHT_OVERLAY_LAYER } from '@rv/core/engine/rv-group-registry';
import { createLabelSprite } from '@rv/core/engine/rv-label-sprite';
import { desStateColor } from '@rv/plugins/des/hmi/des-stat-colors';
import { STATION_GEOMETRY, VEHICLE_LENGTH_MM, handlingPose, type PalletYardConfig, type StationGeometry } from './layout';

/** Wall-clock minimum between two texture redraws of one label (ms). */
export const CHARGER_LABEL_REFRESH_MS = 500;
/** Height of the label centre above the floor (m, yard frame). */
export const CHARGER_LABEL_HEIGHT_M = 1.5;
/** World height of the label sprite (m). */
export const CHARGER_LABEL_SIZE_M = 0.35;

const CANVAS_W = 180;
const CANVAS_H = 64;
const SUPERSAMPLE = 2;
/** Frame colour = the `Charging` colour of the DES state stack. */
const FRAME_COLOR = desStateColor('Charging') ?? '#d500f9';

/** What the labels read from the runtime (kept small for tests). */
export interface ChargingView {
  readonly cfg: Pick<PalletYardConfig, 'vehicles'>;
  /** Bumped by every (re)start — a new epoch drops every label. */
  readonly epoch: number;
  /** Charger the vehicle is charging at right now, else null. */
  chargingAt(vehicle: string): string | null;
  /** Projected state of charge (%) now. */
  socAt(vehicle: string): number;
  /** Station geometry of the yard at its current size (plan-681 D12); default the size-2 table. */
  readonly geometry?: readonly StationGeometry[];
}

/**
 * Charger box position in the yard frame (m): behind the vehicle's handling
 * pose in the stich, as the generator (`tools/pallet-yard.mjs`, `Charger_<id>`)
 * places it; height {@link CHARGER_LABEL_HEIGHT_M}. Null for a non-charger.
 * `geometry` = the yard at its current size (`composeYard(n).geometry`).
 */
export function chargerLabelYardPosition(charger: string, geometry: readonly StationGeometry[] = STATION_GEOMETRY): [number, number, number] | null {
  const g = geometry.find((x) => x.id === charger && x.kind === 'charger');
  if (!g) return null;
  const { root, forwardZ } = handlingPose(g);
  const behind = VEHICLE_LENGTH_MM / 2000 + 0.25;
  return [g.x, CHARGER_LABEL_HEIGHT_M, root[1] - forwardZ * behind];
}

/** Label text for a state of charge. */
export const chargerLabelText = (percent: number): string => `⚡ ${percent} %`;

interface Label {
  readonly charger: string;
  readonly vehicle: string;
  percent: number;
  drawnAt: number;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly sprite: Sprite;
}

/** Read-only view of a live label (tests, diagnostics). */
export interface ChargerLabelInfo {
  vehicle: string;
  percent: number;
  text: string;
  /** World position of the sprite. */
  position: Vector3;
  sprite: Sprite;
}

/** The labels of one viewer — see the module doc. */
export class ChargerLabels {
  /** Wall clock (ms) the refresh throttle uses — tests replace it. */
  wallNow: () => number = () => performance.now();
  /** Canvas texture draws so far (creation included) — the render-load counter. */
  redraws = 0;
  private readonly labels = new Map<string, Label>();
  private parent: Object3D | null = null;
  private frame: Object3D | null = null;
  private view: ChargingView | null = null;
  private epoch = -1;

  /** Where the sprites go (the scene) and the yard frame the charger positions are given in. */
  attach(parent: Object3D, yardFrame: Object3D): void {
    if (parent !== this.parent || yardFrame !== this.frame) this.clear();
    this.parent = parent;
    this.frame = yardFrame;
  }

  /** Remove every sprite and forget the bound runtime; stays attached. */
  clear(): void {
    for (const l of this.labels.values()) this.remove(l);
    this.labels.clear();
    this.view = null;
    this.epoch = -1;
  }

  /** `clear()` and forget the scene (unbind / model cleared). */
  detach(): void {
    this.clear();
    this.parent = null;
    this.frame = null;
  }

  /** Number of live labels. */
  get size(): number { return this.labels.size; }

  /** The live label of `charger`, or null. */
  label(charger: string): ChargerLabelInfo | null {
    const l = this.labels.get(charger);
    return l ? { vehicle: l.vehicle, percent: l.percent, text: chargerLabelText(l.percent), position: l.sprite.position.clone(), sprite: l.sprite } : null;
  }

  /** Per frame (plugin `onRender`): create / update / remove labels from the runtime state. */
  update(view: ChargingView): void {
    if (!this.parent || !this.frame) return;
    if (view !== this.view || view.epoch !== this.epoch) {
      this.clear();
      this.view = view;
      this.epoch = view.epoch;
    }
    // Charge over (chargeDone) or the vehicle went elsewhere: the label goes at once.
    if (this.labels.size > 0) {
      for (const l of this.labels.values()) {
        if (view.chargingAt(l.vehicle) !== l.charger) { this.remove(l); this.labels.delete(l.charger); }
      }
    }
    const vehicles = view.cfg.vehicles;
    let now = -1;
    for (let i = 0; i < vehicles.length; i++) {
      const id = vehicles[i];
      const charger = view.chargingAt(id);
      if (!charger) continue;
      const percent = Math.round(view.socAt(id));
      const l = this.labels.get(charger);
      if (!l) {
        if (now < 0) now = this.wallNow();
        const created = this.create(charger, id, percent, now);
        if (created) this.labels.set(charger, created);
        continue;
      }
      if (percent === l.percent) continue;
      if (now < 0) now = this.wallNow();
      if (now - l.drawnAt < CHARGER_LABEL_REFRESH_MS) continue;
      l.percent = percent;
      this.draw(l, now);
    }
  }

  private create(charger: string, vehicle: string, percent: number, now: number): Label | null {
    const yard = chargerLabelYardPosition(charger, this.view?.geometry);
    if (!yard || !this.parent || !this.frame) return null;
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W * SUPERSAMPLE;
    canvas.height = CANVAS_H * SUPERSAMPLE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
    const { sprite, texture } = createLabelSprite(canvas, { layer: HIGHLIGHT_OVERLAY_LAYER, renderOrder: 999, name: `ChargerLabel_${charger}` });
    sprite.scale.set(CHARGER_LABEL_SIZE_M * (CANVAS_W / CANVAS_H), CHARGER_LABEL_SIZE_M, 1);
    this.frame.updateWorldMatrix(true, false);
    const world = new Vector3(yard[0], yard[1], yard[2]).applyMatrix4(this.frame.matrixWorld);
    sprite.position.copy(world);
    this.parent.add(sprite);
    const l: Label = { charger, vehicle, percent, drawnAt: now, canvas, ctx, texture, sprite };
    this.draw(l, now);
    return l;
  }

  private draw(l: Label, now: number): void {
    const { ctx } = l;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = 'rgba(12,12,14,0.82)';
    ctx.beginPath();
    ctx.roundRect(1, 1, CANVAS_W - 2, CANVAS_H - 2, 12);
    ctx.fill();
    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chargerLabelText(l.percent), CANVAS_W / 2, CANVAS_H / 2 + 1, CANVAS_W - 16);
    l.texture.needsUpdate = true;
    l.drawnAt = now;
    this.redraws++;
  }

  private remove(l: Label): void {
    l.sprite.removeFromParent();
    l.sprite.material.dispose();
    l.texture.dispose();
  }
}
