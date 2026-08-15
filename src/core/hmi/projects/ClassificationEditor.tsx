// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ClassificationEditor — the level and the tags of one document, in the detail
 * pane (plan-413 §3.1, phase 4).
 *
 * ## Why the write is immediate and has no Save button
 *
 * Everything else in this pane is a verb that happens on click. A classification
 * behind a Save button would be the only field in the dashboard that can be
 * half-entered, and the state it would leave behind — a pane describing a
 * document with edits that are not in the file — is exactly the manifest/bytes
 * divergence §2.5 exists to prevent. Each change is one write of the whole
 * block, which is also what the GLB stores: level plus tags, together.
 *
 * ## Read-only shows, it does not disable
 *
 * A bundled document (an example, a delivered library) renders its
 * classification as text. Not a greyed-out select: the value is real
 * information that travelled inside the file and is worth reading, and §3.6's
 * rule is that a read-only selection still shows what it is rather than five
 * disabled controls.
 */

import { useState } from 'react';
import { Autocomplete, Box, Chip, MenuItem, TextField, Typography } from '@mui/material';
import { SectionHeader } from '../shared-components';
import {
  DOCUMENT_LEVELS,
  documentLevelLabel,
  normaliseTags,
  UNCLASSIFIED_LABEL,
  type DocumentClassification,
  type DocumentLevel,
} from '../../project/rv-document-classification';

export interface ClassificationEditorProps {
  classification?: DocumentClassification | null;
  /** Tags already used in this project — the autocomplete source (F13). */
  knownTags: string[];
  /** Absent for a read-only document; its presence is what makes this editable. */
  onChange?: (next: DocumentClassification | null) => void;
  /** True while a write is in flight — the controls are inert, not hidden. */
  busy?: boolean;
}

/** The block as the GLB stores it, or null when it says nothing at all. */
function blockOf(
  level: DocumentLevel | undefined,
  tags: string[],
): DocumentClassification | null {
  const normalised = normaliseTags(tags);
  if (level === undefined && normalised === undefined) return null;
  return { v: 1, ...(level ? { level } : {}), ...(normalised ? { tags: normalised } : {}) };
}

export function ClassificationEditor({
  classification, knownTags, onChange, busy = false,
}: ClassificationEditorProps) {
  const level = classification?.level;
  const tags = classification?.tags ?? [];
  // Only the half-typed tag is local state. The committed value lives in the
  // document, so a re-render from the store can never disagree with the box.
  const [draftTag, setDraftTag] = useState('');

  if (!onChange) {
    return (
      <Box sx={{ mt: 1.25 }}>
        <SectionHeader>Classification</SectionHeader>
        <Typography sx={{ fontSize: 11, mt: 0.5 }}>
          {documentLevelLabel(level)}
        </Typography>
        {tags.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
            {tags.map(t => (
              <Chip key={t} size="small" label={t}
                sx={{ height: 20, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }} />
            ))}
          </Box>
        )}
      </Box>
    );
  }

  const commit = (nextLevel: DocumentLevel | undefined, nextTags: string[]) => {
    onChange(blockOf(nextLevel, nextTags));
  };

  const addTag = (raw: string) => {
    const value = raw.trim();
    if (value === '') return;
    setDraftTag('');
    // Case-insensitive dedup, matching the filter: two spellings of one tag
    // would show up as two chips and filter as neither.
    if (tags.some(t => t.toLowerCase() === value.toLowerCase())) return;
    commit(level, [...tags, value]);
  };

  return (
    <Box sx={{ mt: 1.25 }}>
      <SectionHeader>Classification</SectionHeader>
      <TextField
        select
        fullWidth
        size="small"
        value={level ?? ''}
        disabled={busy}
        onChange={e => commit((e.target.value || undefined) as DocumentLevel | undefined, tags)}
        slotProps={{
          input: { sx: { fontSize: 12 } },
          // Two layers down on purpose: the combobox is `SelectInput`, and
          // `Select` only forwards to it through `inputProps`. A label on the
          // TextField or on the Select names a wrapper, which leaves the
          // control itself anonymous to a screen reader.
          select: { inputProps: { 'aria-label': 'Classification level' } },
        }}
        sx={{ mt: 0.5 }}
      >
        <MenuItem value="" sx={{ fontSize: 12 }}>{UNCLASSIFIED_LABEL}</MenuItem>
        {DOCUMENT_LEVELS.map(l => (
          <MenuItem key={l} value={l} sx={{ fontSize: 12 }}>{documentLevelLabel(l)}</MenuItem>
        ))}
      </TextField>

      {tags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
          {tags.map(t => (
            <Chip
              key={t}
              size="small"
              label={t}
              disabled={busy}
              onDelete={() => commit(level, tags.filter(x => x !== t))}
              sx={{ height: 20, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
            />
          ))}
        </Box>
      )}

      {/* Free entry with autocomplete over the project's existing tags — the
          DAM middle ground between a fixed taxonomy and a free-for-all (F13).
          A new tag is legal; the list is only there so the fifth person to tag
          a line spells it the way the first four did. */}
      <Autocomplete
        freeSolo
        size="small"
        disabled={busy}
        options={knownTags.filter(t => !tags.some(x => x.toLowerCase() === t.toLowerCase()))}
        inputValue={draftTag}
        onInputChange={(_e, value) => setDraftTag(value)}
        value={null}
        onChange={(_e, value) => { if (typeof value === 'string') addTag(value); }}
        renderInput={params => (
          <TextField
            {...params}
            placeholder="Add tag…"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(draftTag);
              }
            }}
            slotProps={{
              input: { ...params.InputProps, sx: { fontSize: 12, py: 0 } },
              htmlInput: { ...params.inputProps, 'aria-label': 'Add tag' },
            }}
          />
        )}
        sx={{ mt: 0.75 }}
      />
    </Box>
  );
}
