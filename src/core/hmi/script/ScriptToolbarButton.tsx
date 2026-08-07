// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ScriptToolbarButton — toolbar entry for the WebComponent script editor
 * (plan-210 phase 3). Rendered in the 'button-group' slot (the floating left
 * tool toolbar, same spot as the private PLC entry) and registered by
 * `web-component-plugin.ts`. Just toggles the panel — node selection happens
 * inside the panel (node picker) or via the 'Edit Script' component action.
 */

import { useSyncExternalStore } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { Code } from '@mui/icons-material';
import type { UISlotProps } from '../../rv-ui-plugin';
import { getScriptEditorState, subscribeScriptEditor, toggleScriptEditor } from './script-editor-store';

/** Toggles the WebComponent script editor panel. */
export function ScriptToolbarButton(_props: UISlotProps) {
  const state = useSyncExternalStore(subscribeScriptEditor, getScriptEditorState);
  return (
    <Tooltip title="Script Editor (component scripts)" placement="right">
      <IconButton
        size="small"
        onClick={toggleScriptEditor}
        sx={{ color: state.open ? '#4fc3f7' : 'inherit', p: 0.75 }}
        data-testid="script-toolbar-button"
      >
        <Code fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
