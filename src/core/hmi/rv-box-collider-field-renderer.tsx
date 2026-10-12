// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-box-collider-field-renderer.tsx — inspector rows for `BoxCollider.center`
 * and `BoxCollider.size` (plan-525 F1).
 *
 * The extras hold metres in the Unity convention (the reader negates
 * `center.x`); authors think in millimetres. The rows show and edit the SAME
 * numbers the file holds, scaled to mm — no axis flip, so what the inspector
 * shows is what `web_editor_set_field` writes (÷ 1000). Every edit goes through
 * `persistFieldOp` — the `setField` op of the active edit target, undoable, and
 * the live `RVBoxCollider.reapplyConfig()` moves the gizmo and re-derives a
 * `WebPhysicsZone` on the same node.
 *
 * The size row carries the thin-wall warning: a box thinner than 3 mm along
 * any axis lets fast parts tunnel through (plan-525 §8, Rapier contact skin).
 *
 * Self-registers with the `fieldRendererRegistry` on import (App.tsx).
 */

import { Typography } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { InspectorRow } from './rv-inspector-row';
import { Vector3Editor } from './rv-field-editors';
import { persistFieldOp } from './scene/scene-field-ops';
import { FS, WARN } from './shared-sx';

interface Vec3 { x: number; y: number; z: number }

/** Thin-wall threshold of the size row (mm). */
export const BOX_COLLIDER_MIN_THICKNESS_MM = 3;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const DEFAULT_SIZE: Vec3 = { x: 0.1, y: 0.1, z: 0.1 };

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Raw extras value → metres, defensively (missing axis → default). */
export function boxColliderFieldMetres(value: unknown, fieldName: string): Vec3 {
  const d = fieldName === 'size' ? DEFAULT_SIZE : ZERO;
  const v = value as Partial<Vec3> | null | undefined;
  return { x: num(v?.x, d.x), y: num(v?.y, d.y), z: num(v?.z, d.z) };
}

/** Metres → mm for display (0.1 µm, no float noise). */
export function metresToMm(v: Vec3): Vec3 {
  const r = (n: number): number => Math.round(n * 1e7) / 1e4;
  return { x: r(v.x), y: r(v.y), z: r(v.z) };
}

/** mm → metres for the file (0.1 µm, no float noise). */
export function mmToMetres(v: Vec3): Vec3 {
  const r = (n: number): number => Math.round(n * 1e4) / 1e7;
  return { x: r(v.x), y: r(v.y), z: r(v.z) };
}

/** True when any axis of a size (mm) is below the thin-wall threshold. */
export function isThinBoxMm(sizeMm: Vec3): boolean {
  return Math.min(Math.abs(sizeMm.x), Math.abs(sizeMm.y), Math.abs(sizeMm.z)) < BOX_COLLIDER_MIN_THICKNESS_MM;
}

export function BoxColliderFieldRenderer({ value, fieldName, componentType, nodePath }: FieldRendererProps) {
  const metres = boxColliderFieldMetres(value, fieldName);
  const mm = metresToMm(metres);
  const label = fieldName === 'size' ? 'Size (mm)' : 'Center (mm)';
  const onChange = (next: Vec3): void => {
    persistFieldOp(nodePath, componentType, fieldName, mmToMetres(next), value);
  };
  const thin = fieldName === 'size' && isThinBoxMm(mm);
  return (
    <>
      <InspectorRow
        label={label}
        labelTitle={fieldName === 'size'
          ? 'Box size along the local axes, in millimetres (stored in metres)'
          : 'Box centre in node-local Unity coordinates, in millimetres (stored in metres)'}
        fullWidthField
      >
        <Vector3Editor value={mm} onChange={onChange} />
      </InspectorRow>
      {thin && (
        <InspectorRow label="">
          <Typography data-testid="box-collider-thin-warning" sx={{ fontSize: FS.label, color: WARN }}>
            Thinner than 3 mm: fast parts may tunnel through
          </Typography>
        </InspectorRow>
      )}
    </>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({ componentType: 'BoxCollider', fieldName: 'center', component: BoxColliderFieldRenderer });
fieldRendererRegistry.register({ componentType: 'BoxCollider', fieldName: 'size', component: BoxColliderFieldRenderer });
