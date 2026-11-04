// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * CommercialFeatureNotice — a plain, reusable hint shown where a commercial module would sit
 * in a build that does not contain it (plan-2211 G5): the feature's name, one sentence about
 * what it does, and two links — the public demo (where it can be tried) and the editions page.
 *
 * Deliberately inert: no registration, no tracking, no license call. Closed by its button,
 * Escape or the backdrop.
 */

import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Typography, Box } from '@mui/material';

/** Default link to the public demo, which contains every commercial module. */
export const COMMERCIAL_DEMO_URL = 'https://web.realvirtual.io/demo/';
/** Default link to the editions comparison. */
export const COMMERCIAL_EDITIONS_URL = 'https://realvirtual.io/en/editions/';

export interface CommercialFeatureNoticeProps {
  /** Whether the dialog is shown. */
  open: boolean;
  /** Called on Close, Escape or a backdrop click. */
  onClose: () => void;
  /** Name of the commercial feature, used in the title. */
  feature: string;
  /** One sentence describing what the feature does. */
  summary: string;
  /** Link to try the feature (default: the public demo). */
  demoUrl?: string;
  /** Link to the editions comparison (default: realvirtual.io editions). */
  editionsUrl?: string;
}

export function CommercialFeatureNotice({
  open, onClose, feature, summary,
  demoUrl = COMMERCIAL_DEMO_URL, editionsUrl = COMMERCIAL_EDITIONS_URL,
}: CommercialFeatureNoticeProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth data-testid="commercial-feature-notice">
      <DialogTitle sx={{ fontSize: 14 }}>{feature} — available in realvirtual Commercial</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: 'text.primary', lineHeight: 1.6 }}>{summary}</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1.5 }}>
          <Link href={demoUrl} target="_blank" rel="noopener" sx={{ fontSize: 13 }} data-testid="commercial-feature-demo">
            Try the public demo
          </Link>
          <Link href={editionsUrl} target="_blank" rel="noopener" sx={{ fontSize: 13 }} data-testid="commercial-feature-editions">
            Compare editions
          </Link>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onClose} sx={{ textTransform: 'none' }} data-testid="commercial-feature-close">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
