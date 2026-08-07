// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Presentational news dialog and the single queue-arbitrating shell host. */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Typography,
} from '@mui/material';
import {
  fetchUnseenNews,
  getNewsSnapshot,
  markConnectNewsSeen,
  markNewsSeen,
  subscribeNewsStore,
  type NewsItem,
} from '../news-store';
import { isSafeHttpUrl, parseSafeMarkdown } from './safe-markdown';
import { SafeMarkdown } from './SafeMarkdown';
import {
  useMayShowStartupModal,
  useStartupModalRegistration,
} from './startup-modal-coordinator';

export interface NewsDialogProps {
  items: readonly NewsItem[];
  onSeen: (id: string) => void;
}

/** Renders a queue without knowing where it was fetched or how seen state is persisted. */
export function NewsDialog({ items, onSeen }: NewsDialogProps) {
  const [remaining, setRemaining] = useState<readonly NewsItem[]>(() => [...items]);
  const [total] = useState(items.length);
  const [dismissed, setDismissed] = useState(false);
  const current = remaining[0];
  const completed = total - remaining.length;

  const acknowledgeAndContinue = useCallback(() => {
    if (!current) return;
    onSeen(current.id);
    setRemaining((value) => value.slice(1));
  }, [current, onSeen]);

  const acknowledgeAndClose = useCallback(() => {
    if (!current) return;
    onSeen(current.id);
    setDismissed(true);
  }, [current, onSeen]);

  const handleClose = useCallback(() => {
    acknowledgeAndClose();
  }, [acknowledgeAndClose]);

  return (
    <Dialog
      open={!dismissed && !!current}
      onClose={handleClose}
      aria-labelledby="rv-news-dialog-title"
      aria-describedby="rv-news-dialog-description"
      maxWidth="sm"
      fullWidth
      slotProps={{
        backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.6)' } },
        paper: {
          elevation: 0,
          sx: {
            maxHeight: '88dvh',
            borderRadius: '4px',
            bgcolor: 'rgba(30,30,30,0.78)',
            backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
            border: '1px solid rgba(255,255,255,0.08)',
            backgroundImage: 'none',
            boxShadow: 'none',
          },
        },
      }}
    >
      {current && (
        <>
          <DialogTitle
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 1,
              py: 1.5,
              pr: 6,
            }}
          >
            <Box
              aria-hidden="true"
              sx={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                bgcolor: '#4fc3f7',
                mt: 0.75,
                flex: '0 0 auto',
              }}
            />
            <Box sx={{ minWidth: 0 }}>
              <Typography
                aria-hidden="true"
                variant="caption"
                sx={{ display: 'block', color: 'text.secondary', fontSize: 11, lineHeight: 1.3 }}
              >
                Neu in realvirtual WEB
              </Typography>
              <Typography
                component="span"
                sx={{ color: 'text.primary', fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}
              >
                {current.title}
              </Typography>
            </Box>
            <IconButton
              aria-label="News schließen"
              onClick={acknowledgeAndClose}
              size="small"
              sx={{ position: 'absolute', top: 8, right: 8, color: 'text.secondary' }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </DialogTitle>

          <DialogContent
            dividers
            data-testid="news-dialog-content"
            sx={{
              overflowY: 'auto',
              maxHeight: '60dvh',
              borderColor: 'rgba(255,255,255,0.08)',
              py: 2,
            }}
          >
            <Box id="rv-news-dialog-description">
              <SafeMarkdown blocks={parseSafeMarkdown(current.body)} />
            </Box>
            {current.link && isSafeHttpUrl(current.link) && (
              <Link
                href={current.link}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ display: 'inline-flex', mt: 1.5, fontSize: 13, fontWeight: 600 }}
              >
                Mehr erfahren
              </Link>
            )}
          </DialogContent>

          <DialogActions sx={{ justifyContent: 'space-between', px: 2, py: 1.25 }}>
            <Typography sx={{ color: 'text.secondary', fontFamily: 'monospace', fontSize: 11 }}>
              {completed + 1} von {total}
            </Typography>
            <Button
              autoFocus
              variant="contained"
              size="small"
              onClick={remaining.length > 1 ? acknowledgeAndContinue : acknowledgeAndClose}
              sx={{
                bgcolor: '#4fc3f7',
                color: '#0b0f12',
                borderRadius: '4px',
                textTransform: 'none',
                fontWeight: 600,
                '&:hover': { bgcolor: '#75d1f9' },
              }}
            >
              {remaining.length > 1 ? 'Weiter' : 'Schließen'}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

export interface NewsDialogHostProps {
  /** Full WEB shells fetch public news; CONNECT minimal shells consume only the gateway queue. */
  includeWeb: boolean;
}

/** Owns WEB-first queue arbitration and is the sole coordinator registrant for `news`. */
export function NewsDialogHost({ includeWeb }: NewsDialogHostProps) {
  const news = useSyncExternalStore(subscribeNewsStore, getNewsSnapshot, getNewsSnapshot);
  const mayShow = useMayShowStartupModal('news');

  useEffect(() => {
    if (includeWeb) void fetchUnseenNews('web');
  }, [includeWeb]);

  const source = includeWeb && news.webItems.length > 0
    ? 'web'
    : news.connectItems.length > 0
      ? 'connect'
      : null;
  const items = source === 'web' ? news.webItems : source === 'connect' ? news.connectItems : [];
  const visible = source !== null && mayShow;
  useStartupModalRegistration('news', visible);

  if (!visible || !source) return null;
  return (
    <NewsDialog
      key={source}
      items={items}
      onSeen={source === 'web' ? markNewsSeen : (id) => { void markConnectNewsSeen(id); }}
    />
  );
}
