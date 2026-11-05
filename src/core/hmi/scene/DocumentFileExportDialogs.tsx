// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentFileExportDialogs — the two dialogs of a registered non-GLB export
 * provider (plan-764): the export-mode choice and "Apply … extras".
 *
 * ## Why this is its own module
 *
 * Both dialogs are reachable only when a provider is registered (USD today),
 * and the apply preview — counters, loss list, the blocked variants, the
 * result sentences — was most of what plan-764 added to the entry chunk. The
 * document card loads this module through `import()` the moment one of the two
 * dialogs is about to open (`loadDocumentFileExportDialogs` in DocumentCard),
 * so a user who never touches USD never downloads a byte of it
 * (`tests/bundle-splitting.test.ts`, plan-764 block).
 *
 * The module imports nothing that is not in the entry already: React, the MUI
 * barrel the card uses, `shared-sx`, and types. Everything the card owns —
 * its message dialog, the download helper — is handed in as a callback, so
 * this module never imports the card back.
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import type { ActiveDocumentFileExport } from '../../editor/active-document-view';
import type { ApplyCommitResult, ApplyPreview, DocumentExportMode, DocumentExportPreflight } from '../../export/rv-export-provider';
import { FS, INK_LOW, INK_MID, MONO, WARN } from '../shared-sx';

/** How many entries of a list the apply dialog shows before "… and N more". */
const APPLY_LIST_LIMIT = 12;

/**
 * The sentence an apply commit ends with — success and every refusal name
 * their cause. `document-switched` (LOP #180): the file is written, but the
 * user opened another document meanwhile, so nothing was reloaded.
 */
export function describeApplyCommitResult(fileName: string, result: ApplyCommitResult): string {
  if (result.ok) {
    if (result.replace.ok && result.replace.reloadSkipped === 'document-switched') {
      return `Written — open the document to see it. The realvirtual data of ${fileName} is in the file; `
        + 'another document was opened meanwhile and was left as it is.';
    }
    return `Applied the realvirtual data of ${fileName}.`;
  }
  switch (result.code) {
    case 'stale-preview':
      return 'The document changed since the preview (or the preview expired). Nothing was applied — choose the file again.';
    case 'needs-confirmation':
      return 'Nodes would lose their realvirtual data and that was not confirmed. Nothing was applied.';
    case 'extras-wipe':
      return `${fileName} carries no realvirtual data. Nothing was applied.`;
    case 'ambiguous':
      return 'Some prims cannot be assigned to exactly one node. Nothing was applied.';
    case 'replace-failed':
      return result.replace.ok
        ? `Applied the realvirtual data of ${fileName}.`
        : `Not applied (${result.replace.reason}): ${result.replace.detail}`;
  }
}

/**
 * The sentence an export result needs, or null when it needs none.
 *
 * plan-764 F14: references stay references. A placement is written as an
 * empty prim with its extras, and the user is told the geometry is not in the
 * file instead of finding out in the receiving tool. `colorsApproximated`
 * (plan-764 step 3) counts material/vertex-colour combinations the target
 * format can only approximate.
 */
export function describeFileExportResult(fileName: string, stats: Record<string, number>): string | null {
  const parts: string[] = [];
  const n = stats.referencesWithoutGeometry ?? 0;
  if (n > 0) {
    parts.push(`${n} placement${n === 1 ? '' : 's'} exported without geometry. `
      + 'References stay references, so the referenced assets are not inside the file.');
  }
  const c = stats.colorsApproximated ?? 0;
  if (c > 0) {
    parts.push(`${c} colour${c === 1 ? '' : 's'} approximated (vertex colours the format cannot combine with the material).`);
  }
  return parts.length > 0 ? `${fileName}: ${parts.join(' ')}` : null;
}

