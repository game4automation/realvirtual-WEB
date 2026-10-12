// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-tension-overlay.ts — the readable half of web tension (plan-471 E7).
 *
 * The band tint answers "is this web all right"; it cannot answer "at what
 * tension". This overlay does, in the two places a web handler looks:
 *
 * - **per zone**: `142 N/m | 0.81 PLI | eps 0.42 % v`, with a trend arrow and a
 *   `~` when the sag depth left the range the closed form is good in;
 * - **at a loaded dancer**: the force it presses into the web, and a travel bar
 *   from `TravelMinMm` to `TravelMaxMm` with the carriage on it, because a
 *   tension controller regulates on exactly that position.
 *
 * ## Why an overlay and not a component
 *
 * It is drawn, not modelled: nothing here appears in the document, in the
 * schema, or in the loader. The precedent is `rv-error-visual.ts` — build the
 * gizmos through `GizmoOverlayManager`, bind their lifetime to the owning
 * component, and let `dispose()` take all of them down. A user who never turns
 * `ShowTensionLabels` on pays for none of it: {@link RVRibbonTensionOverlay}
 * creates nothing until it is first shown.
 *
 * ## The anchors
 *
 * A gizmo is attached to a NODE, and a zone label belongs in the middle of a
 * span that moves every tick. So each label owns a tiny empty parented under the
 * path node, and the overlay moves that empty — one position write per zone per
 * update, no gizmo rebuild.
 */

import { Object3D, Vector3 } from 'three';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import { MM_TO_METERS } from './rv-constants';
import type { RVRibbonPath, RibbonTensionZone } from './rv-ribbon-path';
import type { RibbonZoneState } from './ribbon/ribbon-tension-math';
import { pliFromNPerM, specificTension } from './ribbon/ribbon-tension-math';

/** Label colour per zone state — the same language the band tint speaks. */
const LABEL_COLOR: Readonly<Record<RibbonZoneState, number>> = {
  inBand: 0xe8eaed,
  below: 0x2979ff,
  above: 0xff9100,
  slack: 0x00e5ff,
  over: 0xff00d0,
  broken: 0xff00d0,
};

/**
 * The WORD for each zone state — a colour alone does not name a fault.
 *
 * `inBand` is silent on purpose: a good web is the normal case, and saying so on
 * every span would be noise that hides the one span that is not.
 *
 * `over` and `broken` share a tint (both are the magenta alarm), so the word is
 * the ONLY thing that tells an overstretched web from a torn one.
 */
const STATE_WORD: Readonly<Record<RibbonZoneState, string>> = {
  inBand: '',
  below: 'LOW',
  above: 'HIGH',
  slack: 'SLACK',
  over: 'OVERSTRETCHED',
  broken: 'TORN',
};

/** Strain change per update above which the trend arrow is drawn at all. */
const TREND_EPSILON = 1e-6;

/** World metres a label floats above the point it describes, so it clears the web. */
const LABEL_LIFT = 0.12;

const _world = new Vector3();

/** One zone's label plus the anchor it hangs on. */
interface ZoneLabel {
  anchor: Object3D;
  gizmo: GizmoHandle;
  /** The strain at the previous update, for the trend arrow. */
  lastEps: number;
  /** What the label last said, so an unchanged string is not re-rasterised. */
  lastText: string;
  lastColor: number;
}

/**
 * The tension overlay of ONE `RibbonPath`. Created lazily, torn down completely.
 */
export class RVRibbonTensionOverlay {
  private readonly _labels: ZoneLabel[] = [];
  private _shown = false;

  constructor(
    private readonly _path: RVRibbonPath,
    private readonly _gizmos: GizmoOverlayManager,
  ) {}

  /** True while anything is on screen (diagnostics + tests). */
  get isShown(): boolean {
    return this._shown;
  }

  /** Number of zone labels currently alive (diagnostics + tests). */
  get labelCount(): number {
    return this._labels.length;
  }

  /**
   * Bring the overlay in step with the path: create what is missing, remove
   * what is no longer there, and refresh the texts.
   *
   * Called once per tick from the path. The expensive part of a text gizmo is
   * rasterising its texture, so a label whose string did not change is left
   * completely alone — which, at a steady tension, is every label.
   */
  update(): void {
    // The two halves are switched INDEPENDENTLY (see `RibbonDancer.ShowTravel`):
    // the numbers are a readout an operator turns off, the dancer's track is part
    // of the machine and stays.
    const wantValues = this._path.ShowTensionLabels && this._path.tensionEnabled;
    // Fault messages remain active independently in the message panel.
    if (!wantValues) {
      if (this._shown) this._hide();
      return;
    }
    this._shown = true;
    this._syncZoneLabels();
  }

  /** True while the value labels are on (diagnostics + tests). */
  get valuesShown(): boolean {
    return this._labels.length > 0;
  }

  /** Take every gizmo and anchor down; idempotent. */
  dispose(): void {
    this._hide();
  }

  // -- Zones ------------------------------------------------------

  /** One diagnostic readout per tension zone. */
  private _syncZoneLabels(): void {
    const zones = this._path.zones;
    while (this._labels.length > zones.length) this._disposeLabel(this._labels.pop()!);
    while (this._labels.length < zones.length) this._labels.push(this._createLabel());

    for (let k = 0; k < zones.length; k++) {
      const zone = zones[k];
      const label = this._labels[k];
      this._placeAnchor(label.anchor, zone);
      this._followAnchor(label.gizmo, label.anchor);
      const text = this._describe(zone, label.lastEps);
      const color = LABEL_COLOR[zone.state];
      if (text !== label.lastText || color !== label.lastColor) {
        label.gizmo.update({ text, color });
        label.lastText = text;
        label.lastColor = color;
      }
      label.lastEps = zone.eps;
    }
  }

