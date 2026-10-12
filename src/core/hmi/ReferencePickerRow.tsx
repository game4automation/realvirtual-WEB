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
import { MenuItem, Select } from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import { InspectorRow } from './rv-inspector-row';
import { FS, INK_LOW, inspectorInputSx } from './shared-sx';
import {
  listReferenceCandidates, makeComponentReference, referencePathOf,
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
}

/** Last path segment — what the closed select shows. */
function shortName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function ReferencePickerRow({ fieldName, value, target, viewer, nodePath, onEdit }: ReferencePickerRowProps) {
  const current = referencePathOf(value);
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

  const targetName = target.kind === 'component' ? target.componentType : 'signal';

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
          if (hit && hit.componentType) onEdit(makeComponentReference(hit));
        }}
        sx={{
          fontSize: FS.label,
          fontFamily: 'monospace',
          height: 18,
          width: '100%',
          ...inspectorInputSx,
          '& .MuiSelect-select': { py: 0.25, px: 1 },
        }}
      >
        <MenuItem value={NONE} sx={{ fontSize: FS.label, color: INK_LOW }}>— none —</MenuItem>
        {options.map((c) => (
          <MenuItem key={c.path} value={c.path} title={c.path} sx={{ fontSize: FS.label }}>
            {c.label}
          </MenuItem>
        ))}
        {candidates.length === 0 && (
          <MenuItem disabled sx={{ fontSize: FS.label }}>
            {`No ${targetName} in this model yet`}
          </MenuItem>
        )}
      </Select>
    </InspectorRow>
  );
}
