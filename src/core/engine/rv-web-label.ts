// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-label.ts — `WebLabel`: a text label on a node in the 3D scene
 * (plan-529). WEB-ONLY — there is no Unity counterpart, so the type is not part
 * of rv-ODT v1 (`OUT_OF_SCOPE_EXACT` in `tests/spec-loading.test.ts`) and its
 * schema lives inline here, like `NodeKnowledge`.
 *
 * Two looks, selected by `Mode`:
 *   - **Billboard** — a camera-facing sprite with a constant on-screen size in
 *     CSS pixels, always readable, drawn on the overlay layer. Built ONLY through
 *     `rv-label-sprite.ts` (the label contract).
 *   - **Plate** — a flat sign in the node-local XY plane facing local +Z,
 *     depth-tested and occluded by geometry (`rv-label-plate.ts`, the documented
 *     exception to the sprite contract).
 *
 * Content: multi-line plain text (`\n`), font size, text/background colour
 * (Unity `Color {r,g,b,a}` — RGB via `parseColorToHex`, alpha read separately
 * because that helper drops it), an optional http/https link, a node-local
 * offset and a per-label maximum distance. Everything per frame (screen size,
 * fade, the global `labels` overlay toggle) and the link click belong to the
 * viewer-owned {@link WebLabelManager}; the component only builds the visual.
 *
 * Units: `Offset`, `PlateWidth`, `PlateHeight` in mm (node-local), `FontSize` in
 * CSS px for a Billboard and in mm text height for a Plate (0 = mode default),
 * `MaxDistance` in m (0 = unlimited).
 *
 * Capabilities: static `pick:'none'` (never in the component pick / action
 * dispatch — the manager owns label clicks), `authorable`, bake left at the
 * default `merge` (the node survives through `claimsNode`).
 *
 * The runtime visual is flagged `_rvWebLabel` and pruned by the GLB exporter,
 * so a save writes the `WebLabel` extras only.
 */

import type { Object3D, Sprite, SpriteMaterial } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import {
  createLabelSprite,
  labelRoundedRect,
  makeLabelCanvas,
  replaceLabelTexture,
  type LabelSpriteHandles,
} from './rv-label-sprite';
import {
  LABEL_PLATE_STANDOFF_M,
  buildLabelPlate,
  disposeLabelPlate,
  replaceLabelPlateTexture,
  setLabelPlateSize,
  type LabelPlateHandles,
} from './rv-label-plate';
import { parseColorToHex } from './rv-error-visual';
import type { WebLabelManager, WebLabelVisual, ManagedWebLabel } from './rv-web-label-manager';
import { registerOverlayProducer, unregisterOverlayProducer } from '../overlay-visibility-store';
import { isSafeExternalUrl } from '../hmi/help-url';

// ─── Constants ─────────────────────────────────────────────────────────

export const WEB_LABEL_TYPE = 'WebLabel';
export type WebLabelMode = 'Billboard' | 'Plate';

/** Maximum characters of `Text` that are drawn. */
export const WEB_LABEL_MAX_TEXT = 500;
/** Maximum number of drawn lines. */
export const WEB_LABEL_MAX_LINES = 20;
/** Billboard default on-screen font size (CSS px) when `FontSize` is 0. */
export const BILLBOARD_DEFAULT_FONT_PX = 12;
/** Plate default text height (mm) when `FontSize` is 0. */
export const PLATE_DEFAULT_FONT_MM = 20;

/** Logical font size a Billboard canvas is drawn at (screen size is the manager's job). */
const BILLBOARD_DRAW_PX = 32;
/** Logical font size a Plate canvas is drawn at, before the size cap. */
const PLATE_DRAW_PX = 48;
/** Largest logical canvas side (×2 supersample → 4096 physical). */
const MAX_CANVAS_SIDE = 2048;
/** Without a manager (embed facade): world metres per CSS px of a Billboard. */
const UNMANAGED_M_PER_PX = 0.002;