  /**
   * `142 N/m | 0.81 PLI | eps 0.42 % v  HIGH`, with `~` for an estimated sag.
   *
   * The state WORD comes last and is empty for a good web, so the readout of a
   * line running normally is the numbers and nothing else. It replaces the
   * `TORN`-only marker this used to carry: `LOW` / `HIGH` name the two states the
   * label already coloured but never named, and `OVERSTRETCHED` separates the two
   * that share the magenta alarm tint.
   */
  private _describe(zone: RibbonTensionZone, previousEps: number): string {
    const nPerM = specificTension(zone.tensionN, this._path.RibbonWidthMm);
    const delta = zone.eps - previousEps;
    const trend = delta > TREND_EPSILON ? '^' : delta < -TREND_EPSILON ? 'v' : '-';
    const mark = zone.estimated ? ' ~' : '';
    const word = STATE_WORD[zone.state];
    return `${nPerM.toFixed(0)} N/m | ${pliFromNPerM(nPerM).toFixed(2)} PLI`
      + ` | eps ${(zone.eps * 100).toFixed(2)} % ${trend}${mark}${word ? `  ${word}` : ''}`;
  }

  /**
   * Put the anchor at the middle of the zone's colour range, in the path node's
   * own frame — which is the frame the sample buffer is written in, so the label
   * follows a sagging web down rather than hovering over where it used to be.
   */
  private _placeAnchor(anchor: Object3D, zone: RibbonTensionZone): void {
    const buffer = this._path.sampleBuffer;
    const count = this._path.sampleCount;
    if (count < 1) return;
    // Along the zone at this strip's own LANE fraction, not at its midpoint.
    //
    // The strips of a slitter run a few hundred millimetres apart along the
    // roller axis, so a camera looking near that axis projects every strip's
    // label for the same zone onto the same pixels — which is a pile of
    // overprinted text, not a readout. Spreading them along the WEB separates
    // them from almost every angle, because the strips diverge after the slit.
    //
    // `(lane + 1) / (lanes + 1)`: one strip lands on 1/2 — the midpoint it has
    // always used — two on 1/3 and 2/3, and so on.
    const lanes = Math.max(1, this._path.labelLaneCount);
    const fraction = (Math.min(this._path.labelLane, lanes - 1) + 1) / (lanes + 1);
    const from = zone.colorFromSample;
    const span = zone.colorToSample - from;
    const at3 = Math.round(from + span * fraction);
    const middle = Math.min(count - 1, Math.max(0, at3));
    const at = middle * 9;
    // The sample buffer is in MILLIMETRES; the scene is in metres. This used to
    // MULTIPLY by the constant, which put the anchor a thousand times too far
    // out — invisible only because nothing read it back (see `_followAnchor`).
    anchor.position.set(
      buffer[at] / MM_TO_METERS, buffer[at + 1] / MM_TO_METERS, buffer[at + 2] / MM_TO_METERS,
    );
    anchor.updateMatrix();
    anchor.updateMatrixWorld(true);
  }

  /**
   * Move a text gizmo onto its anchor, every tick.
   *
   * A `text` gizmo does NOT honour `attachToNode`: `GizmoOverlayManager` adds the
   * sprite to the SCENE and positions it once, at creation, from the attachment
   * node's world bounds. For a static label on a machine part that is right; for
   * a label on a span that is re-solved every tick, and on a dancer carriage that
   * travels, it means the text is placed once at the path node's origin and stays
   * there for ever — which is why a slitter showed every strip's readouts piled
   * up in one spot, nowhere near the web they describe.
   *
   * `GizmoHandle.root` is documented as the hook for exactly this ("callers can
   * apply per-frame transforms"), so the fix lives here rather than in the shared
   * manager, where it would change where every other text gizmo in the viewer
   * sits.
   */
  private _followAnchor(gizmo: GizmoHandle, anchor: Object3D): void {
    anchor.getWorldPosition(_world);
    _world.y += LABEL_LIFT;
    gizmo.root.position.copy(_world);
  }

  private _createLabel(): ZoneLabel {
    const anchor = new Object3D();
    anchor.name = '__rvTensionLabel';
    this._path.node.add(anchor);
    const gizmo = this._gizmos.create(anchor, {
      shape: 'text',
      color: LABEL_COLOR.inBand,
      opacity: 1,
      text: '',
      attachToNode: true,
      excludeFromRaycast: true,
      depthTest: false,
      category: 'status',
    });
    return { anchor, gizmo, lastEps: 0, lastText: '', lastColor: LABEL_COLOR.inBand };
  }

  private _disposeLabel(label: ZoneLabel): void {
    label.gizmo.dispose();
    label.anchor.removeFromParent();
  }

  // -- Teardown ---------------------------------------------------

  private _hide(): void {
    this._shown = false;
    this._hideZoneLabels();
  }

  /** Drop the zone labels. The dancer draws its own gizmos and is untouched. */
  private _hideZoneLabels(): void {
    while (this._labels.length > 0) this._disposeLabel(this._labels.pop()!);
  }

}
