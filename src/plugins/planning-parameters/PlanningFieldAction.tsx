// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PlanningFieldAction — the inspector field-row toggle "Show in / Remove from planning
 * window" (plan-630 §2.14, Phase 8). A lazy chunk: the plugin registers it with a cheap
 * `applies` test (type / re-config path), this component resolves the node's address and
 * reads whether the property is already shown.
 *
 * One click = one change of the document's `selection[]` (session; the next explicit
 * Save writes it into the GLB, like every scenario value). A property that cannot be a
 * parameter after all (e.g. its stored value does not fit) is refused with the reason in
 * the tooltip — nothing is selected.
 */

import { subscribeVariantMode, variantModeActive } from '../../core/hmi/rv-variant-ui-mode';
import { useState, useSyncExternalStore } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { Tune } from '@mui/icons-material';
import type { FieldRowActionContext } from '../../core/hmi/rv-field-row-actions';
import { ACCENT, ICON_SIZE, INK_LOW } from '../../core/hmi/shared-sx';
import { getPlanningPlugin, type PlanningParametersPlugin, type PlanningScenarioState } from './index';

const NOOP_SUBSCRIBE = () => () => {};
const NO_STATE: PlanningScenarioState | null = null;

export default function PlanningFieldAction({ viewer, nodePath, componentType, fieldName }: FieldRowActionContext) {
  const variantsActive = useSyncExternalStore(subscribeVariantMode, variantModeActive);
  const plugin: PlanningParametersPlugin | undefined = viewer ? getPlanningPlugin(viewer) : undefined;
  // Re-render when the selection changes (the scenario state carries it).
  useSyncExternalStore(
    plugin ? (cb: () => void) => plugin.subscribeScenario(cb) : NOOP_SUBSCRIBE,
    plugin ? () => plugin.getScenarioState() : () => NO_STATE,
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  if (variantsActive || !plugin || !viewer || !nodePath) return null;
  const node = viewer.registry?.getNode(nodePath) ?? null;
  const address = node ? viewer.registry?.getAddressForNode(node) ?? null : null;
  if (!address) return null;

  const target = { address, component: componentType, field: fieldName };
  const shown = plugin.isComponentParamShown(target);
  const title = refusal ?? (shown ? 'Remove from planning window' : 'Show in planning window');

  return (
    <Tooltip title={title} placement="left">
      <IconButton
        size="small"
        aria-label={`${shown ? 'Remove' : 'Show'} ${fieldName} ${shown ? 'from' : 'in'} planning window`}
        aria-pressed={shown}
        onClick={(e) => {
          e.stopPropagation();
          if (shown) { plugin.hideComponentParam(target); setRefusal(null); return; }
          const verdict = plugin.showComponentParam(target);
          setRefusal(verdict.ok ? null : `Cannot be a planning parameter: ${verdict.message}`);
        }}
        sx={{ width: 24, height: 24, p: 0, flexShrink: 0, color: shown ? ACCENT : INK_LOW }}
      >
        <Tune sx={{ fontSize: ICON_SIZE.sm }} />
      </IconButton>
    </Tooltip>
  );
}
