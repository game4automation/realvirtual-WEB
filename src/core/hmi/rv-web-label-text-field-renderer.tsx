// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-label-text-field-renderer.tsx — multi-line editor for `WebLabel.Text`
 * in the Property Inspector (plan-529 F8).
 *
 * The generic string field is a single-line input, so a label with a line break
 * could be written over MCP but never authored in the browser. This renderer is
 * a `TextField multiline` (2–8 rows) with the same commit rule as the generic
 * field — the value is written on blur (or Ctrl/Cmd+Enter), never per keystroke —
 * through `persistFieldOp`, i.e. the same `setField` op the inspector uses: it
 * lands in the SceneStore op log or the AssetDocument, undoably, and the
 * component's `reapplyConfig()` redraws the label.
 *
 * Self-registers with the `fieldRendererRegistry` on import; the import lives in
 * `src/core/hmi/App.tsx` next to the other field renderers — without it the
 * renderer exists in no running application (bootstrap test in
 * `tests/rv-web-label-authoring.test.ts`).
 */

import { useEffect, useState } from 'react';
import { Box, TextField } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import { FS, inspectorInputSx } from './shared-sx';
import { WEB_LABEL_MAX_TEXT, WEB_LABEL_TYPE } from '../engine/rv-web-label';

/** Renders and edits `WebLabel.Text`. */
export function WebLabelTextRenderer({ value, nodePath }: FieldRendererProps) {
  const text = typeof value === 'string' ? value : '';
  const [local, setLocal] = useState(text);

  // Re-sync on selection change, undo/redo, MCP writes (value changes on commit only).
  useEffect(() => {
    setLocal(text);
  }, [text]);

  const commit = (): void => {
    if (local !== text) persistFieldOp(nodePath, WEB_LABEL_TYPE, 'Text', local, text);
  };

  return (
    <Box data-testid="rv-web-label-text" sx={{ px: 1, py: 0.5 }}>
      <TextField
        multiline
        minRows={2}
        maxRows={8}
        size="small"
        value={local}
        placeholder="Label text"
        onChange={(e) => setLocal(e.target.value.slice(0, WEB_LABEL_MAX_TEXT))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
        }}
        slotProps={{
          htmlInput: { 'data-testid': 'rv-web-label-text-input', maxLength: WEB_LABEL_MAX_TEXT },
          input: { sx: { fontSize: FS.label } },
        }}
        sx={{ width: '100%', '& .MuiOutlinedInput-root': { ...inspectorInputSx, height: 'auto' } }}
      />
    </Box>
  );
}

fieldRendererRegistry.register({
  componentType: WEB_LABEL_TYPE,
  fieldName: 'Text',
  component: WebLabelTextRenderer,
});
