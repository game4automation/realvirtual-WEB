// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentFilterBar — the classification chips and the tag picker
 * (plan-413 §3.1, phase 4).
 *
 * Sits on the dashboard's tool bar, beside the search field, because the two
 * are the same gesture at different grains: the search says *which thing*, the
 * chips say *what kind of thing*. Splitting them onto two rows made the chips
 * read as a second navigation level, which they are not — every chip still
 * shows the one document list.
 *
 * ## Counts on the chips, not under them
 *
 * A chip that reads "Assemblies 4" answers "is there anything in there" before
 * it is clicked, the same argument the tab counts make one row up. A chip whose
 * count is zero is not rendered at all (see `documentChipOptions`) — five
 * permanent zeroes would be the noise this bar exists to remove.
 *
 * ## The tag picker selects, it does not create
 *
 * Tags are *authored* in the classification editor, where the document being
 * tagged is on screen. Here they are only chosen, from what the project already
 * uses, so a typo cannot become a filter that silently matches nothing.
 */

import { Autocomplete, Box, Chip, TextField } from '@mui/material';
import { DOCUMENT_CHIP_ALL, type DocumentChipOption } from './document-filter';

export interface DocumentFilterBarProps {
  chips: DocumentChipOption[];
  /** Selected chip key, or null for "All". */
  chip: string | null;
  onChipChange: (chip: string | null) => void;
  /** Every tag the project uses — the picker's options. */
  tags: string[];
  tag: string | null;
  onTagChange: (tag: string | null) => void;
}

export function DocumentFilterBar({
  chips, chip, onChipChange, tags, tag, onTagChange,
}: DocumentFilterBarProps) {
  return (
    <Box
      role="group"
      aria-label="Filter documents"
      sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}
    >
      {chips.map(option => {
        const selected = option.key === DOCUMENT_CHIP_ALL
          ? chip === null || chip === DOCUMENT_CHIP_ALL
          : chip === option.key;
        return (
          <Chip
            key={option.key}
            size="small"
            label={`${option.label} ${option.count}`}
            aria-pressed={selected}
            // The one accent, used to mean "this is on" — nothing else on this
            // bar is coloured, so the lit chip is unambiguous.
            color={selected ? 'primary' : 'default'}
            variant={selected ? 'filled' : 'outlined'}
            onClick={() => onChipChange(
              option.key === DOCUMENT_CHIP_ALL ? null : option.key)}
            sx={{ height: 22, fontSize: 11, '& .MuiChip-label': { px: 0.75 } }}
          />
        );
      })}
      {tags.length > 0 && (
        <Autocomplete
          size="small"
          options={tags}
          value={tag}
          onChange={(_e, next) => onTagChange(next)}
          // A tag that no document carries any more must not stay stuck in the
          // box: clearing is always one click away, and `null` is a legal value.
          isOptionEqualToValue={(option, selected) => option === selected}
          renderInput={params => (
            <TextField
              {...params}
              placeholder="# tag"
              slotProps={{
                input: { ...params.InputProps, sx: { fontSize: 12, height: 28, py: 0 } },
                // On the input itself — a label on the wrapper names an element
                // nobody can type into.
                htmlInput: { ...params.inputProps, 'aria-label': 'Filter by tag' },
              }}
            />
          )}
          sx={{ width: 160 }}
        />
      )}
    </Box>
  );
}
