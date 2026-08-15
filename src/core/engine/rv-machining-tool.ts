// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-tool.ts — the `MachiningTool` component (plan-405).
 *
 * 1:1 port of `MachiningTool.cs`: a pure DATA component describing the cutter
 * geometry of a node. It owns no per-frame work and no geometry of its own —
 * {@link MachiningManager} reads the node's `matrixWorld` once per tick,
 * converts it into the grid space of every volume that lists this tool, and
 * builds the swept segments from it.
 *
 * The analytic tool SDFs themselves live in the Rust kernel (`sdf.rs`, ported
 * from the C# statics); this file only mirrors the two DERIVED quantities the
 * kernel needs on top of the raw fields, and they must match `MachiningTool.cs`
 * exactly:
 *   - `coneRadiusTop = radius * tan(taperAngle)`  (ConicalEnd shank radius)
 *   - `boundingRadius` — the corner distance `sqrt(r² + (h/2)²)` for every
 *     cylindrical hull, because the AABB has to stay valid under ARBITRARY tool
 *     rotation. `max(r, h/2)` would clip a tilted cutter.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { TOOL_SHAPE, type MachiningToolShape } from './rv-machining-registry';

/** Tool shape names, in the C# `ToolShape` declaration order. */
export const MACHINING_TOOL_SHAPES = [
  'Sphere', 'Cylinder', 'BallNose', 'Torus', 'ConicalEnd',
] as const;

export type MachiningToolShapeName = (typeof MACHINING_TOOL_SHAPES)[number];

const SHAPE_SET: ReadonlySet<string> = new Set<string>(MACHINING_TOOL_SHAPES);

/** Defensive parse of an authored shape string. Unknown → `'Cylinder'` (the C# default). */
export function toMachiningToolShape(value: unknown): MachiningToolShapeName {
  return typeof value === 'string' && SHAPE_SET.has(value)
    ? (value as MachiningToolShapeName)
    : 'Cylinder';
}

/** Numeric ABI value of a tool shape name. */
export function machiningToolShapeValue(name: MachiningToolShapeName): MachiningToolShape {
  return TOOL_SHAPE[name];
}

const DEG2RAD = Math.PI / 180;

/** The `MachiningTool` component — geometry description only, no runtime work. */
export class RVMachiningTool implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('MachiningTool');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated (PascalCase = C# field names = GLB extras keys) ──
  /** Cutter shape. Read-only in the inspector: the bare field name `Shape` is
   *  shared with `MachiningVolume` (different option set), and the generic
   *  ENUM_FIELDS dropdown is indexed by the bare name — a writable row would
   *  offer the wrong options. Authored in Unity. */
  Shape: MachiningToolShapeName = 'Cylinder';
  /** Diameter in mm. */
  ToolDiameter = 10;
  /** Length/height in mm. */
  ToolLength = 50;
  /** Corner radius in mm (BallNose / Torus). */
  CornerRadius = 2;
  /** Taper half-angle in degrees (ConicalEnd). */
  TaperAngleDeg = 15;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(_ctx: ComponentContext): void {
    this.Shape = toMachiningToolShape(this.Shape);
  }

  reapplyConfig(): void {
    this.Shape = toMachiningToolShape(this.Shape);
  }

  /** Effective radius in mm (half the diameter). */
  get toolRadius(): number {
    return this.ToolDiameter * 0.5;
  }

  /** Radius at the shank end in mm — ConicalEnd only (parity: `ConeRadiusTop`). */
  get coneRadiusTop(): number {
    return this.toolRadius * Math.tan(this.TaperAngleDeg * DEG2RAD);
  }

  /** Numeric shape value for the kernel ABI. */
  get shapeValue(): MachiningToolShape {
    return machiningToolShapeValue(this.Shape);
  }

  /**
   * Maximum extent from the tool origin in mm. Must stay valid for arbitrary
   * rotations, so cylindrical hulls use the CORNER distance — parity with
   * `MachiningTool.GetBoundingRadius()`.
   */
  get boundingRadius(): number {
    const r = this.toolRadius;
    const halfH = this.ToolLength * 0.5;
    const corner = Math.sqrt(r * r + halfH * halfH);
    switch (this.Shape) {
      case 'Sphere': return r;
      case 'Torus': return r;
      default: return corner;
    }
  }

  getLiveState(): Record<string, unknown> {
    return {
      Shape: this.Shape,
      ToolDiameter: this.ToolDiameter,
      ToolLength: this.ToolLength,
      CornerRadius: this.CornerRadius,
      TaperAngleDeg: this.TaperAngleDeg,
    };
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'MachiningTool',
  displayName: 'Machining Tool',
  schema: RVMachiningTool.schema,
  capabilities: {
    authorable: true,
    hoverable: true,
    selectable: true,
    badgeColor: '#5c6bc0',
    filterLabel: 'Machining Tools',
  },
  create: (node) => new RVMachiningTool(node),
  afterCreate: (inst, node) => setComponentInstance(node, inst),
});