/** The first entries of `items`, plus "… and N more". */
function listHead(items: string[]): string[] {
  return items.length <= APPLY_LIST_LIMIT
    ? items
    : [...items.slice(0, APPLY_LIST_LIMIT), `… and ${items.length - APPLY_LIST_LIMIT} more`];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DocumentFileExportDialogProps {
  exp: ActiveDocumentFileExport;
  /** The provider's modes, asked for when the dialog was requested (never empty). */
  modes: DocumentExportMode[];
  /** Closes the dialog (the card drops its state). */
  onClose: () => void;
  /** Hands a sentence to the card's message dialog. */
  onMessage: (message: string) => void;
  /** The card's download helper. */
  download: (bytes: ArrayBuffer | Uint8Array, mime: string, fileName: string) => void;
}

/** Non-GLB export (plan-764): one mode choice, the provider decides the rest. */
export function DocumentFileExportDialog({ exp, modes, onClose, onMessage, download }: DocumentFileExportDialogProps) {
  const [modeId, setModeId] = useState(modes.find((m) => !m.disabledReason)?.id ?? '');
  const [exporting, setExporting] = useState(false);
  const selectedMode = modes.find((m) => m.id === modeId);
  const [check, setCheck] = useState<{ modeId: string; result?: DocumentExportPreflight; error?: string } | null>(null);
  const needsPreflight = !!exp.preflight && !!selectedMode && !selectedMode.disabledReason;
  const currentCheck = check?.modeId === modeId ? check : null;
  const checking = needsPreflight && !currentCheck;
  // Only cheap counters belong on open or mode change. Export bytes are produced on click.
  useEffect(() => {
    let cancelled = false;
    setCheck(null);
    if (exp.preflight && selectedMode && !selectedMode.disabledReason) {
      void exp.preflight(selectedMode.id).then((result) => {
        if (!cancelled) setCheck({ modeId: selectedMode.id, result });
      }).catch((e: unknown) => {
        if (!cancelled) setCheck({ modeId: selectedMode.id, error: errorText(e) });
      });
    }
    return () => { cancelled = true; };
  }, [exp, selectedMode]);

  const run = async () => {
    if (!selectedMode || selectedMode.disabledReason || exporting || checking) return;
    setExporting(true);
    try {
      const result = await exp.run(modeId);
      download(result.bytes, result.mime, result.fileName);
      onClose();
      const notice = describeFileExportResult(result.fileName, result.stats);
      if (notice) onMessage(notice);
    } catch (e) {
      onClose();
      onMessage(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open onClose={() => { if (!exporting) onClose(); }} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: FS.title, fontWeight: 600 }}>
        {exp.label.replace(/…$/, '')}
      </DialogTitle>
      <DialogContent>
        {exp.id === 'usd' && (
          <Typography sx={{ fontSize: FS.body, mb: 1 }}>
            Export this document for Isaac Sim, Omniverse, Blender or usdview.
          </Typography>
        )}
        <RadioGroup value={modeId} onChange={(e) => setModeId(e.target.value)}>
          {modes.map((mode) => (
            <FormControlLabel
              key={mode.id}
              value={mode.id}
              disabled={exporting || !!mode.disabledReason}
              control={<Radio size="small" inputProps={{ 'data-testid': `document-card-export-mode-${mode.id}` } as Record<string, string>} />}
              label={(
                <Box>
                  <Typography sx={{ fontSize: FS.body }}>{mode.label}</Typography>
                  {mode.description && <Typography sx={{ fontSize: FS.label, color: INK_MID }}>{mode.description}</Typography>}
                  {mode.disabledReason && <Typography sx={{ fontSize: FS.label, color: INK_MID }}>{mode.disabledReason}</Typography>}
                  <Typography sx={{ fontSize: FS.label, opacity: 0.7 }}>{mode.fileName}</Typography>
                </Box>
              )}
            />
          ))}
        </RadioGroup>
        {currentCheck?.result && currentCheck.result.referencesWithoutGeometry > 0 && (
          <Typography sx={{ fontSize: FS.body, color: WARN, mt: 1 }}>
            {`${currentCheck.result.referencesWithoutGeometry} placements will be exported without geometry.`}
          </Typography>
        )}
        {currentCheck?.error && <Typography role="status" sx={{ fontSize: FS.body, mt: 1 }}>{currentCheck.error}</Typography>}
        {checking && (
          <Typography role="status" sx={{ fontSize: FS.body, color: INK_MID, mt: 1 }}>
            Checking placements…
          </Typography>
        )}
        {exporting && (
          <Typography sx={{ fontSize: FS.body, opacity: 0.75, mt: 1 }}>
            Exporting. Large documents take a few seconds.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" disabled={exporting} onClick={onClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={exporting || checking || !selectedMode || !!selectedMode.disabledReason}
          data-testid="document-card-export-run"
          onClick={() => { void run(); }}
          sx={{ textTransform: 'none' }}
        >
          {exporting ? 'Exporting…' : 'Export'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface DocumentApplyDialogProps {
  /** The provider whose apply this is (`exp.apply` is set). */
  exp: ActiveDocumentFileExport;
  /** The preview on screen — nothing was changed to produce it. */
  preview: ApplyPreview;
  onClose: () => void;
  onMessage: (message: string) => void;
}

/**
 * Apply … extras (plan-764 §3.1, F7): counters, the loss list, the blocks.
 * Commit runs only on the click, with exactly the confirmation shown.
 */
export function DocumentApplyDialog({ exp, preview, onClose, onMessage }: DocumentApplyDialogProps) {
  const [committing, setCommitting] = useState(false);
  const title = exp.id === 'usd' ? 'Apply realvirtual data from USD' : (exp.apply?.label ?? 'Apply').replace(/…$/, '');
  const fileName = preview.fileName ?? 'The file';
  const blocked = preview.blocked;

  const commit = async () => {
    if (!exp.apply || committing) return;
    setCommitting(true);
    try {
      const result = await exp.apply.commit(preview.previewToken, {
        ...(preview.blocked === 'extras-wipe' ? { acceptExtrasLoss: true } : {}),
        ...(preview.extrasLost.length > 0 ? { confirmExtrasLost: true } : {}),
      });
      onClose();
      onMessage(describeApplyCommitResult(preview.fileName ?? 'the file', result));
    } catch (err) {
      onClose();
      onMessage(errorText(err));
    }
  };

  return (
    <Dialog open onClose={() => { if (!committing) onClose(); }} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: FS.title, fontWeight: 600 }}>
        {blocked ? `${title} — blocked` : title}
      </DialogTitle>
      <DialogContent data-testid="document-card-apply-dialog">
        <Typography sx={{ fontSize: FS.body, mb: 1 }}>
          Review the realvirtual data matched to this document. Applying replaces its realvirtual data; geometry stays unchanged.
        </Typography>
        <Typography sx={{ fontSize: FS.label, color: INK_LOW, fontFamily: MONO }}>
          {fileName}{preview.schemaVersion !== undefined ? `  ·  rvSchemaVersion ${preview.schemaVersion}` : ''}
        </Typography>
        <Typography sx={{ fontSize: FS.body, mt: 1 }} data-testid="document-card-apply-counts">
          {`${preview.matched} node${preview.matched === 1 ? '' : 's'} matched · `
            + `${preview.unmatchedPrims.length} prim${preview.unmatchedPrims.length === 1 ? '' : 's'} unmatched`}
        </Typography>
        {blocked === 'ambiguous' && (
          <>
            <Typography sx={{ fontSize: FS.body, mt: 1.25, color: WARN }}>
              These prims cannot be assigned to exactly one node. Nothing can be applied from this file.
            </Typography>
            <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }} data-testid="document-card-apply-ambiguous">
              {listHead(preview.ambiguous).map((a) => (
                <Typography key={a} component="li" sx={{ fontSize: FS.label, color: INK_MID, fontFamily: MONO }}>{a}</Typography>
              ))}
            </Box>
          </>
        )}
        {blocked === 'extras-wipe' && (
          <Typography sx={{ fontSize: FS.body, mt: 1.25, color: WARN }} data-testid="document-card-apply-wipe">
            {`${fileName} carries no realvirtual data at all, the document has `
              + `${preview.documentNodesWithExtras ?? preview.extrasLost.length} node`
              + `${(preview.documentNodesWithExtras ?? preview.extrasLost.length) === 1 ? '' : 's'} with data. `
              + 'The tool that wrote this file most likely dropped customData on export.'}
          </Typography>
        )}
        {blocked === null && preview.extrasLost.length > 0 && (
          <>
            <Typography sx={{ fontSize: FS.body, mt: 1.25, color: WARN }}>
              {`${preview.extrasLost.length} node${preview.extrasLost.length === 1 ? '' : 's'} lose their realvirtual data:`}
            </Typography>
            <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }} data-testid="document-card-apply-lost">
              {listHead(preview.extrasLost).map((p) => (
                <Typography key={p} component="li" sx={{ fontSize: FS.label, color: INK_MID, fontFamily: MONO }}>{p}</Typography>
              ))}
            </Box>
          </>
        )}
        {preview.warnings.length > 0 && (
          <Box sx={{ mt: 1.25 }}>
            {listHead(preview.warnings).map((w) => (
              <Typography key={w} sx={{ fontSize: FS.label, color: INK_LOW }}>{w}</Typography>
            ))}
          </Box>
        )}
        {committing && (
          <Typography sx={{ fontSize: FS.body, color: INK_MID, mt: 1 }}>
            Applying. The document is written and reloaded.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          size="small"
          disabled={committing}
          data-testid="document-card-apply-cancel"
          onClick={onClose}
          sx={{ textTransform: 'none' }}
        >
          Cancel
        </Button>
        {blocked !== 'ambiguous' && (
          <Button
            size="small"
            variant="contained"
            color={blocked === 'extras-wipe' || preview.extrasLost.length > 0 ? 'warning' : 'primary'}
            disabled={committing}
            data-testid={blocked === 'extras-wipe' ? 'document-card-apply-anyway' : 'document-card-apply-run'}
            onClick={() => { void commit(); }}
            sx={{ textTransform: 'none' }}
          >
            {committing ? 'Applying…' : blocked === 'extras-wipe' || preview.extrasLost.length > 0 ? 'Apply and remove missing data' : 'Apply data'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
