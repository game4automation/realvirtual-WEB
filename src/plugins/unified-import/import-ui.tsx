// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * import-ui.tsx — the shared visual vocabulary of the Unified Import Dialog's
 * provider tabs. Six providers (GLB, STEP, JT, USD, Asset Manager, Onshape)
 * render into the same dialog; these primitives keep them one family and in
 * the Property Inspector's language: one setting per row (`SettingRow`), the
 * inspector's compact 18px mono fields (`SettingSelect`, `SettingCheckbox`),
 * the same picked-file list. The "Choose files…" button itself lives in the
 * DIALOG FOOTER — tabs register their hidden input via
 * `useRegisterFilePicker` instead of rendering their own button.
 *
 * `FileDropZone` serves the "I just downloaded a part from a catalog" path:
 * drag the file straight onto the tab. The tabs deliberately carry NO pointer
 * to the public catalogs any more (plan-444 F1, LOP-124) — a permanent advert
 * for someone else's site is not what an import dialog is for, and the user
 * who has a file already does not need it.
 *
 * Private providers import from here (they already import the provider
 * contract from this package), so the vocabulary is a single source.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { Box, Checkbox, MenuItem, Select, Tooltip, Typography, type SxProps, type Theme } from '@mui/material';
import type { ImportProviderContext } from '../../core/import/rv-import-provider';

/** Standard column layout of one provider tab: consistent rhythm across tabs. */
export const TAB_PANE_SX: SxProps<Theme> = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  mt: 1.5,
};

/**
 * The one-line instruction at the top of a tab. 12px at full ink — smaller
 * than body to stay quiet, but never muted gray: over glass a bright scene
 * behind the panel would push gray below AA contrast.
 */
export function TabHint({ children }: { children: ReactNode }) {
  return (
    <Typography sx={{ fontSize: 12, lineHeight: 1.5, color: 'text.primary' }}>
      {children}
    </Typography>
  );
}

/** Inline monospace token inside a TabHint (file extensions, codes). */
export function HintCode({ children }: { children: ReactNode }) {
  return (
    <Box
      component="code"
      sx={{ fontFamily: 'monospace', fontSize: 11, px: 0.5, bgcolor: 'rgba(255,255,255,0.06)', borderRadius: '2px' }}
    >
      {children}
    </Box>
  );
}

// ─── Setting rows (Property Inspector language) ─────────────────────────

/**
 * One import setting per row: 11px label left, compact field right — the
 * Property Inspector's `label → field` grid. Fixed label column so every
 * row's field starts at the same x.
 */
export function SettingRow({ label, tooltip, wide, children }: {
  label: string;
  /** Optional explanation, shown as a left-placed tooltip on the whole row. */
  tooltip?: string;
  /** Stretch the field over the remaining width (URLs, long text). */
  wide?: boolean;
  children: ReactNode;
}) {
  const row = (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: wide ? '150px 1fr' : '150px minmax(160px, 240px)',
        columnGap: 1,
        alignItems: 'center',
        minHeight: 22,
        '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
      }}
    >
      <Typography
        noWrap
        title={label}
        sx={{ fontSize: 11, color: 'text.primary', minWidth: 0 }}
      >
        {label}
      </Typography>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center' }}>
        {children}
      </Box>
    </Box>
  );
  if (!tooltip) return row;
  return <Tooltip title={tooltip} placement="left">{row}</Tooltip>;
}

/** Shared compact-field chrome (18px, mono, dark fill) — the inspector look. */
const FIELD_SX = {
  fontSize: 11,
  fontFamily: 'monospace',
  height: 18,
  width: '100%',
  bgcolor: 'rgba(255,255,255,0.04)',
  '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
  '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
  '&.Mui-focused fieldset': { borderColor: 'primary.main' },
} as const;

export interface SettingOption<T extends string | number> {
  value: T;
  label: string;
}

/** The inspector's compact enum select (18px, 11px mono, dark fill). */
export function SettingSelect<T extends string | number>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: SettingOption<T>[];
}) {
  return (
    <Select
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      sx={{ ...FIELD_SX, '& .MuiSelect-select': { py: 0.25, px: 1 } }}
    >
      {options.map((o) => (
        <MenuItem key={String(o.value)} value={o.value} sx={{ fontSize: 11 }}>{o.label}</MenuItem>
      ))}
    </Select>
  );
}

/** The inspector's compact boolean checkbox (16px glyph, primary when on). */
export function SettingCheckbox({ checked, onChange, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Checkbox
      size="small"
      checked={checked}
      disabled={disabled}
      onChange={(_, v) => onChange(v)}
      sx={{
        p: 0.125,
        color: 'rgba(255,255,255,0.35)',
        '&.Mui-checked': { color: 'primary.main' },
        '& .MuiSvgIcon-root': { fontSize: 16 },
      }}
    />
  );
}

// ─── Footer file picker registration ────────────────────────────────────

/**
 * Register the tab's hidden file input with the dialog, which renders the
 * "Choose files…" button in its footer next to Cancel / Import. Unregisters
 * on unmount / tab switch.
 */
