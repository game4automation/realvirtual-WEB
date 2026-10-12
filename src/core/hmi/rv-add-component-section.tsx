// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AddComponentSection — Unity-style "Add Component" affordance at the bottom
 * of the property inspector. Rendered ONLY while the active EditTarget
 * supports component authoring (i.e. the asset editor is active); outside the
 * editor the section is absent entirely.
 *
 * The candidate list is every component type whose registry capabilities
 * declare `authorable: true` (schema-complete types); initial field values
 * come from `getSchemaDefaults`. The `_N` key dedup happens inside the
 * document's addComponent.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  InputAdornment,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
} from '@mui/material';
import { Add, Search } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import {
  getTypesWithCapability,
  getDisplayName,
  getSchemaDefaults,
} from '../engine/rv-component-registry';
// `isDriveExtension` lives in the schema-info data layer (plan-517): the same
// function gates this list AND sets `requiresDriveOnSameNode` in
// `web_component_schema`, so the inspector and what agents are told agree.
import { isDriveExtension } from '../engine/rv-component-schema-info';
import { getActiveEditTarget } from './rv-edit-target';

export interface AddComponentSectionProps {
  viewer: RVViewer;
  nodePath: string;
}

/** Types offered at the top of the list, in this order (plan-521: `Zone` is the
 *  preferred way to author stoppers, sensor boxes, clamps and lifts). */
const PREFERRED_TYPES: readonly string[] = ['Zone'];

function preferredRank(type: string): number {
  const i = PREFERRED_TYPES.indexOf(type);
  return i < 0 ? PREFERRED_TYPES.length : i;
}

export function AddComponentSection({ viewer, nodePath }: AddComponentSectionProps) {
  // Re-render on workspace-mode changes so the affordance appears/disappears
  // with the asset editor's EditTarget.
  useSyncExternalStore(viewer.modes.subscribe, viewer.modes.getSnapshot);
  const target = getActiveEditTarget();

  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState('');

  // Drive behaviours (`Drive_*`) and drive add-ons extend a Drive on the SAME
  // node — without one they would sit inert (their init() finds no Drive and
  // bails). They are offered only while the node carries a Drive, either as a
  // registered instance or as an authored rv_extras record.
  const nodeHasDrive = useMemo(() => {
    if (viewer.registry?.getByPath('Drive', nodePath)) return true;
    const rv = viewer.registry?.getNode(nodePath)?.userData?.realvirtual as Record<string, unknown> | undefined;
    return !!rv && Object.keys(rv).some((key) => key.replace(/_\d+$/, '') === 'Drive');
  }, [viewer, nodePath]);

  const candidates = useMemo(() => {
    const types = getTypesWithCapability('authorable');
    return types
      .filter((type) => nodeHasDrive || !isDriveExtension(type))
      .map((type) => ({ type, label: getDisplayName(type) }))
      .sort((a, b) => preferredRank(a.type) - preferredRank(b.type) || a.label.localeCompare(b.label));
  }, [nodeHasDrive]);

  if (!target.addComponent) return null;

  const filtered = search
    ? candidates.filter((c) =>
        c.label.toLowerCase().includes(search.toLowerCase()) ||
        c.type.toLowerCase().includes(search.toLowerCase()))
    : candidates;

  const close = () => { setAnchor(null); setSearch(''); };
  const add = (baseType: string) => {
    close();
    getActiveEditTarget().addComponent?.(nodePath, baseType, getSchemaDefaults(baseType));
  };

  return (
    <Box sx={{ px: 1, py: 1, display: 'flex', justifyContent: 'center' }}>
      <Button
        size="small"
        variant="outlined"
        startIcon={<Add sx={{ fontSize: 14 }} />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ fontSize: '0.72rem', px: 1.5, py: 0.25 }}
      >
        Add Component
      </Button>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={close}
        slotProps={{ paper: { sx: { minWidth: 220, maxHeight: 340 } } }}
      >
        <Box sx={{ px: 1, pb: 0.5 }} onKeyDown={(e) => e.stopPropagation()}>
          <TextField
            autoFocus
            size="small"
            fullWidth
            placeholder="Search components…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            InputProps={{
              sx: { fontSize: 12, height: 28 },
              startAdornment: (
                <InputAdornment position="start">
                  <Search sx={{ fontSize: 14 }} />
                </InputAdornment>
              ),
            }}
          />
        </Box>
        {filtered.map((c) => (
          <MenuItem key={c.type} onClick={() => add(c.type)} sx={{ fontSize: 12, py: 0.5 }}>
            <ListItemText primaryTypographyProps={{ fontSize: 12 }}>
              {c.label}
            </ListItemText>
          </MenuItem>
        ))}
        {filtered.length === 0 && (
          <MenuItem disabled sx={{ fontSize: 12 }}>No matching components</MenuItem>
        )}
      </Menu>
    </Box>
  );
}
