// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ReferencePickerRow — an inspector row that lets the author choose the target
 * of a structural reference field (the sensor a Wait Sensor step waits for, the
 * drive a Drive To step moves, the signal a Set Signal step sets) in the
 * editor. The choice is written through the normal field-edit path, so it is
 * one undoable document step like any other field edit.
 *
 * Candidates come from {@link listReferenceCandidates} and are collected only
 * when the menu opens — the inspector re-renders often, the registry walk is
 * only worth it when somebody looks. Built from the inspector building blocks
 * (`InspectorRow`, `inspectorInputSx`, `FS`) per the plan-510 inspector rule.
 */

import { useCallback, useState } from 'react';
import { Box, Chip, MenuItem, Select } from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import { InspectorRow } from './rv-inspector-row';
import { FS, INK_LOW, inspectorInputSx } from './shared-sx';
import {
  addressedReferencePath, ambiguousReason, listReferenceCandidates, makeComponentReference, referencePathOf, referencePathsOf,
  type ReferenceCandidate, type ReferenceTarget,
} from './rv-reference-field';

const NONE = '';

export interface ReferencePickerRowProps {
  fieldName: string;
  value: unknown;
  target: ReferenceTarget;
  viewer: RVViewer | null;
  /** Path of the node carrying the reference — excluded from its own candidates. */
  nodePath: string;
  onEdit: (value: unknown) => void;
  /**
   * plan-522: the field holds a LIST of references — chips with a remove cross
   * plus an "Add" select over the same candidates. Only fields that declare it.
   */
  array?: boolean;
}

/** Last path segment — what the closed select shows. */
function shortName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

const selectSx = {
  fontSize: FS.label,
  fontFamily: 'monospace',
  height: 18,
  width: '100%',
  ...inspectorInputSx,
  '& .MuiSelect-select': { py: 0.25, px: 1 },
} as const;

export function ReferencePickerRow({ fieldName, value, target, viewer, nodePath, onEdit, array }: ReferencePickerRowProps) {
  // plan-769 § 2.7: an address-form value shows its TARGET's authored path — the
  // spelling the candidates carry, so the select shows (and matches) the node.
  const resolve = (ref: unknown): string | null => {
    const registry = viewer?.registry;
    return registry
      ? addressedReferencePath(registry, registry.getNode(nodePath), viewer?.currentModelRoot ?? null, ref)
      : null;
  };
  const current = array ? '' : referencePathOf(value, resolve);
  const [candidates, setCandidates] = useState<ReferenceCandidate[]>([]);

  const collect = useCallback(() => {
    const registry = viewer?.registry;
    if (!registry) { setCandidates([]); return; }
    const root = viewer?.currentModelRoot ?? null;
    setCandidates(listReferenceCandidates((cb) => registry.forEachNode(cb), target, root, registry.getNode(nodePath)));
  }, [viewer, target, nodePath]);

  // The current value is always an option, also before the menu was opened and
  // when its target no longer exists — the select never shows a blank for a
  // value the document carries.
  const options = candidates.some((c) => c.path === current) || !current
    ? candidates
    : [{ path: current, componentType: '', label: shortName(current) }, ...candidates];

  const targetName = target.kind === 'component' ? target.componentType : target.kind === 'node' ? 'node' : 'signal';
  // A written reference must come from the candidate list (the current-value
  // placeholder carries no component type); a `node` target writes `''`.
  const writable = (c: ReferenceCandidate | undefined): c is ReferenceCandidate =>
    !!c && !c.ambiguous && candidates.includes(c) && (target.kind === 'node' || !!c.componentType);

  const menuItems = (exclude: ReadonlySet<string>) => [
    ...options.filter((c) => !exclude.has(c.path)).map((c) => (
      // plan-765 F4: true sibling duplicates share one authored path — listed
      // so the author sees why the node is missing, but not selectable.
      <MenuItem
        key={c.path}
        value={c.path}
        disabled={c.ambiguous === true}
        title={c.ambiguous ? ambiguousReason(c) : c.path}
        sx={{ fontSize: FS.label }}
      >
        {c.label}
      </MenuItem>
    )),
    candidates.length === 0 && (
      <MenuItem key="__empty" disabled sx={{ fontSize: FS.label }}>
        {`No ${targetName} in this model yet`}
      </MenuItem>
    ),
  ];

  if (array) {
    const list = Array.isArray(value) ? value : [];
    const paths = referencePathsOf(value, resolve);
    const present = new Set(paths);
    return (
      <InspectorRow label={fieldName} labelTitle={`${fieldName} — the ${targetName}s this field refers to`}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, width: '100%', alignItems: 'center' }}>
          {paths.map((p, i) => (
            <Chip
              key={`${p}:${i}`}
              size="small"
              label={shortName(p)}
              title={p}
              onDelete={() => onEdit(list.filter((v) => referencePathOf(v, resolve) !== p))}
              sx={{ height: 18, fontSize: FS.label, fontFamily: 'monospace' }}
            />
          ))}
          <Select
            size="small"
            value={NONE}
            displayEmpty
            onOpen={collect}
            inputProps={{ 'aria-label': `${fieldName}: add ${targetName}` }}
            renderValue={() => <span style={{ color: INK_LOW }}>+ Add</span>}
            onChange={(e) => {
              const path = String(e.target.value);
              const hit = candidates.find((c) => c.path === path);
              if (!writable(hit) || present.has(path)) return;
              onEdit([...list, makeComponentReference(hit)]);
            }}
            sx={{ ...selectSx, width: 'auto', minWidth: 64, flex: 1 }}
          >
            {menuItems(present)}
          </Select>
        </Box>
      </InspectorRow>
    );
  }

  return (
    <InspectorRow label={fieldName} labelTitle={`${fieldName} — choose the ${targetName} this field refers to`}>
      <Select
        size="small"
        value={current}
        displayEmpty
        onOpen={collect}
        inputProps={{ 'aria-label': `${fieldName}: choose ${targetName}` }}
        renderValue={(v) => (v ? shortName(String(v)) : <span style={{ color: INK_LOW }}>— none —</span>)}
        onChange={(e) => {
          const path = String(e.target.value);
          if (path === NONE) { onEdit(null); return; }
          const hit = options.find((c) => c.path === path);
          // plan-765 F4: an ambiguous path is never written, even if a click got through.
          if (writable(hit)) onEdit(makeComponentReference(hit));
        }}
        sx={selectSx}
      >
        <MenuItem value={NONE} sx={{ fontSize: FS.label, color: INK_LOW }}>— none —</MenuItem>
        {menuItems(new Set())}
      </Select>
    </InspectorRow>
  );
}
