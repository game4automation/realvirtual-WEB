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
import { getActiveEditTarget } from './rv-edit-target';

export interface AddComponentSectionProps {
  viewer: RVViewer;
  nodePath: string;
}

export function AddComponentSection({ viewer, nodePath }: AddComponentSectionProps) {
  // Re-render on workspace-mode changes so the affordance appears/disappears
  // with the asset editor's EditTarget.
  useSyncExternalStore(viewer.modes.subscribe, viewer.modes.getSnapshot);
  const target = getActiveEditTarget();

  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState('');

  const candidates = useMemo(() => {
    const types = getTypesWithCapability('authorable');
    return types
      .map((type) => ({ type, label: getDisplayName(type) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, []);

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
