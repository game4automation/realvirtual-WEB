// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `tutorial-schema.mjs` (plan-2004/2031). Required for TS7016 — the node tests
 * import the module statically from TypeScript. Keep in step with the .mjs by hand.
 */

export type TutorialTarget =
  | { selector: string }
  | { x: number; y: number }
  | { command: string; buttonKey?: string }
  | { node: string; anchor: 'center' | 'top' }
  | { recordingTarget: string; key: string };

export interface CommandAction {
  type: 'command';
  id: string;
  args?: Record<string, unknown>;
  buttonKey?: string;
  via: 'click' | 'direct';
  waitSec: number;
  maxWaitSec: number;
}

export interface PickAction {
  type: 'pick';
  rule: 'moving-vehicle';
  among: string;
  as: string;
  sampleSec: number;
}

export type TutorialAction =
  | CommandAction
  | PickAction
  | { type: 'click' | 'doubleClick' | 'hover'; target: TutorialTarget; button: 'left' | 'right' }
  | { type: 'drag'; from: TutorialTarget; to: TutorialTarget; button: 'left' | 'right' | 'middle'; durationMs: number }
  | { type: 'wheel'; at: TutorialTarget; deltaY: number; steps: number }
  | { type: 'press'; key: string }
  | { type: 'type'; target: TutorialTarget; text: string; delayMs: number }
  | { type: 'waitFor'; selector?: string; scene?: true; state: 'visible' | 'attached' | 'hidden'; doc?: string; timeoutMs: number }
  | { type: 'wait'; ms: number }
  | { type: 'camera'; position: [number, number, number]; target: [number, number, number]; durationSec: number };

export interface TutorialStep {
  id: string;
  /** Always a number after `parseTutorial` — falls back to `minStepSec`. */
  holdSec: number;
  actions: TutorialAction[];
  zoom: 'auto' | 'none' | number;
  tailSec: number;
  say?: unknown;
  [key: string]: unknown;
}

export interface TutorialScript {
  $schema: 'rv-tutorial/1';
  id: string;
  title: string;
  url: string;
  connect: 'off' | 'live';
  viewport: { width: number; height: number };
  welcome: 'show' | 'dismiss';
  start: 'running' | 'paused';
  ready: string;
  minStepSec: number;
  motionRegion: { x: number; y: number; w: number; h: number };
  /** Frame stamp: separate proof track (default) or burned into the app corner (plan-2043). */
  stamp: 'proof' | 'inline';
  setup: TutorialAction[];
  steps: TutorialStep[];
  voice?: unknown;
  [key: string]: unknown;
}

export const SCHEMA_ID: 'rv-tutorial/1';
export const actionSchema: unknown;
export const stepSchema: unknown;
export const tutorialSchema: unknown;
export function parseTutorial(raw: unknown): TutorialScript;
