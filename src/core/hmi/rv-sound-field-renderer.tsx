// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sound-field-renderer.tsx — inspector editors of the `Sound` component (plan-2019 §2.4).
 *
 * - `Variant` (label "Type"): a choice filtered by the EFFECTIVE kind (Drive:
 *   Large / Medium / Small, Cylinder: Hard / Cushioned, Hydraulic: Auto only),
 *   with the Auto result shown greyed next to it ("Auto → Medium"), plus the
 *   "Preview" button (1 s run-up or one stroke; works with sound globally off —
 *   the click creates the audio context).
 * - `Volume`: a 0–100 % slider with a number field, bounded at the input.
 * `Kind` keeps the generic enum row. The legacy `SoundType` / `Mode` fields have
 * `scope: 'none'` and no row at all.
 *
 * Self-registers with the `fieldRendererRegistry`; imported by `App.tsx`.
 */

import { useEffect, useState } from 'react';
import { Box, Button, Slider, Typography } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { InspectorRow } from './rv-inspector-row';
import { InspectorActionRow, inspectorActionButtonSx } from './rv-inspector-blocks';
import { EnumEditor, NumberEditor } from './rv-field-editors';
import { FS, INK_LOW } from './shared-sx';
import { NodeRegistry } from '../engine/rv-node-registry';
import {
  SOUND_TYPE, SOUND_VARIANTS_OF_KIND, autoVariantOf, effectiveKindOf,
  type RVSound, type SoundKind, type SoundVariant,
} from '../engine/rv-sound';
import { SOUND_SYSTEM_PLUGIN_ID, type SoundSystemPlugin } from '../../plugins/sound-system-plugin';
import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';

/**
 * The live Sound instance at a node path of THIS viewer, or null. Only the viewer's own
 * SoundSystem is searched (two viewers may show the same paths), and paths are compared
 * through the viewer's registry — the authoritative path, also for placed content.
 */
export function findSoundAt(viewer: RVViewer | null, nodePath: string): RVSound | null {
  const plugin = typeof viewer?.getPlugin === 'function'
    ? viewer.getPlugin<SoundSystemPlugin>(SOUND_SYSTEM_PLUGIN_ID) : undefined;
  if (!viewer || !plugin) return null;
  const registry = viewer.registry as { getPathForNode?(node: Object3D): string | null } | null | undefined;
  for (const s of plugin.sounds) {
    const path = registry?.getPathForNode?.(s.node) ?? NodeRegistry.computeNodePath(s.node);
    if (path === nodePath) return s;
  }
  return null;
}

/** Variant options offered for an authored kind on a node (with/without Drive_Cylinder). */
export function variantOptionsFor(kind: SoundKind, hasCylinder: boolean): SoundVariant[] {
  const eff = effectiveKindOf(kind, hasCylinder);
  return ['Auto', ...SOUND_VARIANTS_OF_KIND[eff]];
}

/** "Auto → Medium" hint for an authored kind. */
export function autoHintFor(kind: SoundKind, hasCylinder: boolean): string {
  const eff = effectiveKindOf(kind, hasCylinder);
  return eff === 'Hydraulic' ? 'Auto → Hydraulic' : `Auto → ${autoVariantOf(eff)}`;
}

function previewSound(viewer: RVViewer | null, sound: RVSound | null): void {
  if (!viewer || !sound) return;
  const plugin = viewer.getPlugin<SoundSystemPlugin>(SOUND_SYSTEM_PLUGIN_ID);
  if (plugin) void plugin.preview(sound);
}

/** `Sound.Variant` — filtered choice, Auto hint and Preview. */
export function SoundVariantRenderer({ value, nodePath, viewer, onEdit }: FieldRendererProps) {
  const sound = findSoundAt(viewer, nodePath);
  const kind: SoundKind = sound?.Kind ?? 'Auto';
  const hasCylinder = !!sound?.cylinder;
  const options = variantOptionsFor(kind, hasCylinder);
  const current = typeof value === 'string' ? value : 'Auto';
  // A stored value the kind does not offer stays visible (it plays as Auto and is in Problems).
  const shown = options.includes(current as SoundVariant) ? options : [current, ...options];
  return (
    <Box data-testid="rv-sound-variant">
      <InspectorRow label="Type" labelTitle="Type of the sound: motor size or end-stop style">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: '100%' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <EnumEditor value={current} options={shown} onChange={(v) => onEdit?.(v)} ariaLabel="Sound type" />
          </Box>
          {current === 'Auto' && (
            <Typography component="span" data-testid="rv-sound-auto-hint" sx={{ fontSize: FS.micro, color: INK_LOW, whiteSpace: 'nowrap' }}>
              {autoHintFor(kind, hasCylinder)}
            </Typography>
          )}
        </Box>
      </InspectorRow>
      <InspectorActionRow data-testid="rv-sound-preview">
        <Button
          size="small"
          variant="outlined"
          disabled={!sound}
          onClick={() => previewSound(viewer, sound)}
          sx={inspectorActionButtonSx}
        >
          Preview
        </Button>
      </InspectorActionRow>
    </Box>
  );
}

/** `Sound.Volume` — 0–100 % slider + number field, bounded at the input. */
export function SoundVolumeRenderer({ value, onEdit }: FieldRendererProps) {
  const stored = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  const pct = Math.round(stored * 100);
  const [drag, setDrag] = useState(pct);
  useEffect(() => { setDrag(pct); }, [pct]);
  const commit = (p: number): void => {
    const clamped = Math.max(0, Math.min(100, p));
    if (clamped / 100 !== stored) onEdit?.(clamped / 100);
  };
  return (
    <InspectorRow label="Volume" labelTitle="Relative volume of this sound" fullWidthField>
      <Box data-testid="rv-sound-volume" sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
        <Slider
          size="small"
          min={0}
          max={100}
          step={1}
          value={drag}
          onChange={(_e, v) => setDrag(v as number)}
          onChangeCommitted={(_e, v) => commit(v as number)}
          slotProps={{ input: { 'aria-label': 'Sound volume percent' } }}
          sx={{ flex: 1, minWidth: 0, py: 0.5 }}
        />
        <Box sx={{ flex: '0 0 35%' }}>
          <NumberEditor value={pct} onChange={commit} min={0} max={100} step={1} unit="%" ariaLabel="Sound volume" />
        </Box>
      </Box>
    </InspectorRow>
  );
}

fieldRendererRegistry.register({ componentType: SOUND_TYPE, fieldName: 'Variant', component: SoundVariantRenderer });
fieldRendererRegistry.register({ componentType: SOUND_TYPE, fieldName: 'Volume', component: SoundVolumeRenderer });
