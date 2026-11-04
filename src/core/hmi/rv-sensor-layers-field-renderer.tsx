// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sensor-layers-field-renderer.tsx — Unity layer-name lists in the Property
 * Inspector: `Sensor.AdditionalRayCastLayers` (plan-2016 S6c) and
 * `WebPhysicsZone.LimitToLayers` (plan-2016 S7).
 *
 * A list of Unity layer names: one chip per layer (× removes it) and a dropdown
 * that adds a layer from the viewer's layer table (`rv-layers.ts`: realvirtual
 * standard + the loaded file's `layerNames`). Every edit goes through
 * `persistFieldOp` — the inspector's undoable `setField`. Entries an old export
 * wrote as `{}` instead of a string are shown as a warning and dropped by the
 * next edit. Empty list = no filter (every layer / every MU).
 *
 * Self-registers with the `fieldRendererRegistry`; imported from App.tsx.
 */

import { Box, Chip, Typography } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { InspectorRow } from './rv-inspector-row';
import { EnumEditor } from './rv-field-editors';
import { persistFieldOp } from './scene/scene-field-ops';
import { FS, INK_MID, WARN } from './shared-sx';
import { getLayerNames, layerNameList } from '../engine/rv-layers';

/** Dropdown placeholder entry. */
export const ADD_LAYER_OPTION = 'Add layer…';

/** Layer names offered by the dropdown: the table's names not yet in the list. */
export function addableLayers(current: readonly string[], table: readonly string[] = getLayerNames()): string[] {
  const out: string[] = [];
  for (const n of table) if (n && !current.includes(n) && !out.includes(n)) out.push(n);
  return out;
}

/** Texts of one layer-list field. */
interface LayerListTexts {
  label: string;
  title: string;
  /** Shown while the list is empty. */
  emptyText: string;
  addAria: string;
  testId: string;
}

function LayerListField({ value, componentType, fieldName, nodePath, texts }: FieldRendererProps & { texts: LayerListTexts }) {
  const names = layerNameList(value);
  const invalid = Array.isArray(value) ? value.length - names.length : 0;
  const commit = (next: string[]): void => {
    persistFieldOp(nodePath, componentType, fieldName, next, value);
  };
  const options = [ADD_LAYER_OPTION, ...addableLayers(names)];
  return (
    <>
      <InspectorRow label={texts.label} labelTitle={texts.title} fullWidthField>
        <Box data-testid={texts.testId} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
          {names.length === 0 && (
            <Typography sx={{ fontSize: FS.label, color: INK_MID }}>{texts.emptyText}</Typography>
          )}
          {names.map((n) => (
            <Chip
              key={n}
              label={n}
              size="small"
              onDelete={() => commit(names.filter((x) => x !== n))}
              sx={{ fontSize: FS.label, height: 18 }}
            />
          ))}
        </Box>
      </InspectorRow>
      <InspectorRow label="">
        <EnumEditor
          value={ADD_LAYER_OPTION}
          options={options}
          ariaLabel={texts.addAria}
          onChange={(v) => { if (v !== ADD_LAYER_OPTION) commit([...names, v]); }}
        />
      </InspectorRow>
      {invalid > 0 && (
        <InspectorRow label="">
          <Typography data-testid={`${texts.testId}-invalid`} sx={{ fontSize: FS.label, color: WARN }}>
            {invalid} invalid entr{invalid === 1 ? 'y' : 'ies'} (old export) — removed by the next edit
          </Typography>
        </InspectorRow>
      )}
    </>
  );
}

const SENSOR_TEXTS: LayerListTexts = {
  label: 'Raycast Layers',
  title: "Layers the raycast hits (Unity layers); the sensor's own layer is added. Empty = every layer.",
  emptyText: 'all layers',
  addAria: 'Add raycast layer',
  testId: 'sensor-ray-layers',
};

const ZONE_TEXTS: LayerListTexts = {
  label: 'Limit To Layers',
  title: 'Only MUs on these Unity layers become rigid bodies in the zone; all others pass it kinematically. Empty = every MU.',
  emptyText: 'all MUs',
  addAria: 'Add MU layer',
  testId: 'zone-limit-layers',
};

export function SensorLayersFieldRenderer(props: FieldRendererProps) {
  return <LayerListField {...props} texts={SENSOR_TEXTS} />;
}

export function ZoneLayersFieldRenderer(props: FieldRendererProps) {
  return <LayerListField {...props} texts={ZONE_TEXTS} />;
}

// ── Self-registration ──
fieldRendererRegistry.register({ componentType: 'Sensor', fieldName: 'AdditionalRayCastLayers', component: SensorLayersFieldRenderer });
fieldRendererRegistry.register({ componentType: 'WebPhysicsZone', fieldName: 'LimitToLayers', component: ZoneLayersFieldRenderer });