export function useRegisterFilePicker(
  ctx: ImportProviderContext,
  inputRef: RefObject<HTMLInputElement | null>,
  label = 'Choose files…',
): void {
  useEffect(() => {
    ctx.registerFilePicker?.({ label, openPicker: () => inputRef.current?.click() });
    return () => ctx.registerFilePicker?.(null);
  }, [ctx, inputRef, label]);
}

// ─── Picked files ───────────────────────────────────────────────────────

/** Compact human-readable file size (Measurement Rule: exact, monospace). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export interface PickedFile {
  name: string;
  /** Bytes; omitted when the size is unknown. */
  size?: number;
}

// ─── Drop target ────────────────────────────────────────────────────────

/** Case-insensitive filename-extension test (`.glb`, `.step`, …). */
export function matchesAccept(name: string, accept: string[]): boolean {
  const lower = name.toLowerCase();
  return accept.some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Drag-and-drop file target for a provider tab.
 *
 * The footer's "Choose files…" button stays the explicit path; this is the
 * short one for the common case — the user has just downloaded a part from a
 * catalog and the file is sitting in the file manager next to the browser.
 *
 * Non-matching files are dropped on the floor rather than handed on: a `.pdf`
 * datasheet dragged along with the geometry must not fail the whole import.
 * The count of rejected files is reported inline so the loss is never silent.
 *
 * `dragenter`/`dragleave` are counted, not toggled: every child element fires
 * its own pair, so a boolean flickers the highlight as the pointer crosses the
 * inner text.
 */
export function FileDropZone({ accept, multiple = true, onFiles, children }: {
  /** Accepted filename extensions, e.g. `['.glb']`. */
  accept: string[];
  multiple?: boolean;
  /** Called with the accepted files; never called with an empty list. */
  onFiles: (files: File[]) => void;
  /** Idle content. Defaults to a line naming the accepted extensions. */
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState(0);
  const depth = useRef(0);

  const stop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    stop(e);
    depth.current += 1;
    setOver(true);
  }, [stop]);

  const handleLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    stop(e);
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, [stop]);

  const handleOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    stop(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, [stop]);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    stop(e);
    depth.current = 0;
    setOver(false);
    const all = Array.from(e.dataTransfer?.files ?? []);
    const ok = all.filter(f => matchesAccept(f.name, accept));
    setRejected(all.length - ok.length);
    if (ok.length === 0) return;
    onFiles(multiple ? ok : ok.slice(0, 1));
  }, [accept, multiple, onFiles, stop]);

  return (
    <Box>
      <Box
        onDragEnter={handleEnter}
        onDragLeave={handleLeave}
        onDragOver={handleOver}
        onDrop={handleDrop}
        data-testid="import-drop-zone"
        // Reflects the depth counter, so the drag state is observable without
        // reading back a computed emotion class.
        data-dragover={over ? 'true' : 'false'}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          px: 1.5,
          py: 1.25,
          borderRadius: 1,
          border: '1px dashed',
          // Instrument Blue only while the drop is live — an always-blue frame
          // would compete with the Import button for the eye.
          borderColor: over ? 'primary.main' : 'rgba(255,255,255,0.15)',
          bgcolor: over ? 'rgba(79,195,247,0.06)' : 'transparent',
          transition: 'border-color 120ms, background-color 120ms',
        }}
      >
        <Typography sx={{ fontSize: 11, lineHeight: 1.5, color: over ? 'primary.main' : 'text.secondary' }}>
          {children ?? <>Drop {accept.join(' / ')} files here</>}
        </Typography>
      </Box>
      {rejected > 0 && (
        <Typography sx={{ fontSize: 11, lineHeight: 1.7, color: 'text.secondary' }}>
          {rejected} file{rejected === 1 ? '' : 's'} ignored — only {accept.join(' / ')} is accepted here.
        </Typography>
      )}
    </Box>
  );
}

// ─── Where to get parts ─────────────────────────────────────────────────
//
// `PartSourceLinks` — a one-line pointer to 3Dfindit / TraceParts — used to
// live here and rendered on the GLB, STEP and JT tabs. It was REMOVED in
// plan-444 (F1, LOP-124) rather than hidden behind a flag: the dialog's job is
// to import a file the user already has, and standing advertising for a third
// party's catalog is not part of that job. If a catalog integration ever comes
// back it will be an actual integration under a written agreement, not a link.

/**
 * The picked-file list: one inset panel, one monospace row per file with the
 * size right-aligned. Identical on every tab that picks local files. Shows a
 * quiet placeholder while nothing is picked, so the tab explains where the
 * (footer) Choose button leads.
 */
export function PickedFileList({ files, placeholder }: { files: PickedFile[]; placeholder?: string }) {
  if (files.length === 0) {
    return placeholder ? (
      <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{placeholder}</Typography>
    ) : null;
  }
  return (
    <Box
      sx={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 1,
        px: 1,
        py: 0.5,
        maxHeight: 96,
        overflowY: 'auto',
      }}
    >
      {files.map((f) => (
        <Box key={f.name} sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
          <Typography
            noWrap
            sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7, color: 'text.primary' }}
          >
            {f.name}
          </Typography>
          {f.size != null && (
            <Typography sx={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7, color: 'text.secondary' }}>
              {formatFileSize(f.size)}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}
