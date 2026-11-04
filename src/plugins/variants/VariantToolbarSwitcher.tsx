// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * VariantToolbarSwitcher — state 3 of Concept D (plan-2013): the variant in the scene is
 * switched where the simulation is controlled, in the top toolbar next to the sim speed —
 * not in the inspector, and not in a dock.
 *
 * The dropdown is also where variants are MANAGED (Codex P0 #2: the draft had no
 * management at all). Base and every variant switch the scene; each variant carries
 * Rename, Duplicate and Delete; below them "+ New variant" and "Compare differences…".
 *
 *  - switching at t > 0 asks once and then resets once (the store applies one target state)
 *  - deleting the variant IN THE SCENE confirms, goes back to Base atomically (the store's
 *    `remove` activates Base first) and resets once
 *  - renaming needs no reset — it does not touch a value (the model does not bump the
 *    revision for a rename either)
 *  - creating a variant does NOT put it into the scene: nothing is applied, nothing resets
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { Box, Button, Divider, ListItemIcon, Menu, MenuItem, Portal, TextField, Typography } from '@mui/material';
import { Check, CompareArrows, ContentCopy, DeleteOutline, DriveFileRenameOutline, Layers } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment } from '../../core/hmi/action-group';
import { DirtyDot } from '../../core/hmi/rv-dirty-dot';
import { ERROR, FS, INK_LOW, WARN } from '../../core/hmi/shared-sx';
import { checkVariantName, type Variant } from '../../core/variants/rv-variant-model';
import {
  activateVariant,
  deleteVariant,
  duplicateVariant,
  renameVariant,
} from './variant-commands';
import type { VariantsRuntime } from './variants-runtime';
import { copyVariantName, nextVariantName, resultProblem, setCompareOpen } from './variant-ui';

const BUTTON_SX = { minHeight: 24, fontSize: FS.micro, textTransform: 'none', px: 0.75 } as const;

type Dialog =
  | { kind: 'switch'; id: string; name: string }
  | { kind: 'delete'; id: string; name: string; inScene: boolean }
  | { kind: 'create' }
  | { kind: 'rename'; id: string; name: string };

export interface VariantToolbarSwitcherProps {
  viewer: RVViewer;
  runtime: VariantsRuntime;
}

