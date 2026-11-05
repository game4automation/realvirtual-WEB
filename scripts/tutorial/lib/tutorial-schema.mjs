// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Tutorial recorder (plan-2004/2031) — `rv-tutorial/1`, including commands and bound targets.
 *
 * The storyboard IS the property surface of this tool (§ 2.4, the named exception to the
 * component/property principle): its editor is this validator plus an error message naming the
 * step id.
 *
 * Two rules that are not decoration:
 *  - EVERY optional duration is NORMALISED here, never left `undefined`. `framesOf(undefined, fps)`
 *    is NaN, and for `waitFor.timeoutMs` that NaN would reach `frameBudget()` BEFORE the run.
 *  - `voice` and `say` belong to plan-676 (voice and final cut). They are TOLERATED and ignored —
 *    a non-empty `say` never triggers a refusal — so a storyboard written for plan-676 is already
 *    recordable today.
 */

import { z } from 'zod';

export const SCHEMA_ID = 'rv-tutorial/1';

/** Step ids must be filename-safe: they end up in `stills-*.jpg` names. */
/** plan-2240: Gate C policy of a step. */
export const MOTION_POLICIES = /** @type {const} */ (['require', 'warn', 'off']);

const STEP_ID = z.string().regex(/^[a-z0-9-]+$/, 'step id must match [a-z0-9-]+ (it becomes part of a file name)');

/**
 * plan-2240: a selector target may carry an `offset` in CSS pixels from the element's centre (a
 * window grip, a point beside a label). Visibility and covering are checked AT the offset point.
 */
const offset = z.object({ dx: z.number(), dy: z.number() }).strict();

const target = z.union([
  z.object({ selector: z.string().min(1), offset: offset.optional() }).strict(),
  z.object({ x: z.number(), y: z.number() }).strict(),
  z.object({ command: z.string(), buttonKey: z.string().optional() }).strict(),
  z.object({ node: z.string(), anchor: z.enum(['center', 'top']).default('center') }).strict(),
  z.object({ recordingTarget: z.string(), key: z.string() }).strict(),
]);

const pointerAction = z.object({
  type: z.enum(['click', 'doubleClick', 'hover']),
  target,
  button: z.enum(['left', 'right']).default('left'),
});

const dragAction = z.object({
  type: z.literal('drag'),
  from: target,
  to: target,
  button: z.enum(['left', 'right', 'middle']).default('left'),
  // DECLARED SCHEMA DEFAULT, not a measurement. The plan lists `durationMs` among the duration
  // fields that go through `framesOf` but declares no default for it, and an optional field left
  // `undefined` would make `framesOf(undefined, fps)` NaN — in `frameBudget()`, i.e. BEFORE the
  // run. 1000 ms is this schema's choice for a hand-drawn drag; override it per action.
  durationMs: z.number().positive().default(1000),
});

const wheelAction = z.object({
  type: z.literal('wheel'),
  at: target,
  deltaY: z.number(),
  steps: z.number().int().positive().default(1),
});

const pressAction = z.object({
  type: z.literal('press'),
  key: z.string().min(1),
});

const typeAction = z.object({
  type: z.literal('type'),
  target,
  text: z.string(),
  // DECLARED SCHEMA DEFAULT, not a measurement — same reason as `drag.durationMs`: the field is a
  // duration that goes through `framesOf`, and the budget term of a `type` action is
  // `framesOf(text.length * delayMs / 1000, fps)`, which an `undefined` would turn into NaN
  // before the run. 60 ms per character is this schema's choice for visible typing.
  delayMs: z.number().positive().default(60),
});

/**
 * `waitFor` needs a selector OR `scene: true` — a `waitFor` with neither has no condition and
 * would silently wait out its timeout.
 *
 * `timeoutMs` default 60000 (H8): it enters `frameBudget()` and therefore must never be undefined.
 */
const waitForAction = z.object({
  type: z.literal('waitFor'),
  selector: z.string().min(1).optional(),
  scene: z.literal(true).optional(),
  state: z.enum(['visible', 'attached', 'hidden']).default('visible'),
  doc: z.string().min(1).optional(),
  timeoutMs: z.number().positive().default(60000),
}).refine((a) => a.selector !== undefined || a.scene === true, {
  message: "waitFor needs either a 'selector' or 'scene: true'",
});

const waitAction = z.object({
  type: z.literal('wait'),
  ms: z.number().nonnegative(),
});

