// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { MenuItem, Select } from '@mui/material';
import type { RVViewer } from '../../core/rv-viewer';
import { componentActionRegistry } from '../../core/hmi/rv-component-action-registry';
import { fieldRendererRegistry, type FieldRendererProps } from '../../core/hmi/rv-field-renderer-registry';
import { contextMenuStore } from '../../core/hmi/context-menu-store';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { showInstruction } from '../../core/hmi/instruction-store';
import { InspectorRow } from '../../core/hmi/rv-inspector-row';
import { FS, inspectorInputSx } from '../../core/hmi/shared-sx';
import { isAuthoringMode } from '../layout-planner/authoring-modes';
import { listStationDockPorts } from './path-network-dock';

const LABEL = 'Dock stub to path network';
const COMMAND = 'layout.path.dock';
const MENU_ID = 'path-dock-stub';
let inspectorRegistered = false;

export function DockPortRenderer({ value, viewer, nodePath, onEdit }: FieldRendererProps) {
  const node = viewer?.registry?.getNode(nodePath);
  const names = viewer && node
    ? [...new Set(listStationDockPorts(viewer, node).map(p => p.object3D.name))] : [];
  const current = String(value ?? '');
  const missing = current !== '' && !names.includes(current);
  return (
    <InspectorRow label="Dock port">
      <Select
        size="small" value={current} displayEmpty disabled={!onEdit}
        inputProps={{ 'aria-label': 'Dock port' }}
        onChange={e => onEdit?.(e.target.value)}
        sx={{ ...inspectorInputSx, width: '100%', height: 18, fontSize: FS.label,
          ...(missing ? { color: 'error.main' } : {}),
          '& .MuiSelect-select': { py: 0.25, px: 1 } }}
      >
        <MenuItem value="" sx={{ fontSize: FS.label }}>(auto)</MenuItem>
        {names.map(name => <MenuItem key={name} value={name} sx={{ fontSize: FS.label }}>{name}</MenuItem>)}
        {missing && <MenuItem value={current} sx={{ fontSize: FS.label, color: 'error.main' }}>{current} (missing)</MenuItem>}
      </Select>
    </InspectorRow>
  );
}

/** Inspector registries are app-wide; menu and feedback follow the UI plugin. */
export function registerTransferStationDockUi(viewer: RVViewer): () => void {
  if (!inspectorRegistered) {
    inspectorRegistered = true;
    fieldRendererRegistry.register({ componentType: 'TransferStation', fieldName: 'DockPort', component: DockPortRenderer });
    componentActionRegistry.register('TransferStation', [{
      id: 'dock-stub', label: LABEL, // default placement 'body' = a button in the section
      visible: ctx => isAuthoringMode(ctx.viewer.modes?.activeMode ?? null),
      command: { id: COMMAND, args: ctx => ({ station: ctx.nodePath }) },
      onClick: ctx => { void commandRegistry.execute(COMMAND, { station: ctx.nodePath }, { origin: 'ui', viewer: ctx.viewer }); },
    }]);
  }
  contextMenuStore.register({ pluginId: MENU_ID, items: [{
    id: MENU_ID, label: LABEL, order: 410,
    condition: t => isAuthoringMode(viewer.modes?.activeMode ?? null)
      && Object.keys(t.node.userData.realvirtual ?? {}).some(k => /^TransferStation(?:_\d+)?$/.test(k) && !!t.node.userData.realvirtual[k]),
    command: { id: COMMAND, args: t => ({ station: t.path }) },
  }] });
  // Both UI entry points use the registry, so feedback observes their result once.
  const off = commandRegistry.onExecuted(e => {
    if (e.id !== COMMAND || (e.origin !== 'ui' && e.origin !== 'shortcut')) return;
    const result = e.result;
    const dock = result.ok ? result.value as { stubPathId: string; s: number } : null;
    showInstruction({
      id: 'path-dock-result',
      text: result.ok ? `Stub ${dock!.stubPathId} docked (s = ${dock!.s.toFixed(2)} m)` : result.reason,
      anchor: { kind: 'edge', edge: 'bottom' }, style: 'toast',
      autoClearAfterMs: 5000, source: 'path-network',
    });
  });
  return () => { contextMenuStore.unregister(MENU_ID); off(); };
}