export interface RGBA { r: number; g: number; b: number; a: number }

export const DEFAULT_TEXT_COLOR: Readonly<RGBA> = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });
/** Dark glass — the HMI tooltip card fill `rgba(18,18,18,0.88)` (TooltipLayer.tsx), so a
 *  label reads as the same UI as the hover card it stands for. */
export const DEFAULT_BACKGROUND_COLOR: Readonly<RGBA> = Object.freeze({ r: 0.0706, g: 0.0706, b: 0.0706, a: 0.88 });

/** The HMI type face (theme.ts `fontFamily`), with the system fallbacks. */
const FONT_FAMILY = '"Inter", "Roboto", "Segoe UI", Helvetica, Arial, sans-serif';
/** Hairline around the glass box — the tooltip card border, white at 10 %. */
const BOX_BORDER = 'rgba(255, 255, 255, 0.10)';
/** Horizontal padding, as a fraction of the font size (per side). */
const PAD_X = 0.85;
/** Vertical padding, as a fraction of the font size (per side). */
const PAD_Y = 0.5;
/** Line height, as a fraction of the font size. */
const LINE_HEIGHT = 1.22;
/** Corner radius, as a fraction of the font size (≈ 4 px at 12 px — the tooltip card radius). */
const RADIUS = 0.35;
/** Border width of an emphasised label (hovered / selected node), as a fraction
 *  of the font size (≈ 2 px on screen at 12 px). */
const EMPHASIS_BORDER = 0.17;

/** `0xRRGGBB` → CSS colour for the emphasis border. */
export function hexToCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

// ─── Pure helpers (exported for tests) ─────────────────────────────────

/**
 * Read a Unity `Color {r,g,b,a}`. RGB through `parseColorToHex` (the shared
 * parser); alpha separately (that parser drops it). Missing / malformed RGB →
 * `fallback`; a valid RGB without a usable alpha → alpha 1.
 */
export function readLabelColor(raw: unknown, fallback: Readonly<RGBA>): RGBA {
  const hex = parseColorToHex(raw, -1);
  if (hex < 0) return { ...fallback };
  const a = Number((raw as { a?: unknown }).a);
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
    a: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1,
  };
}