const vector3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * `camera` — a scripted camera flight, frame-accurate (R1: it replaced the wheel zoom in the
 * pilot).
 *
 * `durationSec` default 0.6 — the SAME default as the viewer API
 * (`animateCameraTo(position, target, duration = 0.6, …)`, rv-viewer.ts:7686), so schema and page
 * cannot drift apart. Without it `framesOf(camera.durationSec, fps)` would be NaN.
 */
const cameraAction = z.object({
  type: z.literal('camera'),
  position: vector3,
  target: vector3,
  durationSec: z.number().positive().default(0.6),
});

/**
 * plan-2237 F8: a time-lapse section. While the command runs, the take leaves the virtual clock and
 * grabs `fps` frames per WALL second (2..8) for at most `maxWallSec` wall seconds.
 */
export const TIMELAPSE_FPS_MIN = 2;
export const TIMELAPSE_FPS_MAX = 8;
const timelapse = z.object({
  fps: z.number().min(TIMELAPSE_FPS_MIN).max(TIMELAPSE_FPS_MAX),
  maxWallSec: z.number().positive(),
}).strict();

const commandAction = z.object({
  type: z.literal('command'),
  id: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  buttonKey: z.string().optional(),
  via: z.enum(['click', 'direct']).default('click'),
  waitSec: z.number().nonnegative().default(0.3),
  maxWaitSec: z.number().positive().default(30),
  timelapse: timelapse.optional(),
});

const pickAction = z.object({
  type: z.literal('pick'),
  rule: z.literal('moving-vehicle'),
  among: z.string().min(1),
  as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  sampleSec: z.number().positive().default(0.3),
});

export const actionSchema = z.union([
  pointerAction,
  dragAction,
  wheelAction,
  pressAction,
  typeAction,
  waitForAction,
  waitAction,
  cameraAction,
  commandAction,
  pickAction,
]);

/**
 * A step. `hold` is NOT in this union — it is exclusively a SEGMENT kind (the live-held remainder
 * of a step after its last action, F10r). An action "hold a key" only arrives once a momentary
 * push-button has actually been measured.
 */
export const stepSchema = z.object({
  id: STEP_ID,
  holdSec: z.number().positive().optional(),   // default = minStepSec, resolved after parsing
  actions: z.array(actionSchema).min(1),
  zoom: z.union([z.literal('auto'), z.literal('none'), z.number()]).default('auto'),
  tailSec: z.number().nonnegative().default(0.4),
  // plan-2240: Gate C per step. Deliberately NOT defaulted here: an absent value means "follow the
  // CLI --motion-check", an explicit one wins over it. The run resolves it (`resolveMotionPolicy`).
  motion: z.enum(MOTION_POLICIES).optional(),
  say: z.unknown().optional(),                 // plan-676: tolerated, ignored, never a refusal
}).passthrough();

const box = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).strict();

/**
 * plan-2240: the localStorage keys the recorder itself seeds before every load (terms, CONNECT
 * auto-connect opt-out, auto-quality, welcome). A storyboard `storage` entry may overwrite one of
 * them only with `storageOverride: true`.
 */
export const RECORDER_SEED_KEYS = Object.freeze([
  'rv-terms-accepted', 'rv-connect-autoconnect-optout', 'rv-auto-quality-applied', 'rv-welcome-dismissed',
]);

/** plan-2240: storyboard localStorage seeds — only keys of the viewer's own `rv-` namespace. */
const storage = z.record(z.string().regex(/^rv-/, "storage keys must start with 'rv-'"), z.string());

export const tutorialSchema = z.object({
  $schema: z.literal(SCHEMA_ID, { message: `unsupported schema version — this runner reads '${SCHEMA_ID}' only (renaming a field is a major bump)` }),
  id: STEP_ID,
  title: z.string().min(1),
  url: z.string().min(1),
  connect: z.enum(['off', 'live']).default('off'),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict().default({ width: 1920, height: 1080 }),
  welcome: z.enum(['show', 'dismiss']).default('dismiss'),
  // 'editor': the editor holds the simulation still without pausing it; only the clock is checked.
  start: z.enum(['running', 'paused', 'editor']).default('running'),
  ready: z.string().min(1).default('#rv-viewport'),
  minStepSec: z.number().positive().default(2),
  motionRegion: box.default({ x: 760, y: 500, w: 400, h: 400 }),
  // plan-2043: where the frame stamp goes. 'proof' (default): recording.mp4 stays pristine and the
  // stamp is grabbed per frame into a separate proof track `stamp-proof.mp4`. 'inline': the stamp is
  // burned into the app's top-left corner (the behaviour before plan-2043). CLI `--stamp` overrides it.
  stamp: z.enum(['proof', 'inline']).default('proof'),
  setup: z.array(actionSchema).default([]),
  // plan-2240: localStorage seeds, applied before every load AFTER the recorder's own seeds and its
  // panel cleanup — an explicit `rv-panel-geo:*` entry therefore survives.
  storage: storage.default({}),
  storageOverride: z.boolean().default(false),
  steps: z.array(stepSchema).min(1),
  voice: z.unknown().optional(),               // plan-676: tolerated, ignored
}).passthrough();

