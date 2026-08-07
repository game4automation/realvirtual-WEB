// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsDetailPane — what the current selection is, and what can be done to
 * it (plan-372 §3.6, Phase 7).
 *
 * ## Why the actions live here and not only on the card
 *
 * Every primary action must exist as an explicit button in this pane (§3.4).
 * Double-click is the fast path, but touch has no real double-click and there
 * is no keyboard equivalent — a UI where activation is *only* a double-click is
 * unusable with a finger or a keyboard. The pane is the accessible route, not a
 * convenience.
 *
 * ## Read-only selections still show their actions
 *
 * A bundled scene offers "Duplicate to this project" rather than a disabled
 * "Rename". Telling a user *what they can do instead* beats greying out five
 * buttons with no explanation — the same reason the bundled tier carries a
 * badge on the card.
 */

import { Box, Button, Divider, Stack, Typography } from '@mui/material';
import { RV_SCROLL_CLASS } from '../shared-sx';
import { SectionHeader } from '../shared-components';

/** One row of the metadata table. */
export interface DetailField {
  label: string;
  value: string;
}

/** A button in the action stack. `primary` renders as the filled default. */
export interface DetailAction {
  key: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Shown as a tooltip-ish caption when the action is disabled. */
  disabledReason?: string;
  /** Renders in the error colour (delete and friends). */
  destructive?: boolean;
}

export interface ProjectsDetailPaneProps {
  /** Headline — usually the asset / scene / project name. */
  title: string | null;
  /** Small line under the title (category, backend kind, …). */
  subtitle?: string | null;
  /** Optional preview image URL. */
  thumbnailUrl?: string | null;
  /** Badge text, e.g. "Sample" for bundled entries. */
  badge?: string | null;
  fields?: DetailField[];
  actions?: DetailAction[];
  /** Free-form description (a component's behaviour text, for instance). */
  description?: string | null;
}

export function ProjectsDetailPane({
  title,
  subtitle,
  thumbnailUrl,
  badge,
  fields = [],
  actions = [],
  description,
}: ProjectsDetailPaneProps) {
  return (
    <Box
      className={RV_SCROLL_CLASS}
      sx={{
        width: 260,
        flexShrink: 0,
        overflowY: 'auto',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        p: 1.5,
      }}
    >
      {!title ? (
        <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>
          Select an item to see its details.
        </Typography>
      ) : (
        <>
          {thumbnailUrl && (
            <Box
              component="img"
              src={thumbnailUrl}
              alt={title}
              sx={{
                width: '100%',
                aspectRatio: '1',
                objectFit: 'cover',
                borderRadius: 1,
                bgcolor: 'rgba(255,255,255,0.05)',
                mb: 1,
              }}
            />
          )}

          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>
              {title}
            </Typography>
            {badge && (
              <Typography
                component="span"
                sx={{
                  fontSize: 9,
                  px: 0.5,
                  py: 0.125,
                  borderRadius: 0.5,
                  bgcolor: 'rgba(0,0,0,0.55)',
                  color: 'text.secondary',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  flexShrink: 0,
                }}
              >
                {badge}
              </Typography>
            )}
          </Box>

          {subtitle && (
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>
              {subtitle}
            </Typography>
          )}

          {description && (
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 1, lineHeight: 1.45 }}>
              {description}
            </Typography>
          )}

          {fields.length > 0 && (
            <>
              <Divider sx={{ my: 1.25, borderColor: 'rgba(255,255,255,0.06)' }} />
              <Stack spacing={0.5}>
                {fields.map(f => (
                  <Box key={f.label} sx={{ display: 'flex', gap: 1 }}>
                    <Typography sx={{ fontSize: 11, color: 'text.disabled', minWidth: 76 }}>
                      {f.label}
                    </Typography>
                    {/* Measurement-style values are monospace per DESIGN.md. */}
                    <Typography sx={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {f.value}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </>
          )}

          {actions.length > 0 && (
            <>
              <Divider sx={{ my: 1.25, borderColor: 'rgba(255,255,255,0.06)' }} />
              <SectionHeader>Actions</SectionHeader>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {actions.map(a => (
                  <Box key={a.key}>
                    <Button
                      fullWidth
                      size="small"
                      variant={a.primary ? 'contained' : 'outlined'}
                      color={a.destructive ? 'error' : 'primary'}
                      disabled={a.disabled}
                      onClick={a.onClick}
                      sx={{ fontSize: 11, textTransform: 'none', justifyContent: 'flex-start' }}
                    >
                      {a.label}
                    </Button>
                    {/* A disabled action always says why (§2.9 bundled case). */}
                    {a.disabled && a.disabledReason && (
                      <Typography sx={{ fontSize: 10, color: 'text.disabled', mt: 0.25 }}>
                        {a.disabledReason}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            </>
          )}
        </>
      )}
    </Box>
  );
}