/** CSS `rgba()` for a colour. */
export function rgbaCss(c: RGBA): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${Math.max(0, Math.min(1, c.a))})`;
}

/** The drawn lines of a `Text` value: capped length, `\r\n` tolerant, capped count. */
export function splitLabelLines(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const capped = text.length > WEB_LABEL_MAX_TEXT ? text.slice(0, WEB_LABEL_MAX_TEXT) : text;
  if (!capped.trim()) return [];
  return capped.replace(/\r\n?/g, '\n').split('\n').slice(0, WEB_LABEL_MAX_LINES);
}

/** Box metrics of a text block, all in logical canvas pixels. */
export interface LabelBlockMetrics {
  width: number;
  height: number;
  lineHeight: number;
}

function fontSpec(px: number): string {
  return `600 ${px}px ${FONT_FAMILY}`;
}

let _measureCtx: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (_measureCtx === undefined) {
    _measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  return _measureCtx;
}

/** Measure the boxed block for `lines` drawn at `fontPx`. */
export function measureLabelBlock(lines: readonly string[], fontPx: number): LabelBlockMetrics {
  const ctx = measureCtx();
  let maxW = 0;
  if (ctx) {
    ctx.font = fontSpec(fontPx);
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
  } else {
    for (const line of lines) maxW = Math.max(maxW, line.length * fontPx * 0.55);
  }
  const lineHeight = fontPx * LINE_HEIGHT;
  return {
    width: Math.ceil(maxW + fontPx * PAD_X * 2),
    height: Math.ceil(lines.length * lineHeight + fontPx * PAD_Y * 2),
    lineHeight,
  };
}

/**
 * Draw the glass box and the centred lines into a (pre-scaled) context: a
 * rounded dark-glass fill, a white hairline and the text — the same look as
 * the in-scene badges, so a label reads as part of the HMI and not as a
 * sticker. A background with alpha 0 draws the text alone.
 */
export function drawLabelBlock(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lines: readonly string[],
  fontPx: number,
  textColor: RGBA,
  backgroundColor: RGBA,
  emphasisColor: string | null = null,
): void {
  ctx.clearRect(0, 0, w, h);
  if (backgroundColor.a > 0 || emphasisColor) {
    const radius = Math.min(fontPx * RADIUS, w / 2, h / 2);
    // Hairline: inset by half its width so it is not clipped by the canvas edge.
    // Emphasised (the node is hovered / selected): a thicker border in the
    // channel's colour replaces the hairline — the same outline the object gets.
    const line = emphasisColor ? Math.max(2, fontPx * EMPHASIS_BORDER) : Math.max(1, fontPx / 16);
    if (backgroundColor.a > 0) {
      ctx.fillStyle = rgbaCss(backgroundColor);
      labelRoundedRect(ctx, 0, 0, w, h, radius);
      ctx.fill();
    }
    ctx.strokeStyle = emphasisColor ?? BOX_BORDER;
    ctx.lineWidth = line;
    labelRoundedRect(ctx, line / 2, line / 2, w - line, h - line, Math.max(0, radius - line / 2));
    ctx.stroke();
  }
  ctx.fillStyle = rgbaCss(textColor);
  ctx.font = fontSpec(fontPx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineHeight = fontPx * LINE_HEIGHT;
  const y0 = h / 2 - (lines.length * lineHeight) / 2 + lineHeight / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], w / 2, y0 + i * lineHeight);
}

/** Result of laying out a Plate: canvas + physical size. */
export interface PlateLayout {
  canvas: HTMLCanvasElement;
  widthMm: number;
  heightMm: number;
}

/**
 * Lay out and draw a Plate. `FontSize` is the text height in mm; an auto
 * dimension (0) comes from the measured block, an explicit one is respected and
 * the text shrinks to fit. The canvas keeps the plate's aspect (no stretch).
 */
export function layoutPlate(
  lines: readonly string[],
  fontMm: number,
  plateWidthMm: number,
  plateHeightMm: number,
  textColor: RGBA,
  backgroundColor: RGBA,
  emphasisColor: string | null = null,
): PlateLayout {
  const block = measureLabelBlock(lines, PLATE_DRAW_PX);
  const mmPerPx = fontMm / PLATE_DRAW_PX;
  const textWmm = block.width * mmPerPx;
  const textHmm = block.height * mmPerPx;
  const widthMm = plateWidthMm > 0 ? plateWidthMm : textWmm;
  const heightMm = plateHeightMm > 0 ? plateHeightMm : textHmm;
  const fit = Math.min(1, widthMm / textWmm, heightMm / textHmm);
  let wPx = widthMm / mmPerPx;
  let hPx = heightMm / mmPerPx;
  let fontPx = PLATE_DRAW_PX * fit;
  const cap = MAX_CANVAS_SIDE / Math.max(wPx, hPx);
  if (cap < 1) {
    wPx *= cap;
    hPx *= cap;
    fontPx *= cap;
  }
  const canvas = makeLabelCanvas(Math.max(1, wPx), Math.max(1, hPx), (ctx, w, h) =>
    drawLabelBlock(ctx, w, h, lines, fontPx, textColor, backgroundColor, emphasisColor));
  return { canvas, widthMm, heightMm };
}

/** Lay out and draw a Billboard canvas; returns it with its logical height. */
export function layoutBillboard(
  lines: readonly string[],
  textColor: RGBA,
  backgroundColor: RGBA,
  emphasisColor: string | null = null,
): { canvas: HTMLCanvasElement; logicalHeight: number; logicalWidth: number } {
  const block = measureLabelBlock(lines, BILLBOARD_DRAW_PX);
  const canvas = makeLabelCanvas(block.width, block.height, (ctx, w, h) =>
    drawLabelBlock(ctx, w, h, lines, BILLBOARD_DRAW_PX, textColor, backgroundColor, emphasisColor));
  return { canvas, logicalHeight: block.height, logicalWidth: block.width };
}

// ─── Schema ────────────────────────────────────────────────────────────

/** Inline schema — WEB-only, no rv-ODT `$def` (see file doc). */
export const WEB_LABEL_SCHEMA: ComponentSchema = {
  Mode: { type: 'enum', enumMap: { Billboard: 'Billboard', Plate: 'Plate' }, default: 'Billboard' },
  Text: { type: 'string', default: '' },
  Url: { type: 'string', default: '' },
  FontSize: { type: 'number', default: 0 },
  TextColor: { type: 'json', default: { ...DEFAULT_TEXT_COLOR } },
  BackgroundColor: { type: 'json', default: { ...DEFAULT_BACKGROUND_COLOR } },
  PlateWidth: { type: 'number', default: 0, unit: 'mm' },
  PlateHeight: { type: 'number', default: 0, unit: 'mm' },
  Offset: { type: 'vector3', default: { x: 0, y: 0, z: 0 } },
  MaxDistance: { type: 'number', default: 0, unit: 'm' },
};

// ─── Component ─────────────────────────────────────────────────────────

/** Mutable form of the manager-facing visual, owned by the component. */
interface OwnVisual extends WebLabelVisual {
  kind: 'Billboard' | 'Plate';
  object: Object3D;
  material: SpriteMaterial | LabelPlateHandles['material'];
  screenHeightPx: number;
  aspect: number;
  maxDistanceM: number;
  linkUrl: string | null;
  sprite?: LabelSpriteHandles;
  plate?: LabelPlateHandles;
}

const _warnedUrls = new Set<string>();

export class RVWebLabel implements RVComponent, ManagedWebLabel {
  static readonly schema = WEB_LABEL_SCHEMA;

  readonly node: Object3D;
  isOwner = true;

  Mode: WebLabelMode = 'Billboard';
  Text = '';
  Url = '';
  FontSize = 0;
  TextColor: unknown = { ...DEFAULT_TEXT_COLOR };
  BackgroundColor: unknown = { ...DEFAULT_BACKGROUND_COLOR };
  PlateWidth = 0;
  PlateHeight = 0;
  Offset: unknown = { x: 0, y: 0, z: 0 };
  MaxDistance = 0;

  private _visual: OwnVisual | null = null;
  private _manager: WebLabelManager | null = null;
  /** Border colour while the node is hovered / selected (CSS), else null. */
  private _emphasis: string | null = null;

  /**
   * Emphasise the label (the node it names is hovered or selected): redraws
   * the box with a border in `color` (`0xRRGGBB`), `null` restores the plain
   * look. The manager drives it from the viewer's hover / selection state;
   * a no-op when the state did not change.
   */
  setEmphasis(color: number | null): void {
    const next = color === null ? null : hexToCss(color);
    if (next === this._emphasis) return;
    this._emphasis = next;
    if (this._visual) this._redraw(this._visual);
  }
  private _producerRegistered = false;
  private _initialized = false;
  /** Keys of the last applied config (reapplyConfig diff). */
  private _modeKey = '';
  private _contentKey = '';

  constructor(node: Object3D) {
    this.node = node;
  }

  /** IMPLEMENTS ManagedWebLabel::visual */
  get visual(): WebLabelVisual | null {
    return this._visual;
  }

  init(ctx: ComponentContext): void {
    this._manager = ctx.webLabelManager ?? null;
    this._initialized = true;
    this._rebuild();
    if (!this._producerRegistered) {
      registerOverlayProducer('labels');
      this._producerRegistered = true;
    }
    this._manager?.register(this);
  }

  /**
   * Live edit (editor `setField` / `unsetField`, SOL #6): minimal work per diff —
   * text / colour / font / size → redraw + texture swap (+ new plate geometry
   * for every auto or changed dimension); Mode → dispose and build the other
   * kind; Offset → move; Url / MaxDistance → manager-facing fields only.
   */
  reapplyConfig(): void {
    if (!this._initialized) return;
    const mode = this._mode();
    const contentKey = this._computeContentKey();
    const v = this._visual;
    if (!v || mode !== this._modeKey) {
      this._rebuild();
    } else if (contentKey !== this._contentKey) {
      this._redraw(v);
      this._contentKey = contentKey;
    }
    const cur = this._visual;
    if (cur) {
      this._applyOffset(cur);
      cur.maxDistanceM = this._maxDistance();
      cur.linkUrl = this._linkUrl();
      this._manager?.invalidate(this);
    }
  }

  dispose(): void {
    this._manager?.unregister(this);
    this._disposeVisual();
    if (this._producerRegistered) {
      unregisterOverlayProducer('labels');
      this._producerRegistered = false;
    }
    this._initialized = false;
  }

  // ── Config readers ──────────────────────────────────────────────────

  private _mode(): WebLabelMode {
    return this.Mode === 'Plate' ? 'Plate' : 'Billboard';
  }

  private _fontSize(mode: WebLabelMode): number {
    const f = Number(this.FontSize);
    if (Number.isFinite(f) && f > 0) return f;
    return mode === 'Plate' ? PLATE_DEFAULT_FONT_MM : BILLBOARD_DEFAULT_FONT_PX;
  }

  private _maxDistance(): number {
    const d = Number(this.MaxDistance);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  private _linkUrl(): string | null {
    const raw = typeof this.Url === 'string' ? this.Url.trim() : '';
    if (!raw) return null;
    if (isSafeExternalUrl(raw)) return raw;
    if (!_warnedUrls.has(raw)) {
      _warnedUrls.add(raw);
      console.warn(`[WebLabel] ignoring unsafe or invalid Url "${raw}" — only absolute http/https links open`);
    }
    return null;
  }

  private _offsetM(): { x: number; y: number; z: number } {
    const o = (this.Offset ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return { x: n(o.x) / 1000, y: n(o.y) / 1000, z: n(o.z) / 1000 };
  }

  private _computeContentKey(): string {
    return JSON.stringify([
      this.Text, this.FontSize, this.TextColor, this.BackgroundColor, this.PlateWidth, this.PlateHeight,
    ]);
  }

  // ── Visual ──────────────────────────────────────────────────────────

  private _rebuild(): void {
    this._disposeVisual();
    const mode = this._mode();
    this._modeKey = mode;
    this._contentKey = this._computeContentKey();
    const lines = splitLabelLines(this.Text);
    if (lines.length === 0) return; // nothing to draw
    const textColor = readLabelColor(this.TextColor, DEFAULT_TEXT_COLOR);
    const bgColor = readLabelColor(this.BackgroundColor, DEFAULT_BACKGROUND_COLOR);

    let visual: OwnVisual;
    if (mode === 'Billboard') {
      const { canvas, logicalHeight, logicalWidth } = layoutBillboard(lines, textColor, bgColor, this._emphasis);
      const sprite = createLabelSprite(canvas, { name: '__rvWebLabelBillboard' });
      sprite.sprite.userData._rvWebLabel = true;
      visual = {
        kind: 'Billboard',
        object: sprite.sprite,
        material: sprite.material,
        screenHeightPx: logicalHeight * (this._fontSize(mode) / BILLBOARD_DRAW_PX),
        aspect: logicalWidth / Math.max(1, logicalHeight),
        maxDistanceM: this._maxDistance(),
        linkUrl: this._linkUrl(),
        sprite,
      };
    } else {
      const layout = layoutPlate(lines, this._fontSize(mode), Number(this.PlateWidth) || 0,
        Number(this.PlateHeight) || 0, textColor, bgColor, this._emphasis);
      const plate = buildLabelPlate(layout.canvas, layout.widthMm / 1000, layout.heightMm / 1000);
      visual = {
        kind: 'Plate',
        object: plate.mesh,
        material: plate.material,
        screenHeightPx: 0,
        aspect: layout.widthMm / Math.max(1e-6, layout.heightMm),
        maxDistanceM: this._maxDistance(),
        linkUrl: this._linkUrl(),
        plate,
      };
    }
    this._visual = visual;
    this._applyOffset(visual);
    this.node.add(visual.object);
    if (!this._manager) {
      // No manager (embed facade / minimal host): fixed world size, always visible.
      if (visual.kind === 'Billboard') {
        const h = visual.screenHeightPx * UNMANAGED_M_PER_PX;
        visual.object.scale.set(h * visual.aspect, h, 1);
      }
    } else {
      this._manager.invalidate(this);
    }
  }

  private _redraw(v: OwnVisual): void {
    const lines = splitLabelLines(this.Text);
    if (lines.length === 0) {
      this._disposeVisual();
      return;
    }
    const textColor = readLabelColor(this.TextColor, DEFAULT_TEXT_COLOR);
    const bgColor = readLabelColor(this.BackgroundColor, DEFAULT_BACKGROUND_COLOR);
    if (v.kind === 'Billboard' && v.sprite) {
      const { canvas, logicalHeight, logicalWidth } = layoutBillboard(lines, textColor, bgColor, this._emphasis);
      v.sprite.texture = replaceLabelTexture(v.sprite.sprite as Sprite, canvas);
      v.sprite.aspect = logicalWidth / Math.max(1, logicalHeight);
      v.aspect = v.sprite.aspect;
      v.screenHeightPx = logicalHeight * (this._fontSize('Billboard') / BILLBOARD_DRAW_PX);
    } else if (v.plate) {
      const layout = layoutPlate(lines, this._fontSize('Plate'), Number(this.PlateWidth) || 0,
        Number(this.PlateHeight) || 0, textColor, bgColor, this._emphasis);
      replaceLabelPlateTexture(v.plate, layout.canvas);
      setLabelPlateSize(v.plate, layout.widthMm / 1000, layout.heightMm / 1000);
      v.aspect = layout.widthMm / Math.max(1e-6, layout.heightMm);
    }
  }

  private _applyOffset(v: OwnVisual): void {
    const o = this._offsetM();
    v.object.position.set(o.x, o.y, o.z + (v.kind === 'Plate' ? LABEL_PLATE_STANDOFF_M : 0));
    // The owner node may be frozen (`matrixAutoUpdate = false` from the static
    // sweep), in which case the renderer never recomputes this child's world
    // matrix — do it here from the parent's valid one, and keep the visual
    // live so later scale / offset edits take effect (see the manager).
    v.object.matrixAutoUpdate = true;
    v.object.matrixWorldAutoUpdate = true;
    v.object.updateWorldMatrix(false, false);
  }

  private _disposeVisual(): void {
    const v = this._visual;
    if (!v) return;
    this._visual = null;
    if (v.sprite) {
      v.sprite.sprite.removeFromParent();
      v.sprite.texture.dispose();
      v.sprite.material.map?.dispose();
      v.sprite.material.dispose();
    }
    if (v.plate) disposeLabelPlate(v.plate);
  }
}

// ─── Self-register ─────────────────────────────────────────────────────

registerComponent({
  type: WEB_LABEL_TYPE,
  displayName: 'Web Label',
  schema: RVWebLabel.schema,
  capabilities: {
    authorable: true,
    // A label NAMES an object, so the labelled node is a thing the user can
    // hover and select (2026-10-12): `select` makes it a pick owner of its
    // merged geometry in the bake (an owner-less chunk segment only blocks) and
    // a hover target in the editor. Never `action` — the WebLabelManager owns
    // label clicks (link first, then the ordinary selection + focus), and a
    // label must not take part in the component action dispatch (SOL #1).
    pick: 'select',
    ui: { filter: 'Web Labels', category: 'hmi', badge: '#ffb74d' },
  },
  create: (node) => new RVWebLabel(node),
});
