// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-file-provider.tsx — the always-available core import provider
 * (plan-238 §2.5 "glb-file"). Reads local .glb files and hands their bytes
 * to the import sinks. The only provider present in public builds.
 */

import { useCallback, useRef, useState } from 'react';
import { Box } from '@mui/material';
import type {
  CadImportProvider,
  ImportProviderContext,
  ImportProviderInput,
  ImportProviderResult,
  ImportResultItem,
} from '../../core/import/rv-import-provider';
import {
  FileDropZone, HintCode, PickedFileList, TAB_PANE_SX, TabHint,
  useRegisterFilePicker, type PickedFile,
} from './import-ui';

/** Strip path + .glb extension from a filename. */
export function glbBaseName(name: string): string {
  const file = name.split(/[\\/]/).pop() ?? name;
  return file.replace(/\.glb$/i, '') || 'model';
}

/**
 * Pure resolve step (unit-testable without the dialog): File[] → GLB items.
 * Per-file failures land in `failed` (partial success, plan-238 F6).
 * Cancel takes effect between files: reading one file is fast, a 20-file
 * multi-select is not.
 */
export async function resolveGlbFiles(files: File[], signal?: AbortSignal): Promise<ImportProviderResult> {
  const ok: ImportResultItem[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const file of files) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    try {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error('File is empty');
      ok.push({ kind: 'glb', bytes, suggestedName: glbBaseName(file.name) });
    } catch (e) {
      failed.push({ id: file.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok, failed };
}

function GlbFileTab({ ctx }: { ctx: ImportProviderContext }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  useRegisterFilePicker(ctx, inputRef);

  // One selection path for both sources — the footer's file picker and a drop
  // onto the tab must leave the tab in exactly the same state.
  const selectFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setPicked(files.map(f => ({ name: f.name, size: f.size })));
    ctx.setInput({ kind: 'files', files });
  }, [ctx]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    selectFiles(files);
  }, [selectFiles]);

  return (
    <Box sx={TAB_PANE_SX}>
      <TabHint>
        Import one or more local <HintCode>.glb</HintCode> files.
        Files stay in your browser — nothing is uploaded.
      </TabHint>
      <FileDropZone accept={['.glb']} onFiles={selectFiles} />
      <PickedFileList files={picked} placeholder="No files selected — drop them above or use Choose files… below." />
      <input
        ref={inputRef}
        type="file"
        accept=".glb"
        multiple
        style={{ display: 'none' }}
        onChange={handleChange}
      />
    </Box>
  );
}

/** Create the core GLB-file provider (registered by UnifiedImportPlugin). */
export function createGlbFileProvider(): CadImportProvider {
  return {
    id: 'glb-file',
    label: 'GLB File',
    order: 10,
    availability: () => 'ready',
    onAvailabilityChange: () => () => undefined,
    renderConfigTab: (ctx: ImportProviderContext) => <GlbFileTab ctx={ctx} />,
    resolve: async (input: ImportProviderInput, _onProgress, signal): Promise<ImportProviderResult> => {
      if (input.kind === 'file') return resolveGlbFiles([input.file], signal);
      if (input.kind === 'files') return resolveGlbFiles(input.files, signal);
      return { ok: [], failed: [{ id: 'glb-file', error: 'No file selected' }] };
    },
  };
}