export function VariantToolbarSwitcher({ viewer, runtime }: VariantToolbarSwitcherProps) {
  const store = runtime.store;
  useSyncExternalStore(store.subscribe.bind(store), () => store.version);
  const bindingGeneration = useSyncExternalStore(runtime.subscribeBinding, runtime.getBindingGeneration);
  const variants = store.block.variants;
  const scene = store.sceneVariant;
  const sceneName = scene ? store.variant(scene)?.name ?? scene : 'Base';

  const segRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setAnchor(null); setDialog(null); setError(null); setBusy(false); }, [bindingGeneration]);

  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setError(null);
    try { setError(await fn()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const activate = (id: string): void => {
    setDialog(null);
    void run(async () => resultProblem(await activateVariant(viewer, { id })));
  };

  const chooseScene = (id: string, name: string): void => {
    setAnchor(null);
    if ((id === 'base' ? null : id) === scene) return;
    if ((viewer.simTime ?? 0) > 0) { setDialog({ kind: 'switch', id, name }); return; }
    activate(id);
  };

  const create = (): void => {
    setAnchor(null);
    setDraftName(nextVariantName(variants));
    setError(null);
    setDialog({ kind: 'create' });
  };

  const commitCreate = (): void => {
    const invalid = checkVariantName(draftName);
    if (invalid) { setError(invalid); return; }
    if (variants.some((v) => v.name.toLowerCase() === draftName.trim().toLowerCase())) {
      setError('A variant with this name already exists'); return;
    }
    void run(async () => {
      const problem = resultProblem(runtime.create(draftName.trim()));
      if (!problem) setDialog(null);
      return problem;
    });
  };

  const duplicate = (v: Variant): void => {
    setAnchor(null);
    void run(async () => resultProblem(await duplicateVariant(viewer, { id: v.id, name: copyVariantName(v.name, variants) })));
  };

  const beginRename = (v: Variant): void => {
    setAnchor(null);
    setDraftName(v.name);
    setDialog({ kind: 'rename', id: v.id, name: v.name });
  };

  const commitRename = (): void => {
    if (dialog?.kind !== 'rename') return;
    const invalid = checkVariantName(draftName);
    if (invalid) { setError(invalid); return; }
    const id = dialog.id;
    void run(async () => {
      const problem = resultProblem(await renameVariant(viewer, { id, name: draftName.trim() }));
      if (!problem) setDialog(null);
      return problem;
    });
  };

  const remove = (id: string): void => {
    setDialog(null);
    void run(async () => resultProblem(await deleteVariant(viewer, { id })));
  };

  return (
    <>
      <ActionSegment
        title={`Variant in the scene: ${sceneName} — value edits go to it; moving, adding or deleting parts changes Base for all variants`}
        icon={<Layers />}
        label={sceneName}
        onClick={() => setAnchor(segRef.current)}
        buttonProps={{ 'data-testid': 'variant-switcher', 'aria-haspopup': 'menu', ref: segRef }}
      />
      {store.dirty && <DirtyDot size={6} title="Unsaved variant changes" />}

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        MenuListProps={{ dense: true, 'aria-label': 'Variants' }}
        disableRestoreFocus
        slotProps={{ transition: { onExited: () => dialog && cancelRef.current?.focus() } }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <MenuItem selected={scene === null} onClick={() => chooseScene('base', 'Base')} sx={{ fontSize: FS.body }}>
          <ListItemIcon sx={{ minWidth: 22 }}>{scene === null && <Check sx={{ fontSize: 14 }} />}</ListItemIcon>
          Base
        </MenuItem>
        {variants.map((v) => (
          <Box key={v.id} sx={{ display: 'flex', alignItems: 'center' }}>
            <MenuItem
              selected={scene === v.id}
              onClick={() => chooseScene(v.id, v.name)}
              sx={{ flex: 1, fontSize: FS.body }}
            >
              <ListItemIcon sx={{ minWidth: 22 }}>{scene === v.id && <Check sx={{ fontSize: 14 }} />}</ListItemIcon>
              {v.name}
              <Box component="span" sx={{ ml: 0.75, fontSize: FS.micro, color: INK_LOW }}>
                {v.overrides.length} value{v.overrides.length === 1 ? '' : 's'}
              </Box>
            </MenuItem>
            <Button size="small" aria-label={`Rename ${v.name}`} disabled={busy} onClick={() => beginRename(v)} sx={{ ...BUTTON_SX, minWidth: 0 }}>
              <DriveFileRenameOutline sx={{ fontSize: 14 }} />
            </Button>
            <Button size="small" aria-label={`Duplicate ${v.name}`} disabled={busy} onClick={() => duplicate(v)} sx={{ ...BUTTON_SX, minWidth: 0 }}>
              <ContentCopy sx={{ fontSize: 14 }} />
            </Button>
            <Button
              size="small"
              aria-label={`Delete ${v.name}`}
              disabled={busy}
              onClick={() => { setAnchor(null); setDialog({ kind: 'delete', id: v.id, name: v.name, inScene: v.id === scene }); }}
              sx={{ ...BUTTON_SX, minWidth: 0, color: ERROR }}
            >
              <DeleteOutline sx={{ fontSize: 14 }} />
            </Button>
          </Box>
        ))}
        <Divider />
        <MenuItem onClick={create} sx={{ fontSize: FS.body }}>
          <ListItemIcon sx={{ minWidth: 22 }} />
          + New variant
        </MenuItem>
        <MenuItem
          disabled={variants.length === 0}
          onClick={() => { setAnchor(null); setCompareOpen(true); }}
          sx={{ fontSize: FS.body }}
        >
          <ListItemIcon sx={{ minWidth: 22 }}><CompareArrows sx={{ fontSize: 14 }} /></ListItemIcon>
          Compare differences…
        </MenuItem>
      </Menu>

      {/* The toolbar pill clips and is a containing block — the inline dialogs live on body. */}
      <Portal>
        {dialog?.kind === 'switch' && (
          <InlineDialog label="Switch variant">
            <Typography sx={{ fontSize: FS.micro, mb: 0.5 }}>
              Switching to '{dialog.name}' resets the simulation to t = 0.
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Button size="small" disabled={busy} onClick={() => activate(dialog.id)} sx={BUTTON_SX}>Switch and reset</Button>
              <Button size="small" autoFocus ref={cancelRef} onClick={() => setDialog(null)} sx={BUTTON_SX}>Cancel</Button>
            </Box>
          </InlineDialog>
        )}

        {dialog?.kind === 'delete' && (
          <InlineDialog label="Delete variant">
            <Typography sx={{ fontSize: FS.micro, mb: 0.5 }}>
              Delete '{dialog.name}'? Its values are lost.
              {dialog.inScene && ' It is in the scene, so the scene goes back to Base and the simulation resets once.'}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Button size="small" disabled={busy} onClick={() => remove(dialog.id)} sx={{ ...BUTTON_SX, color: ERROR }}>Delete</Button>
              <Button size="small" autoFocus ref={cancelRef} onClick={() => setDialog(null)} sx={BUTTON_SX}>Cancel</Button>
            </Box>
          </InlineDialog>
        )}

        {dialog?.kind === 'create' && (
          <InlineDialog label="New variant">
            <TextField autoFocus size="small" value={draftName}
              onChange={(e) => { setDraftName(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) commitCreate(); if (e.key === 'Escape') { setDialog(null); setError(null); } }}
              slotProps={{ htmlInput: { 'aria-label': 'Variant name' } }} />
            <Button disabled={busy} onClick={commitCreate} sx={BUTTON_SX}>Create</Button>
            <Button onClick={() => { setDialog(null); setError(null); }} sx={BUTTON_SX}>Cancel</Button>
          </InlineDialog>
        )}
        {dialog?.kind === 'rename' && (
          <InlineDialog label="Rename variant">
            <Typography sx={{ fontSize: FS.micro, mb: 0.5, color: INK_LOW }}>Renaming changes no value and resets nothing.</Typography>
            <TextField
              autoFocus
              size="small"
              value={draftName}
              onChange={(e) => { setDraftName(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setDialog(null); }}
              slotProps={{ htmlInput: { 'aria-label': `New name for ${dialog.name}` } }}
              sx={{ width: 200 }}
            />
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
              <Button size="small" disabled={busy} onClick={commitRename} sx={BUTTON_SX}>Rename</Button>
              <Button size="small" ref={cancelRef} onClick={() => setDialog(null)} sx={BUTTON_SX}>Cancel</Button>
            </Box>
          </InlineDialog>
        )}

        {error && (
          <Box sx={{ position: 'fixed', top: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 1400 }}>
            <Typography role="alert" sx={{ fontSize: FS.micro, color: ERROR, bgcolor: 'rgba(0,0,0,0.8)', px: 1, py: 0.5, borderRadius: 1 }}>
              {error}
            </Typography>
          </Box>
        )}
      </Portal>
    </>
  );
}

function InlineDialog({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      role="alertdialog"
      aria-label={label}
      sx={{
        position: 'fixed', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 1400,
        p: 1, border: '1px solid', borderColor: WARN, borderRadius: 1, bgcolor: 'rgba(15,15,15,0.96)',
      }}
    >
      {children}
    </Box>
  );
}

/** Runtime-bound slot component; created only after the lazy variants chunk loads. */
export function createVariantSwitcherSlot(runtime: VariantsRuntime): ComponentType<UISlotProps> {
  return function VariantSwitcherSlot({ viewer }) {
    return <VariantToolbarSwitcher viewer={viewer} runtime={runtime} />;
  };
}
