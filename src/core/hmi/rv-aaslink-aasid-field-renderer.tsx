// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-aaslink-aasid-field-renderer.tsx — the `AASLink.AASId` field in the
 * Property Inspector (plan-596 Phase 4).
 *
 * A plain text field made the author type an AAS id by hand. This renderer
 * offers the ids the open project (and the deploy-wide fallback) actually
 * carries, labelled with the product name or idShort and the file:
 *
 *  - **Dropdown** over the active AAS source's index. Choosing an entry writes
 *    the id through `persistFieldOp` — the inspector's own `setField` op, so it
 *    is undoable and lands in the SceneStore op log or the AssetDocument.
 *  - **Other ID…** switches to a free-text field for ids the project does not
 *    carry (an external repository, a not-yet-delivered file).
 *  - A current value that is not in the index stays visible, with the message
 *    "AAS ID not found in project".
 *  - **Import AASX…** (writable project only): pick a `.aasx`, copy it to
 *    `aasx/` under a free name, rescan, and set the id — directly for a file
 *    with one shell, through a second dropdown for several.
 *
 * Self-registers with the `fieldRendererRegistry`; the side-effect import lives
 * in `src/core/hmi/App.tsx` next to the other field renderers.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button, Typography } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import { InspectorRow } from './rv-inspector-row';
import { InspectorActionRow, inspectorActionButtonSx } from './rv-inspector-blocks';
import { EnumEditor, StringEditor } from './rv-field-editors';
import { FS, INK_MID, WARN } from './shared-sx';
import { pickLocalFile } from './FmuAttachAction';
import { reportProblem, clearProblem } from './problems-store';
import { getProjectStore } from '../project/project-store';
import {
  PROJECT_AASX_DIR,
  getActiveAasSource,
  getAasSourcesVersion,
  subscribeAasSources,
  type AasIndexEntry,
} from '../aas/rv-aas-source';
import type { AasxShellSummary } from '../aas/rv-aasx-package';

/** Component / field this renderer edits. */
export const AASLINK_TYPE = 'AASLink';
export const AASLINK_ID_FIELD = 'AASId';

/** Dropdown entry that switches to free text. */
export const OTHER_ID_OPTION = 'Other ID…';
/** Problems code of a refused import. */
export const AASX_IMPORT_REFUSED_CODE = 'aasx-import-refused';

/** One dropdown row: the label shown and the id it writes. */
export interface AasIdOption {
  label: string;
  id: string;
}

/** Label of an index entry: `<product name | idShort> — <file>`. */
export function aasOptionLabel(entry: AasIndexEntry, id: string): string {
  return `${entry.productName || entry.idShort || id} — ${entry.file}`;
}

/** Dropdown rows for an index; labels are made unique by appending the id. */
export function aasIdOptions(index: Record<string, AasIndexEntry>): AasIdOption[] {
  const rows = Object.entries(index).map(([id, entry]) => ({ id, label: aasOptionLabel(entry, id) }));
  rows.sort((a, b) => a.label.localeCompare(b.label));
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
  return rows.map(r => (seen.get(r.label)! > 1 ? { ...r, label: `${r.label} (${r.id})` } : r));
}

/** Strip the extension and characters no file system accepts. */
export function sanitizeAasxBaseName(name: string): string {
  const cleaned = name.replace(/\.aasx$/i, '').replace(/[\\/:*?"<>|#%]/g, '_').trim();
  return cleaned || 'import';
}

/** A free `aasx/<name>.aasx` (then `-2`, `-3`, …) given the files that exist. */
export function freeAasxName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(p => p.toLowerCase()));
  let name = `${base}.aasx`;
  let n = 2;
  while (taken.has(`${PROJECT_AASX_DIR}/${name}`.toLowerCase())) name = `${base}-${n++}.aasx`;
  return name;
}

/** True when the open project accepts an import into its `aasx/` folder. */
function useWritableProject(): boolean {
  const store = getProjectStore();
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const backend = store.getBackend();
  return !!backend && backend.kind !== 'bundled' && backend.writable;
}

/** The active source's index, re-read on every source change. */
function useActiveIndex(): Record<string, AasIndexEntry> | null {
  const version = useSyncExternalStore(subscribeAasSources, getAasSourcesVersion, getAasSourcesVersion);
  const [index, setIndex] = useState<Record<string, AasIndexEntry> | null>(null);
  useEffect(() => {
    let cancelled = false;
    getActiveAasSource().readIndex()
      .then(r => { if (!cancelled) setIndex(r.kind === 'available' ? r.index : {}); })
      .catch(() => { if (!cancelled) setIndex({}); });
    return () => { cancelled = true; };
  }, [version]);
  return index;
}

/**
 * Copy a picked `.aasx` into the open project's `aasx/` folder and rescan.
 * Returns the shells of the copied file. Throws with a user-readable message.
 */
