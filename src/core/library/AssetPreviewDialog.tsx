// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetPreviewDialog — the larger view of one library entry.
 *
 * Opened from the magnifier on a card's picture (`AssetCard.onPreview`). Shows
 * the big picture, the name, who made it and under which license, and what is
 * known about its size — the facts a user wants before pulling a remote asset
 * (a SimReady download + conversion, plan-660) into the project.
 *
 * Presentational: the one action is the caller's (`onPlace`), so the dialog can
 * offer a different verb later without knowing what it does.
 */

import { useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, IconButton, Link, Typography,
} from '@mui/material';
import { Close, ImageNotSupportedOutlined } from '@mui/icons-material';
import type { LibraryCatalogEntry } from './library-types';

export interface AssetPreviewDialogProps {
  entry: LibraryCatalogEntry | null;
  onClose: () => void;
  /** The primary action, e.g. "Place in scene". Omitted = no action button. */
  onPlace?: (entry: LibraryCatalogEntry) => void;
  /** Label of the primary action. */
  placeLabel?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The size facts an entry carries, as display rows. */
export function previewSizeRows(entry: LibraryCatalogEntry): [string, string][] {
  const rows: [string, string][] = [];
  if (entry.footprintMm) rows.push(['Footprint', `${entry.footprintMm[0]} × ${entry.footprintMm[1]} mm`]);
  if (typeof entry.sizeBytes === 'number') rows.push(['File size', formatBytes(entry.sizeBytes)]);
  return rows;
}

export function AssetPreviewDialog({ entry, onClose, onPlace, placeLabel = 'Place in scene' }: AssetPreviewDialogProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const open = entry !== null;
  const src = entry ? (entry.previewUrl || entry.thumbnailUrl || '') : '';
  const showImage = !!src && failed !== src;
  const a = entry?.attribution;
  const rows: [string, string][] = entry ? previewSizeRows(entry) : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      aria-labelledby="rv-asset-preview-title"
      data-testid="asset-preview-dialog"
      PaperProps={{ sx: { bgcolor: 'rgba(24,24,24,0.98)', backgroundImage: 'none' } }}
    >
      {entry && (
        <>
          <IconButton
            aria-label="Close preview"
            onClick={onClose}
            size="small"
            sx={{ position: 'absolute', top: 8, right: 8, color: 'rgba(255,255,255,0.7)', zIndex: 1 }}
          >
            <Close fontSize="small" />
          </IconButton>
          <DialogContent sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' }, p: 2 }}>
            <Box
              sx={{
                flex: '1 1 60%',
                minWidth: 0,
                aspectRatio: '1',
                maxHeight: '70vh',
                borderRadius: 1,
                bgcolor: 'rgba(255,255,255,0.04)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {showImage ? (
                <Box
                  component="img"
                  src={src}
                  alt={entry.name}
                  onError={() => setFailed(src)}
                  data-testid="asset-preview-image"
                  sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  draggable={false}
                />
              ) : (
                <ImageNotSupportedOutlined sx={{ fontSize: 48, color: 'rgba(255,255,255,0.25)' }} />
              )}
            </Box>
            <Box sx={{ flex: '1 1 40%', minWidth: 0, pt: 0.5, pr: 3 }}>
              <Typography
                id="rv-asset-preview-title"
                variant="subtitle1"
                sx={{ fontWeight: 600, wordBreak: 'break-word', lineHeight: 1.3 }}
              >
                {entry.name}
              </Typography>
              <Box component="dl" sx={{ m: 0, mt: 1.5, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1.5, rowGap: 0.75, fontSize: 13 }}>
                {a?.vendor && (<><Dt>Creator</Dt><Dd>{a.vendor}</Dd></>)}
                {a?.license && (
                  <>
                    <Dt>License</Dt>
                    <Dd>{a.licenseUrl
                      ? <Link href={a.licenseUrl} target="_blank" rel="noopener noreferrer">{a.license}</Link>
                      : a.license}</Dd>
                  </>
                )}
                {a?.sourceUrl && (
                  <>
                    <Dt>Source</Dt>
                    <Dd><Link href={a.sourceUrl} target="_blank" rel="noopener noreferrer" sx={{ wordBreak: 'break-all' }}>Open origin page</Link></Dd>
                  </>
                )}
                {rows.map(([k, v]) => (<Box key={k} sx={{ display: 'contents' }}><Dt>{k}</Dt><Dd>{v}</Dd></Box>))}
                {rows.length === 0 && entry.noPrefetch && (
                  <><Dt>Size</Dt><Dd>Known after the first import</Dd></>
                )}
              </Box>
              {a?.license && (
                <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'text.secondary' }}>
                  The attribution is saved with the asset when it is added to the project.
                </Typography>
              )}
            </Box>
          </DialogContent>
          {onPlace && (
            <DialogActions sx={{ px: 2, pb: 2 }}>
              <Button onClick={onClose} size="small">Close</Button>
              <Button
                variant="contained"
                size="small"
                data-testid="asset-preview-place"
                onClick={() => { onPlace(entry); onClose(); }}
              >
                {placeLabel}
              </Button>
            </DialogActions>
          )}
        </>
      )}
    </Dialog>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <Box component="dt" sx={{ color: 'text.secondary' }}>{children}</Box>;
}

function Dd({ children }: { children: React.ReactNode }) {
  return <Box component="dd" sx={{ m: 0, minWidth: 0, wordBreak: 'break-word' }}>{children}</Box>;
}
