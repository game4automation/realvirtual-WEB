// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * view-commands — the VIEW commands of the open core (plan-761).
 *
 * One definition per action, several views:
 *
 * | Command             | UI view                                   | MCP tool                 |
 * |---------------------|-------------------------------------------|--------------------------|
 * | `view.renderMode`   | Render-mode pill (Unlit / Shaded / Toon / | `web_view_render_mode`   |
 * |                     | Ray traced when gated in), Visual tab     |                          |
 * |                     | dropdown                                  |                          |
 * | `view.visualPreset` | The two quality rows of the render-mode    | `web_view_visual_preset` |
 * |                     | menu, Visual tab preset dropdown           |                          |
 * | `view.sound`        | Sound segment of the view cluster          | `web_execute`            |
 * | `view.soundVolume`  | Volume slider of the Sound segment         | `web_execute`            |
 *
 * The two axes are deliberately separate commands on ONE menu: `view.renderMode`
 * is the shading mode, `view.visualPreset` the quality dials (resolution,
 * antialias, shadow map, AO, reflection, UI blur). Folding the dials into
 * `setRenderMode` was rejected (plan-591 §7 alt. 3) — that setter is on purpose
 * limited to mode plus lighting.
 *
 * `'wireframe'` is deliberately NOT a value of `view.renderMode`: the editor's
 * wireframe view stays with `editor.wireframe` (Shift+Z, `web_editor_shortcut`),
 * the pill's fourth segment is a view of that command.
 *
 * Everything here is open and eager (pattern: `sim-commands.ts`), so the
 * implementation is inline and `enabled()` answers synchronously from the
 * first frame. The rule is formulated on the ARGS (the mode) plus the
 * deployment lock — a locked Visual tab refuses the command with the same
 * reason the tool returns.
 */

import {
  commandRegistry,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
} from './rv-command-registry';
import {
  NO_RENDER_MODE_CONTEXT, RENDER_MODES, isRenderMode, renderModeUnavailableReason, type RenderMode,
} from '../rv-render-modes';
import { RAYTRACED_UNAVAILABLE_MESSAGE } from '../engine/rv-raytraced-hook';
import { renderModeLockReason, setRenderMode } from './render-mode-controller';
import {
  applyVisualPresetByName, presetsForSource,
  type ApplyPresetResult, type PresetSource,
} from './visual-presets';
import { getAiClicks, setAiClicks } from './ai-click-choreography-store';
import { clampSoundVolume, getSoundSettings, setSoundEnabled, setSoundVolume } from './sound-settings-store';

// ─── Args ───────────────────────────────────────────────────────────────

export interface RenderModeArgs { readonly mode: RenderMode | string }

export interface VisualPresetArgs {
  readonly name: string;
  /**
   * Which tier the name is resolved from. `'shipped'` = only `public/presets`
   * — what the two fixed quality rows mean (plan-591 F12); `'any'` (the
   * default) = published + browser-local, the generic MCP / dialog path.
   */
  readonly source?: PresetSource;
}

// ─── Reasons ────────────────────────────────────────────────────────────

/** `mode must be one of simple|default|toon|raytraced` — derived from RENDER_MODES, never a second list. */
export const RENDER_MODE_INVALID = `mode must be one of ${RENDER_MODES.map((m) => m.id).join('|')}`;

/**
 * `name must be one of <names>` — built at CALL time from the very list the
 * apply will resolve against, never a second list (same rule as
 * {@link RENDER_MODE_INVALID}, which can be a constant only because the render
 * modes are compile-time constants; presets are not — they are fetched files
 * plus localStorage).
 */
export function visualPresetInvalid(source?: PresetSource): string {
  const names = presetsForSource(source).map((p) => p.name);
  return names.length
    ? `name must be one of ${names.join('|')}`
    : 'no visual presets are available';
}

// ─── Button keys (the ONE formula for views and bindings) ───────────────

export const VIEW_RENDER_MODE_COMMAND = 'view.renderMode';
export const renderModeKey = (mode: string): string => `${VIEW_RENDER_MODE_COMMAND}:${mode}`;

