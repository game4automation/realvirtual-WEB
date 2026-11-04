// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The "Experiments" entry of the DES toolbar and the DES side tools (plan-2211 G5/S9).
 *
 * The button is core and looks the same in every build. Its click asks the experiment window
 * opener registered by the commercial experiment manager (`des-experiment-seam.ts`); without
 * one it shows `CommercialFeatureNotice`. The window itself is rendered by the opener's
 * `Host`, mounted once by the DES toolbar, and loads as its own chunk on the first open.
 */

import { memo, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { Science } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment } from '../../core/hmi/action-group';
import { CommercialFeatureNotice } from '../../core/hmi/CommercialFeatureNotice';
import {
  desExperimentWindowProvider, subscribeDesExperimentWindowProvider,
  type DesExperimentWindowProvider, type DesExperimentWindowState,
} from '../../core/hmi/des-experiment-window';

/** Name and one-sentence summary of the experiment manager in the commercial notice. */
export const EXPERIMENT_MANAGER_NOTICE = {
  feature: 'Experiment Manager',
  summary: 'Compare variants in an experiment matrix with replications, confidence intervals, '
    + 'and batch "Run all".',
} as const;

const CLOSED: DesExperimentWindowState = { open: false };
const noSubscription = (): (() => void) => () => {};

function useWindowProvider(): DesExperimentWindowProvider | null {
  return useSyncExternalStore(subscribeDesExperimentWindowProvider, desExperimentWindowProvider);
}

function useWindowState(provider: DesExperimentWindowProvider | null): DesExperimentWindowState {
  return useSyncExternalStore(provider ? provider.subscribe : noSubscription, provider ? provider.getState : () => CLOSED);
}

/** Click handler + notice state shared by both button variants. */
function useExperimentsClick(): { onClick: () => void; notice: ReactElement } {
  const provider = useWindowProvider();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const onClick = (): void => {
    const current = desExperimentWindowProvider();
    if (current) current.toggle();
    else setNoticeOpen(true);
  };
  // A provider registered while the notice is open replaces the hint with the real window.
  useEffect(() => { if (provider) setNoticeOpen(false); }, [provider]);
  return {
    onClick,
    notice: <CommercialFeatureNotice open={noticeOpen} onClose={() => setNoticeOpen(false)}
      feature={EXPERIMENT_MANAGER_NOTICE.feature} summary={EXPERIMENT_MANAGER_NOTICE.summary} />,
  };
}

/** DES toolbar entry: opens the experiment window, or the commercial notice without the module. */
export function DesExperimentsToolbarButton(_props: UISlotProps) {
  const state = useWindowState(useWindowProvider());
  const { onClick, notice } = useExperimentsClick();
  return (
    <>
      <ActionSegment
        title={state.error || 'Experiments — run matrix (experiments × parameters × KPIs)'}
        onClick={onClick}
        active={state.open}
        icon={<Science />}
        buttonProps={{ 'data-testid': 'des-runs-open' }}
      />
      {state.error && <span role="alert">{state.error}</span>}
      {notice}
    </>
  );
}

/** DES side-tool entry (only while a DES runner exists). */
export function DesExperimentsSideButton({ viewer }: UISlotProps) {
  const [hasDes, setHasDes] = useState(false);
  const state = useWindowState(useWindowProvider());
  const { onClick, notice } = useExperimentsClick();

  useEffect(() => {
    const check = (): void => setHasDes(!!viewer.simulationKernel?.desControl?.());
    check();
    const u1 = viewer.on('model-loaded', check);
    const u2 = viewer.on('simulation-mode-changed', check);
    return () => { u1(); u2(); };
  }, [viewer]);

  if (!hasDes) return null;

  return (
    <>
      <Tooltip title={state.error || 'Experiments'} placement="right">
        <IconButton
          size="small"
          onClick={onClick}
          sx={{ color: state.open ? '#4fc3f7' : 'inherit', p: 0.75 }}
          data-testid="des-side-experiments"
        >
          <Science fontSize="small" />
        </IconButton>
      </Tooltip>
      {notice}
    </>
  );
}

/**
 * Renders the registered opener's window host; nothing without the commercial module.
 * Memoized: the DES toolbar re-renders every 200 ms while the sim clock moves, with the same
 * `viewer`; the window follows its own provider state, not the toolbar's ticks.
 */
export const DesExperimentWindowHost = memo(function DesExperimentWindowHost(props: UISlotProps) {
  const provider = useWindowProvider();
  // Re-render with the opener's state, so the host sees every open/close.
  useWindowState(provider);
  const Host = provider?.Host;
  return Host ? <Host {...props} /> : null;
});
