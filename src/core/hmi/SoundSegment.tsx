// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SoundSegment — the drive-sound switch of the bottom-right view cluster (plan-2019 §2.7).
 *
 * Producer `useSoundSegment()` hands TopBar `[]` while the scene has no `Sound`
 * component (count from the SoundSystem plugin's store, event-driven), else one
 * segment: click = on / off (`view.sound`), hover / focus opens a small popover
 * above it with a vertical volume slider (`view.soundVolume`) The icon button is the only on / off
 * toggle - the popover has no switch of its own.
 *
 * Autoplay: hovering the segment preloads the audio module; the pointerdown
 * that turns sound ON creates the AudioContext inside that gesture.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { Box, Paper, Popper, Slider, Typography } from '@mui/material';
import { VolumeOff, VolumeUp } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { ActionSegment, DROPDOWN_CLOSE_DELAY_MS, DROPDOWN_OPEN_DELAY_MS, DROPDOWN_Z_INDEX } from './action-group';
import { commandRegistry } from './rv-command-registry';
import { ensureViewCommandsRegistered, VIEW_SOUND_COMMAND, VIEW_SOUND_VOLUME_COMMAND } from './view-commands';
import { soundSettingsStore } from './sound-settings-store';
import { FS, INK_MID, PANEL_SURFACE, FIELD_BORDER } from './shared-sx';
import { SOUND_SYSTEM_PLUGIN_ID, type SoundSceneSnapshot, type SoundSystemPlugin } from '../../plugins/sound-system-plugin';

const EMPTY_SCENE: SoundSceneSnapshot = { count: 0 };
const noopSubscribe = (): (() => void) => () => {};
const emptySnapshot = (): SoundSceneSnapshot => EMPTY_SCENE;

/** The Sound segment, or `[]` while the scene has no Sound component. */
export function useSoundSegment(): ReactElement[] {
  const viewer = useViewer();
  const plugin = (typeof viewer?.getPlugin === 'function'
    ? viewer.getPlugin<SoundSystemPlugin>(SOUND_SYSTEM_PLUGIN_ID) : undefined) ?? null;
  const scene = useSyncExternalStore(
    plugin ? plugin.sceneStore.subscribe : noopSubscribe,
    plugin ? plugin.sceneStore.getSnapshot : emptySnapshot,
  );
  if (!plugin || scene.count === 0) return [];
  return [<SoundSegment key="sound" plugin={plugin} />];
}

function execute(id: string, args: unknown): void {
  void commandRegistry.execute(id, args, { origin: 'ui' });
}

/** The segment itself (exported for tests). */
export function SoundSegment({ plugin }: { plugin: SoundSystemPlugin }): ReactElement {
  ensureViewCommandsRegistered();
  const settings = useSyncExternalStore(soundSettingsStore.subscribe, soundSettingsStore.getSnapshot);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = (): void => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  useEffect(() => clearTimers, []);

  const onEnter = (): void => {
    void plugin.prefetch();
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (!open && openTimer.current === null) {
      openTimer.current = window.setTimeout(() => { openTimer.current = null; setOpen(true); }, DROPDOWN_OPEN_DELAY_MS);
    }
  };
  const onLeave = (): void => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current === null) {
      closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setOpen(false); }, DROPDOWN_CLOSE_DELAY_MS);
    }
  };
  // The pointerdown that turns sound ON is the gesture that may create the context.
  const onPointerDown = (): void => {
    if (!settings.enabled) void plugin.activateFromGesture();
  };

  const pct = Math.round(settings.volume * 100);
  return (
    <Box
      ref={anchorRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      sx={{ display: 'flex', height: '100%' }}
      data-testid="sound-segment"
    >
      <ActionSegment
        title={settings.enabled ? 'Sound on — click to mute' : 'Sound off — click to turn on'}
        active={settings.enabled}
        icon={settings.enabled ? <VolumeUp /> : <VolumeOff />}
        command={{ id: VIEW_SOUND_COMMAND, args: () => ({ on: !settings.enabled }) }}
        buttonProps={{ onPointerDown, 'aria-pressed': settings.enabled, 'data-testid': 'sound-toggle' }}
      />
      <Popper
        open={open}
        anchorEl={anchorRef.current}
        placement="top"
        style={{ zIndex: DROPDOWN_Z_INDEX }}
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
      >
        <Paper
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          data-testid="sound-popover"
          sx={{
            bgcolor: PANEL_SURFACE, border: `1px solid ${FIELD_BORDER}`, boxShadow: 'none',
            px: 1, py: 1.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, width: 56,
          }}
        >
          <Typography sx={{ fontSize: FS.label, color: INK_MID, fontVariantNumeric: 'tabular-nums' }}>{pct}%</Typography>
          <Slider
            orientation="vertical"
            size="small"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={(_e, v) => execute(VIEW_SOUND_VOLUME_COMMAND, { value: (v as number) / 100 })}
            sx={{ height: 110 }}
            slotProps={{ input: { 'aria-label': 'Sound volume', 'data-testid': 'sound-volume' } as Record<string, unknown> }}
          />
        </Paper>
      </Popper>
    </Box>
  );
}