export const VIEW_VISUAL_PRESET_COMMAND = 'view.visualPreset';
export const visualPresetKey = (name: string): string => `${VIEW_VISUAL_PRESET_COMMAND}:${name}`;

// ─── Implementation ─────────────────────────────────────────────────────

const renderMode: CommandImpl<RenderModeArgs, { renderMode: RenderMode; wireframe: false }> = {
  enabled: (ctx, a) => {
    const lock = renderModeLockReason();
    if (lock) return { reason: lock };
    if (!isRenderMode(a?.mode)) return { reason: RENDER_MODE_INVALID };
    // plan-762 F2: the registry's backend gate — a gated mode (raytraced) is
    // refused with the reason why (no real WebGPU / no backend in this build).
    const gate = renderModeUnavailableReason(
      a.mode, ctx?.viewer?.renderModeContext ?? NO_RENDER_MODE_CONTEXT, RAYTRACED_UNAVAILABLE_MESSAGE,
    );
    if (gate) return { reason: gate };
    return true;
  },
  run: (ctx, a) => {
    const mode = a.mode as RenderMode;
    setRenderMode(ctx.viewer, mode);
    return { renderMode: mode, wireframe: false };
  },
};

/**
 * Apply a named visual preset — the quality axis (plan-591).
 *
 * `enabled()` and `run()` both go through `presetsForSource(a?.source)`: ONE
 * expression, two use sites. Checking against `listPresets()` while a fixed row
 * means `'shipped'` would validate against a different set than the one applied
 * — and a browser-local "Default" would hijack "Max Quality" again.
 *
 * No fallback to the other tier: if the shipped preset is missing (the manifest
 * fetch failed silently), the row is disabled with a reason and the command
 * refuses — never a quiet substitution.
 */
const visualPreset: CommandImpl<VisualPresetArgs, ApplyPresetResult> = {
  enabled: (_ctx, a) => {
    const lock = renderModeLockReason();
    if (lock) return { reason: lock };
    const names = presetsForSource(a?.source).map((p) => p.name);
    if (!a?.name || !names.includes(a.name)) return { reason: visualPresetInvalid(a?.source) };
    return true;
  },
  run: (ctx, a) => {
    // `source` travels to the apply; NEVER just the name (see above).
    const result = applyVisualPresetByName(ctx.viewer, a.name, a.source ?? 'any');
    // Unreachable through the registry (`enabled` gates the dispatch), but a
    // direct caller must not get a silent no-op.
    if (!result) throw new Error(visualPresetInvalid(a?.source));
    return result;
  },
};

// ─── Sound (plan-2019 §2.7) ─────────────────────────────────────────────

export interface SoundArgs {
  /** true = on, false = off, omitted = toggle. */
  readonly on?: boolean;
}
export interface SoundVolumeArgs {
  /** Master volume 0..1. */
  readonly value: number;
}

export const VIEW_SOUND_COMMAND = 'view.sound';
export const VIEW_SOUND_VOLUME_COMMAND = 'view.soundVolume';
export const SOUND_VOLUME_INVALID = 'value must be a number from 0 to 1';

/**
 * Drive sounds on / off. Without a user gesture the browser keeps the audio
 * context suspended until the next click or key press — the state is set anyway.
 */
const sound: CommandImpl<SoundArgs, { on: boolean }> = {
  enabled: () => true,
  run: (_ctx, a) => {
    const on = typeof a?.on === 'boolean' ? a.on : !getSoundSettings().enabled;
    setSoundEnabled(on);
    return { on };
  },
};

export const VIEW_AI_CLICKS_COMMAND = 'view.aiClicks';
const aiClicks: CommandImpl<SoundArgs, { on: boolean }> = {
  enabled: () => true,
  run: (_ctx, a) => {
    const on = typeof a?.on === 'boolean' ? a.on : !getAiClicks();
    setAiClicks(on);
    return { on };
  },
};

const soundVolume: CommandImpl<SoundVolumeArgs, { volume: number }> = {
  enabled: (_ctx, a) => {
    const v = a?.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return { reason: SOUND_VOLUME_INVALID };
    return true;
  },
  run: (_ctx, a) => {
    setSoundVolume(clampSoundVolume(a.value));
    return { volume: getSoundSettings().volume };
  },
};

