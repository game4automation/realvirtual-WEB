// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectConflictDialog — per-scene "keep my edits or take the folder
 * version?" prompt, raised when an opened project folder and the browser
 * cache have diverged (§4c).
 *
 * It only *displays* what {@link resolveSceneConflict} already classified as
 * `prompt`; the decision rules live in `rv-project-conflict.ts` and are not
 * duplicated here. Dismissing keeps every cached scene, because the safe
 * direction is the one that cannot destroy unsaved work.
 *
 * `ProjectDialogHost` wires this dialog and the existing unsaved-changes
 * dialog (`rv-scene-confirm-dialog.tsx`) into the project store, so a project
 * switch asks the same question a model switch has always asked (§4e).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { SceneConfirmDialog } from '../hmi/scene/rv-scene-confirm-dialog';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import {
  getProjectStore,
  type ProjectDirtyContext,
  type SceneConflictChoice,
  type SceneConflictPromptItem,
} from './project-store';

// ─── Presentational dialog ──────────────────────────────────────────────

export interface ProjectConflictDialogProps {
  open: boolean;
  projectName: string;
  items: SceneConflictPromptItem[];
  /** Called once, with a choice per scene id. */
  onResolve: (choices: Record<string, SceneConflictChoice>) => void;
}

export function ProjectConflictDialog({
  open,
  projectName,
  items,
  onResolve,
}: ProjectConflictDialogProps) {
  // Default is "keep my edits" for every row: a dialog the user closes
  // without reading must never be the thing that deletes their work.
  //
  // The one exception is a row whose browser copy provably came from another
  // project (plan-373). There "keep my edits" is the destructive choice — it
  // writes that other project's scene into this project's folder — so the
  // default flips and the row says where the copy came from.
  const initial = useMemo(() => {
    const map: Record<string, SceneConflictChoice> = {};
    for (const i of items) map[i.id] = i.cachedFromProjectId ? 'use-folder' : 'keep-cache';
    return map;
  }, [items]);
  const [choices, setChoices] = useState<Record<string, SceneConflictChoice>>(initial);

  useEffect(() => { setChoices(initial); }, [initial]);

  const setAll = useCallback((choice: SceneConflictChoice) => {
    setChoices(Object.fromEntries(items.map(i => [i.id, choice])));
  }, [items]);

  return (
    <Dialog open={open} onClose={() => onResolve(choices)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        {items.length === 1 ? 'This scene has changed in two places' : 'These scenes have changed in two places'}
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13, mb: 2 }}>
          The folder <b>"{projectName}"</b> and your browser copy differ. Choose which
          version to keep for each scene.
        </DialogContentText>

        {items.length > 1 && (
          <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
            <Button size="small" onClick={() => setAll('keep-cache')} sx={{ textTransform: 'none' }}>
              Keep all my edits
            </Button>
            <Button size="small" onClick={() => setAll('use-folder')} sx={{ textTransform: 'none' }}>
              Use all folder versions
            </Button>
          </Stack>
        )}

        <Stack spacing={1.5}>
          {items.map(item => (
            <Box key={item.id} data-testid={`conflict-row-${item.id}`}>
              <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{item.name}</Typography>
              <Typography sx={{ fontSize: 12, opacity: 0.75, fontFamily: 'monospace' }}>
                {item.hasUnsavedDraft
                  ? 'browser copy has unsaved edits'
                  : `browser ${shortTime(item.cacheModifiedAt)} · folder ${shortTime(item.folderModifiedAt)}`}
              </Typography>
              {item.cachedFromProjectId && (
                <Typography sx={{ fontSize: 12, color: 'warning.main' }}>
                  The browser copy comes from another project —{' '}
                  <b>{item.cachedFromProjectName ?? item.cachedFromProjectId}</b>. Keeping it
                  writes that project's scene into this folder.
                </Typography>
              )}
              <ToggleButtonGroup
                exclusive
                size="small"
                value={choices[item.id] ?? 'keep-cache'}
                onChange={(_e, value: SceneConflictChoice | null) => {
                  if (value) setChoices(prev => ({ ...prev, [item.id]: value }));
                }}
                sx={{ mt: 0.75 }}
              >
                <ToggleButton value="keep-cache" sx={{ textTransform: 'none', fontSize: 12 }}>
                  Keep my edits
                </ToggleButton>
                <ToggleButton value="use-folder" sx={{ textTransform: 'none', fontSize: 12 }}>
                  Use folder version
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          size="small"
          variant="contained"
          onClick={() => onResolve(choices)}
          sx={{ textTransform: 'none' }}
        >
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Compact timestamp for the row subtitle; empty when unknown. */
function shortTime(iso: string | null): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

// ─── Host: installs both gates on the project store ─────────────────────

interface ConflictRequest {
  items: SceneConflictPromptItem[];
  projectName: string;
  resolve: (choices: Record<string, SceneConflictChoice>) => void;
}

interface GuardRequest {
  context: ProjectDirtyContext;
  resolve: (decision: 'proceed' | 'cancel') => void;
}

/**
 * Mounted once (HMIShell). Without it the project store keeps its safe
 * defaults — conflicts resolve to "keep the cache" and a switch proceeds —
 * so nothing here is load-bearing for a headless run.
 */
export function ProjectDialogHost() {
  const [conflict, setConflict] = useState<ConflictRequest | null>(null);
  const [guard, setGuard] = useState<GuardRequest | null>(null);

  useEffect(() => {
    const store = getProjectStore();
    store.setConflictPrompt((items, project) => new Promise(resolve => {
      setConflict({ items, projectName: project.name, resolve });
    }));
    store.setDirtyGuard(context => new Promise<'proceed' | 'cancel'>(resolve => {
      setGuard({ context, resolve });
    }));
    return () => {
      store.setConflictPrompt(null);
      store.setDirtyGuard(null);
    };
  }, []);

  const onResolveConflict = useCallback((choices: Record<string, SceneConflictChoice>) => {
    conflict?.resolve(choices);
    setConflict(null);
  }, [conflict]);

  const finishGuard = useCallback((decision: 'proceed' | 'cancel') => {
    guard?.resolve(decision);
    setGuard(null);
  }, [guard]);

  const sceneStore = getSceneStore();
  const snap = sceneStore?.getSnapshot();
  const canSaveExisting = !!snap && !snap.isDraft && !!snap.saved;

  const onGuardSave = useCallback(async () => {
    try {
      const store = getSceneStore();
      const s = store?.getSnapshot();
      if (store && s?.dirty) {
        if (s.isDraft) await store.saveAs(s.draft?.name?.trim() || 'Untitled');
        else await store.save();
      }
      await getProjectStore().flush();
    } catch { /* the disk status already carries the failure */ }
    finishGuard('proceed');
  }, [finishGuard]);

  const onGuardDiscard = useCallback(async () => {
    try { await getSceneStore()?.discard(); } catch { /* ignore */ }
    finishGuard('proceed');
  }, [finishGuard]);

  return (
    <>
      <ProjectConflictDialog
        open={conflict !== null}
        projectName={conflict?.projectName ?? ''}
        items={conflict?.items ?? []}
        onResolve={onResolveConflict}
      />
      <SceneConfirmDialog
        open={guard !== null}
        sceneName={guard?.context.sceneName ?? guard?.context.projectName ?? '(project)'}
        canSave={canSaveExisting}
        onSave={() => { void onGuardSave(); }}
        onSaveAs={() => { void onGuardSave(); }}
        onDiscard={() => { void onGuardDiscard(); }}
        onCancel={() => finishGuard('cancel')}
      />
    </>
  );
}