export async function importAasxIntoProject(file: File): Promise<{ name: string; shells: AasxShellSummary[] }> {
  const backend = getProjectStore().getBackend();
  if (!backend || backend.kind === 'bundled' || !backend.writable) {
    throw new Error('The open project is read-only — AASX files cannot be imported.');
  }
  // Lazy: the package reader and the scanner load with the first import.
  const [{ readAasxSummary }, { rescanProjectAasx }] = await Promise.all([
    import('../aas/rv-aasx-package'),
    import('../aas/rv-aasx-project-index'),
  ]);
  const summary = await readAasxSummary(file);
  if (!summary.ok) throw new Error(`${file.name}: ${summary.error}`);
  const existing = backend.listAllFiles ? await backend.listAllFiles() : [];
  const name = freeAasxName(sanitizeAasxBaseName(file.name), existing);
  await backend.writeDocument(
    `${PROJECT_AASX_DIR}/${name}`,
    new Uint8Array(await file.arrayBuffer()),
    { expectedRevision: 'create' },
  );
  await rescanProjectAasx();
  return { name, shells: summary.shells };
}

/** Renders and edits `AASLink.AASId`. */
export function AasLinkAasIdRenderer({ value, nodePath }: FieldRendererProps) {
  const current = typeof value === 'string' ? value : '';
  const index = useActiveIndex();
  const writable = useWritableProject();
  const [freeText, setFreeText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [choices, setChoices] = useState<AasxShellSummary[] | null>(null);

  const options = useMemo(() => aasIdOptions(index ?? {}), [index]);
  const known = !!index && !!current && !!index[current];
  const currentLabel = options.find(o => o.id === current)?.label
    ?? (current ? `${current} (not in project)` : '');

  const write = useCallback((id: string) => {
    if (id === current) return;
    persistFieldOp(nodePath, AASLINK_TYPE, AASLINK_ID_FIELD, id, current);
  }, [current, nodePath]);

  const onSelect = (label: string): void => {
    if (label === OTHER_ID_OPTION) { setFreeText(true); return; }
    const opt = options.find(o => o.label === label);
    if (opt) { setFreeText(false); write(opt.id); }
  };

  const onImport = async (): Promise<void> => {
    const file = await pickLocalFile('.aasx');
    if (!file) return;
    setBusy(true);
    setMessage(null);
    const problemId = `${AASX_IMPORT_REFUSED_CODE}:${nodePath}`;
    try {
      const { shells } = await importAasxIntoProject(file);
      clearProblem(problemId);
      if (shells.length === 1) {
        write(shells[0].id);
        setChoices(null);
      } else {
        setChoices(shells);
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setMessage(text);
      reportProblem({
        id: problemId,
        severity: 'warning',
        code: AASX_IMPORT_REFUSED_CODE,
        title: `AASX could not be imported: ${file.name}`,
        detail: text,
        nodePath,
      });
    } finally {
      setBusy(false);
    }
  };

  const selectOptions = [
    ...(current && !known ? [currentLabel] : []),
    ...(current ? [] : ['']),
    ...options.map(o => o.label),
    OTHER_ID_OPTION,
  ];
  const selected = freeText ? OTHER_ID_OPTION : currentLabel;

  return (
    <>
      <InspectorRow label="AAS ID" labelTitle="Asset Administration Shell id this part links to" fullWidthField>
        <EnumEditor value={selected} onChange={onSelect} options={selectOptions} ariaLabel="AAS ID" />
      </InspectorRow>
      {freeText && (
        <InspectorRow label="" fullWidthField>
          <StringEditor value={current} onChange={(v) => write(v.trim())} />
        </InspectorRow>
      )}
      {choices && choices.length > 1 && (
        <InspectorRow label="Shell" labelTitle="The imported file holds several shells — choose one" fullWidthField>
          <EnumEditor
            value=""
            options={['', ...choices.map(s => `${s.productName || s.idShort} (${s.id})`)]}
            ariaLabel="Shell"
            onChange={(label) => {
              const shell = choices.find(s => `${s.productName || s.idShort} (${s.id})` === label);
              if (shell) { write(shell.id); setChoices(null); }
            }}
          />
        </InspectorRow>
      )}
      {writable && (
        <InspectorActionRow data-testid="rv-aaslink-import">
          <Button size="small" variant="outlined" disabled={busy} onClick={() => { void onImport(); }} sx={inspectorActionButtonSx}>
            Import AASX…
          </Button>
        </InspectorActionRow>
      )}
      {index && current && !known && (
        <InspectorRow label="">
          <Typography sx={{ fontSize: FS.label, color: WARN, whiteSpace: 'normal' }}>
            AAS ID not found in project
          </Typography>
        </InspectorRow>
      )}
      {message && (
        <InspectorRow label="">
          <Typography sx={{ fontSize: FS.label, color: INK_MID, whiteSpace: 'normal' }}>{message}</Typography>
        </InspectorRow>
      )}
    </>
  );
}

fieldRendererRegistry.register({
  componentType: AASLINK_TYPE,
  fieldName: AASLINK_ID_FIELD,
  component: AasLinkAasIdRenderer,
});