/**
 * Parses and normalises a storyboard.
 *
 * After this call EVERY duration is a number: `holdSec` falls back to `minStepSec`, `tailSec`,
 * `camera.durationSec`, `waitFor.timeoutMs`, `drag.durationMs` and `type.delayMs` carry their
 * defaults, as do `command.waitSec`, `command.maxWaitSec` and `pick.sampleSec`.
 * References must follow their pick binding. Throws an `Error` naming the failing location.
 */
export function parseTutorial(raw) {
  const parsed = tutorialSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`storyboard is not a valid ${SCHEMA_ID}: ${where}`);
  }
  const script = parsed.data;

  const bindings = new Set();
  function checkReferences(value, where) {
    if (typeof value === 'string') {
      const reference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
      if (reference && !bindings.has(reference[1])) {
        throw new Error(`storyboard ${where}: unbound reference '${value}' — requires an earlier pick`);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) checkReferences(child, where);
    }
  }

  function checkActions(actions, location, isSetup, rawActions) {
    for (const [index, action] of actions.entries()) {
      const where = `${location} action ${index}`;
      if (action.type === 'pick') {
        if (bindings.has(action.as)) {
          throw new Error(`storyboard ${where}: duplicate pick binding '${action.as}'`);
        }
        bindings.add(action.as);
      }
      if (action.type === 'command') {
        // plan-2237 F7: `des.fastForward {untilSimTime}` is allowed in the take — the segment gate
        // treats it as a transition and the following paused frames as a hold segment.
        if (action.timelapse) {
          if (isSetup) throw new Error(`storyboard ${where}: timelapse records frames and is allowed only in a step, not in setup`);
          // Phase 2: during the time-lapse `maxWallSec` is the command's wait budget; an EXPLICIT
          // `maxWaitSec` below it contradicts that.
          const rawMax = rawActions?.[index]?.maxWaitSec;
          if (typeof rawMax === 'number' && rawMax < action.timelapse.maxWallSec) {
            throw new Error(`storyboard ${where}: maxWaitSec ${rawMax} s is below timelapse.maxWallSec ${action.timelapse.maxWallSec} s — during a time-lapse maxWallSec is the wait budget`);
          }
        }
        checkReferences(action.args, where);
      }
      // Only node paths and recording keys are references; selectors and literal text are not.
      for (const candidate of [action.target, action.from, action.to, action.at]) {
        if (candidate && typeof candidate === 'object') {
          if ('node' in candidate) checkReferences(candidate.node, where);
          if ('recordingTarget' in candidate) checkReferences(candidate.key, where);
        }
      }
    }
  }

  checkActions(script.setup, 'setup', true, raw?.setup);

  if (!script.storageOverride) {
    const protectedKeys = Object.keys(script.storage).filter((key) => RECORDER_SEED_KEYS.includes(key));
    if (protectedKeys.length > 0) {
      throw new Error(`storyboard storage: ${protectedKeys.join(', ')} ${protectedKeys.length === 1 ? 'is a seed' : 'are seeds'} of the recorder itself — set 'storageOverride: true' to overwrite`);
    }
  }
  if (script.steps.every((step) => step.motion === 'off')) {
    throw new Error("storyboard steps: every step has motion 'off' — a take needs at least one step that Gate C measures");
  }

  const seen = new Set();
  for (const step of script.steps) {
    if (seen.has(step.id)) throw new Error(`storyboard has a duplicate step id '${step.id}' — ids address segments and still frames and must be unique`);
    seen.add(step.id);
    if (step.holdSec === undefined) step.holdSec = script.minStepSec;
    checkActions(step.actions, `step '${step.id}'`, false, Array.isArray(raw?.steps) ? raw.steps.find((candidate) => candidate?.id === step.id)?.actions : undefined);
  }
  return script;
}
