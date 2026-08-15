// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProcessingUnitModePlugin — Toolbar toggle for "Processing Unit Mode".
 *
 * When active, opens a pinned tooltip on every ProcessingUnit so all OEE /
 * cycle data is visible at a glance without the user having to hover or click
 * each unit. Persists the preference across reloads in localStorage. Scoped
 * to the DemoProcessIndustry model and registered alongside the other process
 * industry plugins via src/plugins/models/DemoProcessIndustry/index.ts.
 *
 * Independent of color mode — both modes can be on at the same time.
 */

import { useCallback, useEffect, useState } from 'react';
import { Factory } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { NavButton } from '../core/hmi/NavButton';
import { ProcessIndustryPlugin } from './processindustry-plugin';

/** localStorage key for the toggle state (survives reload). */
const LS_KEY = 'rv-pu-mode-enabled';

export function loadProcessingUnitModeEnabled(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveProcessingUnitModeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore quota errors */
  }
}

function ProcessingUnitModeButton({ viewer }: UISlotProps) {
  const [enabled, setEnabled] = useState(false);

  // On mount: sync toggle + plugin with persisted preference.
  useEffect(() => {
    const persisted = loadProcessingUnitModeEnabled();
    setEnabled(persisted);
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setProcessingUnitModeEnabled(persisted);
  }, [viewer]);

  const handleClick = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    saveProcessingUnitModeEnabled(next);
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setProcessingUnitModeEnabled(next);
  }, [viewer, enabled]);

  return (
    <NavButton
      icon={<Factory />}
      label={enabled ? 'PU Info: ON' : 'PU Info: OFF'}
      active={enabled}
      onClick={handleClick}
    />
  );
}

export class ProcessingUnitModePlugin implements RVViewerPlugin {
  readonly id = 'processing-unit-mode';
  readonly order = 175; // Just after PipeColoringPlugin (170), so the buttons sit together.

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: ProcessingUnitModeButton, order: 56 },
  ];

  /** Re-apply the persisted preference when a new model loads — the
   *  ProcessIndustryPlugin instance is fresh (created in registerModelPlugins)
   *  so we need to push the user's last choice into it. */
  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    const persisted = loadProcessingUnitModeEnabled();
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setProcessingUnitModeEnabled(persisted);
  }

  /** plan-435: the visible effect lives in the FOREIGN `processindustry`
   *  plugin, so removing our own button is not enough — switch the processing
   *  unit display off explicitly. The persisted preference is untouched. */
  onDeactivate(viewer: RVViewer): void {
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setProcessingUnitModeEnabled(false);
  }

  /** Counterpart to {@link onDeactivate}: re-apply the user's stored choice. */
  onActivate(viewer: RVViewer): void {
    const persisted = loadProcessingUnitModeEnabled();
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setProcessingUnitModeEnabled(persisted);
  }
}