const SOUND_SPECS: readonly { id: string; label: string; argsSchema: Readonly<Record<string, CommandArgType>>; impl: CommandImpl<never, unknown> }[] = [
  { id: VIEW_AI_CLICKS_COMMAND, label: 'Show AI clicks', argsSchema: { on: 'boolean' }, impl: aiClicks as CommandImpl<never, unknown> },
  { id: VIEW_SOUND_COMMAND, label: 'Sound', argsSchema: { on: 'boolean' }, impl: sound as CommandImpl<never, unknown> },
  { id: VIEW_SOUND_VOLUME_COMMAND, label: 'Sound volume', argsSchema: { value: 'number' }, impl: soundVolume as CommandImpl<never, unknown> },
];

// ─── Descriptors ────────────────────────────────────────────────────────

type P = CommandMcpMirror['params'][number];
const req = (name: string, type = 'string'): P => ({ name, type, required: true });
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

interface Spec {
  readonly id: string;
  readonly label: string | ((args: never) => string);
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly buttonKey: (args: never) => string;
  readonly mcp: CommandMcpMirror;
  readonly impl: CommandImpl<never, unknown>;
}

const SPECS: readonly Spec[] = [
  {
    id: VIEW_RENDER_MODE_COMMAND,
    label: 'Render mode',
    argsSchema: { mode: 'string' },
    buttonKey: (a: RenderModeArgs) => renderModeKey(String(a?.mode ?? '')),
    mcp: { tool: 'web_view_render_mode', params: [req('mode', 'string')] },
    impl: renderMode as CommandImpl<never, unknown>,
  },
  {
    id: VIEW_VISUAL_PRESET_COMMAND,
    label: 'Visual preset',
    argsSchema: { name: 'string', source: 'string' },
    buttonKey: (a: VisualPresetArgs) => visualPresetKey(String(a?.name ?? '')),
    mcp: {
      tool: 'web_view_visual_preset',
      params: [req('name', 'string'), opt('source', 'string')],
    },
    impl: visualPreset as CommandImpl<never, unknown>,
  },
];

/** Every view command id (preload, tests). */
export const VIEW_COMMAND_IDS: readonly string[] = [
  ...SPECS.map((s) => s.id), 'view.isolate', 'view.sourceMarkers', VIEW_AI_CLICKS_COMMAND, VIEW_SOUND_COMMAND, VIEW_SOUND_VOLUME_COMMAND,
];

/** Build the view descriptors (testable seam: no registry side effect). */
export function createViewCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [...SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id,
    label: s.label,
    readOnly: false,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    buttonKey: s.buttonKey,
    mcp: s.mcp,
    argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  })), ...SESSION_VIEW_SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id, label: s.label, readOnly: s.readOnly, scope: 'none', available: true,
    unavailableReason: 'Not available', argsSchema: s.argsSchema,
    impl: s.load,
  })), ...SOUND_SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id, label: s.label, readOnly: false, scope: 'none', available: true,
    unavailableReason: 'Not available', argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  }))];
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the view commands. */
export function ensureViewCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createViewCommandDescriptors()) registry.register(d);
}

// plan-2007: the agent-only view commands keep their bodies in session-view-command-impls.ts,
// loaded on first use — the isolate framing math must not ride in the eager startup graph.
const SESSION_VIEW_SPECS: readonly { id: string; label: string; readOnly: boolean; argsSchema: Readonly<Record<string, CommandArgType>>; load: () => Promise<CommandImpl<never, unknown>> }[] = [
  { id: 'view.isolate', label: 'Isolate nodes', readOnly: false, argsSchema: { paths: 'string' }, load: async () => (await import('./session-view-command-impls')).viewIsolate as CommandImpl<never, unknown> },
  { id: 'view.sourceMarkers', label: 'Source markers', readOnly: false, argsSchema: { visible: 'boolean' }, load: async () => (await import('./session-view-command-impls')).viewSourceMarkers as CommandImpl<never, unknown> },
];
