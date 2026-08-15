// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WorkfolderMigrationSection — the permanent door out of the old working folder
 * (plan-709 §2.6, F5).
 *
 * ## Why this lives in Settings and never expires
 *
 * The working folder was retired, not migrated away from: a user can turn up
 * months later on a machine that still has one, and with a browser-backed
 * project there is no other in-app route to those files at all. So this is a
 * permanent entry point rather than an upgrade banner, and it sits in Backup
 * next to the other data-management verbs (export, import, clear caches).
 *
 * ## Why every button press is the gesture
 *
 * `showDirectoryPicker` and `requestPermission` are only allowed inside a user
 * gesture, and a handle rehydrated from IndexedDB LOOKS valid until the first
 * read throws `NotAllowedError`. Both the pick and the permission re-grant
 * therefore happen synchronously inside the click handler, before any await
 * that could cost us the gesture — and a denial comes back as a retry offer,
 * not as a half-finished run.
 *
 * The source folder is never modified or deleted. The report says so and names
 * it, because clearing it out is the user's decision to make.
 */

import { useCallback, useState } from 'react';
import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { DriveFileMove } from '@mui/icons-material';
import { SettingsSection } from './settings-helpers';
import { getWorkFolder, isSupported as isFsApiSupported } from '../../engine/rv-local-filesystem';
import {
  migrateWorkfolderIntoProject,
  type MigrationProgress,
  type MigrationReport,
} from '../../project/rv-workfolder-migration';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: MigrationProgress }
  | { kind: 'done'; report: MigrationReport }
  | { kind: 'error'; message: string; retryable: boolean };

export function WorkfolderMigrationSection() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const run = useCallback(() => {
    setPhase({ kind: 'running', progress: { done: 0, total: 0, current: '' } });
    // Started INSIDE the click handler: `getWorkFolder(true)` may call
    // `requestPermission`, which the browser only honours here.
    void (async () => {
      try {
        const source = await getWorkFolder(true);
        if (!source) {
          setPhase({
            kind: 'error',
            message: 'No working folder is remembered, or access to it was refused.',
            retryable: true,
          });
          return;
        }
        const report = await migrateWorkfolderIntoProject({
          source,
          onProgress: (progress) => setPhase({ kind: 'running', progress }),
        });
        if (report.permissionDenied) {
          setPhase({
            kind: 'error',
            message: 'The browser withdrew access to the folder part-way through. '
              + 'Nothing was lost — press the button again to continue where it stopped.',
            retryable: true,
          });
          return;
        }
        setPhase({ kind: 'done', report });
      } catch (e) {
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        });
      }
    })();
  }, []);

  // The File System Access API is the only way to read the old folder. Without
  // it there is nothing to migrate FROM, so the section is not offered.
  if (!isFsApiSupported()) return null;

  const running = phase.kind === 'running';
  const pct = running && phase.progress.total > 0
    ? Math.round((phase.progress.done / phase.progress.total) * 100)
    : 0;

  return (
    <SettingsSection id="model-workfolder-migration" title="Old Working Folder" defaultExpanded={false}>
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.75, fontSize: 10 }}>
          Earlier versions kept assets, knowledge files and captures in a working folder on this
          computer. Everything lives in the project now. This copies the whole old folder into the
          open project — libraries, thumbnails, knowledge and all. It is safe to run more than once:
          files already brought over are skipped, and <strong>nothing in the old folder is changed
          or deleted</strong>.
        </Typography>

        <Button
          variant="outlined"
          size="small"
          color="inherit"
          disabled={running}
          startIcon={<DriveFileMove sx={{ fontSize: 14 }} />}
          onClick={run}
          sx={{ fontSize: 11, textTransform: 'none' }}
        >
          {running ? 'Copying…' : 'Copy into this project'}
        </Button>

        {running && (
          <Box sx={{ mt: 1 }}>
            <LinearProgress
              variant={phase.progress.total > 0 ? 'determinate' : 'indeterminate'}
              value={pct}
              sx={{ height: 4, borderRadius: 2 }}
            />
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 10,
                fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {phase.progress.done}/{phase.progress.total} {phase.progress.current}
            </Typography>
          </Box>
        )}

        {phase.kind === 'error' && (
          <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 0.75, fontSize: 10 }}>
            {phase.message}
          </Typography>
        )}

        {phase.kind === 'done' && (
          <Box sx={{ mt: 0.75 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>
              {phase.report.copied} copied, {phase.report.skipped} already present
              {phase.report.incomplete ? ' — stopped early, run it again to continue' : ''}.
              “{phase.report.sourceName}” was left untouched; delete it yourself once you are happy.
            </Typography>
            {phase.report.conflicts.length > 0 && (
              <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 0.5, fontSize: 10 }}>
                {phase.report.conflicts.length} file(s) already existed here with different content
                and were copied alongside instead of replacing anything:{' '}
                {phase.report.conflicts.slice(0, 5).map(c => c.savedAs).join(', ')}
                {phase.report.conflicts.length > 5 ? ', …' : ''}
              </Typography>
            )}
            {phase.report.failures.length > 0 && (
              <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mt: 0.5, fontSize: 10 }}>
                {phase.report.failures.length} file(s) could not be copied:{' '}
                {phase.report.failures.slice(0, 3).map(f => `${f.relPath} (${f.error})`).join('; ')}
                {phase.report.failures.length > 3 ? ', …' : ''}
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </SettingsSection>
  );
}
