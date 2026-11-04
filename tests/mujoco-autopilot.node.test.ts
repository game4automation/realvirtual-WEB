// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mujoco-autopilot.node.test.ts — the walker leaves for the obstacles by itself,
 * and hands the robot over the moment a hand touches it (plan-673 O18).
 *
 * Thomas, 2026-10-25: *"Startet auf Hindernisse zu."*
 *
 * ## The defect it closes, and why a "does it walk" test is worthless here
 *
 * With the document's plain `command.vx` the walker leaves on a curve and misses
 * the entire course. Measured in the production build, twice: 60 s and 37 s of
 * walking, `distanceM` 2.8 and 1.7 — and **not one** robot/obstacle contact. A
 * blind policy drifts about 0.5 m per 5 m and every station of the field is one
 * obstacle deep, so a visitor who only pressed Play never saw the thing the page
 * is about. `fallCount` was 0 through all of it, which is exactly why that number
 * was twice mistaken for success.
 *
 * So the end-to-end acceptance is a BROWSER measurement (contact pairs > 0 and an
 * obstacle displaced, with no key ever pressed), recorded in the plan. What this
 * file can own cheaply and deterministically is the part that silently rots: the
 * two numbers the document declares, and the hand-over rule.
 *
 * ## Why the config is refused rather than defaulted
 *
 * `idleSeconds: "5"` is the failure worth a test. Coerced to 0 it would hand the
 * command back on every single frame, so the autopilot and the operator would
 * write the same three signals in turn — a robot fighting its own dial, which
 * nobody would trace back to a quoted number in a GLB.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRobotConfig } from '@rv-private/mujoco/rv-mujoco-locomotion-runtime';
import { ROBOT_CMD, robotSignals } from '@rv-private/mujoco/rv-mujoco-signals';

const WEB_ROOT = resolve(__dirname, '..');
const PLUGIN = resolve(WEB_ROOT, '../realvirtual-WebViewer-Private~/src/mujoco/rv-mujoco-plugin.ts');

/** A minimal valid `rv_mujoco` record; only `autopilot` varies per case. */
const record = (autopilot?: unknown): Record<string, unknown> => ({
  v: 1,
  mjcf: 'rvproject:w/robot.xml',
  contract: 'rvproject:w/contract.json',
  policies: { walking: 'rvproject:w/p.onnx' },
  trunkBody: 'trunk_base',
  gyroSensor: 'imu_ang_vel',
  ...(autopilot === undefined ? {} : { autopilot }),
});

// ── 1. the declared numbers ─────────────────────────────────────────────────

describe('rv_mujoco.autopilot — read from the document, never guessed', () => {
  it('is absent by default, so an existing document behaves exactly as before', () => {
    expect(parseRobotConfig(record())?.autopilot).toBeUndefined();
  });

  it('fills the walker defaults when the block is present but bare', () => {
    // 5 s and 50 mm are the plan-673 O18 decisions; if someone changes them,
    // this test is where they say so.
    expect(parseRobotConfig(record({}))?.autopilot)
      .toEqual({ enabled: true, idleSeconds: 5, doneMm: 50, reachMm: 300 });
  });

  it('honours the document values, including switching itself off', () => {
    expect(parseRobotConfig(record({ enabled: false }))?.autopilot?.enabled).toBe(false);
    expect(parseRobotConfig(record({ idleSeconds: 2.5, doneMm: 120 }))?.autopilot)
      .toEqual({ enabled: true, idleSeconds: 2.5, doneMm: 120, reachMm: 300 });
    // Zero is a legitimate choice (hand back immediately), so it must pass.
    expect(parseRobotConfig(record({ idleSeconds: 0 }))?.autopilot?.idleSeconds).toBe(0);
  });

  it('refuses a value that would silently become zero or nonsense', () => {
    for (const bad of [{ idleSeconds: '5' }, { idleSeconds: -1 }, { doneMm: null },
      { idleSeconds: Number.NaN }, { enabled: 'yes' }]) {
      expect(() => parseRobotConfig(record(bad)), JSON.stringify(bad)).toThrow(/autopilot/);
    }
    expect(() => parseRobotConfig(record(42))).toThrow(/autopilot must be an object/);
  });

  it('the shipped walker document declares it, configured and OFF (plan-673 O19)', () => {
    // Read from the ARTEFACT, never from the generator's source: the GLB is
    // what a visitor loads, and a source-text assertion would have passed just
    // as happily on a document nobody rebuilt. (It is written by
    // `scripts/build-mujoco-walker-demo.mjs`, which is also where the config
    // has to live — the `devOnly` lesson: a value that lives only in
    // project.json survives exactly one build.)
    //
    // `enabled: false` is Thomas's decision of 2026-10-25 ("Aus + Schalter im
    // Panel"): the autopilot fights the operator. The three numbers stay, and
    // they stay authoritative — the switch is what changed, not the mechanism.
    const glb = readFileSync(resolve(WEB_ROOT, 'public/demo-realvirtual/MuJoCoWalker.glb'));
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as
      { nodes: { extras?: { rv_mujoco?: unknown } }[] };
    const raw = gltf.nodes.find((n) => n.extras?.rv_mujoco !== undefined)?.extras?.rv_mujoco;
    expect(parseRobotConfig(raw)?.autopilot)
      .toEqual({ enabled: false, idleSeconds: 5, doneMm: 50, reachMm: 300 });
    const script = readFileSync(
      resolve(WEB_ROOT, 'scripts/build-mujoco-walker-demo.mjs'), 'utf8');
    expect(script).toMatch(
      /mujoco\.autopilot = \{ enabled: false, idleSeconds: 5, doneMm: 50, reachMm: 300 \}/);
  });
});

// ── 1b. the switch (plan-673 O19) ───────────────────────────────────────────

describe('autopilot — a switch on the plate, not a build-time constant', () => {
  const plugin = readFileSync(PLUGIN, 'utf8');

  it('the gate is the SIGNAL, not the document value', () => {
    // The decisive line. `cfg.enabled !== true` here would mean the knob is
    // decoration: the document says off, so it would stay off for ever.
    const body = plugin.slice(plugin.indexOf('private applyAutopilot'),
      plugin.indexOf('// ── The signal interface'));
    expect(body).toMatch(/this\.bool\(ROBOT_CMD\.autopilot\)/);
    // And a document with NO autopilot block still has no autopilot — the
    // numbers are the document's and are not invented in the plugin.
    expect(body).toMatch(/if \(!cfg \|\| !this\.bool\(ROBOT_CMD\.autopilot\)/);
  });

  it('the document value is the signal\'s INITIAL value, so "off" is still the resting state', () => {
    expect(plugin).toMatch(/robotSignals\(vx, PUSH_FALL, config\.autopilot\?\.enabled === true\)/);
  });

  it('the shipped plate carries the knob, wired to that signal', () => {
    // Read out of the GLB again: the panel the visitor gets is the one inside
    // the document, not the JSON in the private tree.
    const glb = readFileSync(resolve(WEB_ROOT, 'public/demo-realvirtual/MuJoCoWalker.glb'));
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as
      { nodes: { extras?: { realvirtual?: { WebOperatorPanel?: { Config?: string } } } }[] };
    const cfgText = gltf.nodes
      .find((n) => n.extras?.realvirtual?.WebOperatorPanel !== undefined)
      ?.extras?.realvirtual?.WebOperatorPanel?.Config;
    expect(typeof cfgText).toBe('string');
    const cfg = JSON.parse(cfgText as string) as {
      selectors: { signal: string; positions: { value: boolean }[] }[];
    };
    const knob = cfg.selectors.find((s) => s.signal === 'RobotAutopilot');
    expect(knob, 'the plate has no Autopilot selector').toBeDefined();
    // Two positions, boolean — the switch has to be able to express both states.
    expect(knob!.positions.map((p) => p.value)).toEqual([false, true]);
  });

  it('the signal is part of the robot interface, and the document sets its initial value', () => {
    // Behaviour, not a grep: the interface is asked for its own rows.
    const off = robotSignals(0.25).find((s) => s.name === ROBOT_CMD.autopilot);
    expect(off, 'RobotAutopilot is not in the robot interface').toBeDefined();
    expect(off!.plcType).toBe('PLCOutputBool');
    // Off unless the document says otherwise — a command the viewer reads is a
    // PLC Output, which is what lets the plate, a PLC and MCP all write it.
    expect(off!.initial).toBe(false);
    const on = robotSignals(0.25, 1.0, true).find((s) => s.name === ROBOT_CMD.autopilot);
    expect(on!.initial).toBe(true);
  });
});

// ── 2. the hand-over rule ───────────────────────────────────────────────────

describe('autopilot — one command chain, and the operator always wins', () => {
  const plugin = readFileSync(PLUGIN, 'utf8');

  it('writes the same command signals as every other operator, not a side path', () => {
    // The requirement in one assertion: no `runtime.setCommand` of its own, no
    // direct qpos write — the autopilot's whole output is the three ROBOT_CMD
    // signals, so a PLC over CONNECT and an MCP call still see and can force it.
    const body = plugin.slice(plugin.indexOf('private applyAutopilot'),
      plugin.indexOf('// ── The signal interface'));
    expect(body).toMatch(/operatorWrite\(ROBOT_CMD\.vx, cmd\.vx\)/);
    expect(body).toMatch(/operatorWrite\(ROBOT_CMD\.yaw, cmd\.yaw\)/);
    expect(body).not.toMatch(/setCommand|positionOverwrite|qpos/);
  });

  it('runs after the keyboard and releases the command while keys are held', () => {
    expect(plugin).toMatch(/const keysHeld = this\.applySteering\(\)/);
    expect(plugin).toMatch(/this\.applyAutopilot\(dt, keysHeld\)/);

    // No blending and no regulator pulling against the operator (O18/2). This
    // is asserted as BEHAVIOUR, not as a distance in characters: the first
    // version of this test demanded `autoWrote = null` within 120 characters of
    // the `return`, and the four comment lines that explain the second ratchet
    // defect pushed them apart. It failed on the explanation it should have been
    // protecting. A contract over character distance is not a contract over
    // behaviour — it only says "write no comment here", which is not the rule.
    //
    // So: take the branch up to its `return`, require that it gives the command
    // up, and require that it writes NOTHING and scales NOTHING on the way out.
    const at = plugin.indexOf('if (keysHeld || foreign)');
    expect(at).toBeGreaterThan(0);
    const branch = plugin.slice(at, plugin.indexOf('return;', at) + 'return;'.length);
    expect(branch).toMatch(/this\.autoWrote = null;/);
    expect(branch).toMatch(/return;\s*$/);
    // Releasing means releasing: not one command write, and no arithmetic on a
    // command — a `*=`, a lerp/mix/blend or a clamp here would be a regulator
    // still pulling at the dial while a hand is on it.
    //
    // Checked against the CODE with the comments stripped, which is the same
    // lesson once more: the first attempt at this line read the word "blending"
    // out of the branch's own comment ("Release the command completely — no
    // blending") and failed on prose that says the opposite of what it matched.
    // A negative assertion over source text must never see the prose.
    const code = branch.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/operatorWrite|steerCommand|setCommand/);
    expect(code).not.toMatch(/\*=|lerp|mix\(|blend|clampTo|Math\.(min|max)/);
  });

  it('detects a takeover by reading the store back, not by listing input sources', () => {
    // The panel dial, a PLC and an MCP write are not enumerated anywhere — the
    // autopilot compares the live triple against what it last wrote. That is
    // what makes "the operator took over" mean the same thing for all of them.
    expect(plugin).toMatch(/const foreign = mine !== null/);
    expect(plugin).toMatch(/Read BACK, never the intended values/);
    expect(plugin).toMatch(/this\.autoWrote = \[\s*\n?\s*this\.num\(ROBOT_CMD\.vx, 0\)/);
  });

  it('starts pursuing immediately rather than after one idle period', () => {
    // `autoIdleS` opens at infinity in `activate`, so Play alone is enough.
    expect(plugin).toMatch(/this\.autoIdleS = Number\.POSITIVE_INFINITY/);
  });

  it('skips welded obstacles and ones it has already shifted', () => {
    const body = plugin.slice(plugin.indexOf('private applyAutopilot'),
      plugin.indexOf('// ── The signal interface'));
    // Without `!s.free` the robot leans on a 3.4 m post forever; without
    // `movedM > doneM` it chases the ball it just kicked.
    expect(body).toMatch(/if \(!s\.free \|\| s\.movedM > doneM\) return null;/);
  });

  it('keeps its target until that target stops being a candidate', () => {
    // Measured: "nearest eligible, every tick" chatters. Two stations of the
    // walker field sit at almost the same distance, the robot's body sway flips
    // which is nearer several times a second, and the steering reverses with it
    // — the target log showed obs_ball_a2 and obs_cube_s1 alternating ~40 times
    // while yaw sat on its limit and vx on 0. Not indecision about where to go:
    // it was being asked twice a second to go somewhere else.
    const body = plugin.slice(plugin.indexOf('private applyAutopilot'),
      plugin.indexOf('// ── The signal interface'));
    expect(body).toMatch(/const held = this\.autoTargetName === null/);
    expect(body).toMatch(/if \(held && keep\) \{/);
  });

  it('never takes its walk speed from the dial it writes to', () => {
    // THE defect of this feature, and it bit twice (plan-673 O18):
    //  - read live, `vx = speed · max(0, cos err)` closes a loop through the
    //    signal and the robot decays to a stop mid-turn;
    //  - captured once per engagement it captures its OWN turned-down output —
    //    measured 0.062 m/s, below the speed this policy starts walking at, so
    //    the robot stood on the spot for 40 s with a plausible command on it.
    // Hence: the engage path reads `autoCruise` or the DOCUMENT, never `vx`.
    expect(plugin).toMatch(/const speed = this\.autoCruise\s*\n?\s*\?\?\s*\(this\.config\?\.command\?\.vx/);
    // And the dial is sampled at exactly one place: the hand-over, and only
    // when it was not the keyboard (whose own writes are alignment-scaled too).
    expect(plugin.match(/this\.autoCruise = (?!null)/g) ?? []).toHaveLength(1);
    expect(plugin).toMatch(/if \(!keysHeld && vx > 0\.05\) this\.autoCruise = vx;/);
  });

  it('never aims at something inside its own turning circle', () => {
    // The single comparison that keeps the autopilot out of a limit cycle, and
    // the one that two measured runs were needed to find. With no radius the
    // robot orbited the second ball for 35 s of simulation; with a "close
    // enough, walk straight through" branch instead it pirouetted beside the
    // FIRST ball for 54 s, yaw saturated at -1 and vx at 0.04 m/s, because that
    // ball had moved only 42 mm (below doneMm, so it stayed the target) and the
    // robot could not turn to face something 0.1 m away. Gain tuning cannot fix
    // a target inside the turning circle.
    const body = plugin.slice(plugin.indexOf('private applyAutopilot'),
      plugin.indexOf('// ── The signal interface'));
    expect(body).toMatch(/return d < reachSq \? null : \{ dx, dy, d \};/);
    // And with nothing left in range it must write NOTHING, so the document's
    // own command.vx carries the robot on rather than stopping it dead.
    expect(body).toMatch(/if \(name === null\) \{ this\.autoWrote = null; return; \}/);
  });

  it('never commands a reverse walk', () => {
    // The policy was trained forwards only; `max(0, cos)` is what makes the
    // robot turn in place for a target behind it instead of backing into it.
    expect(plugin).toMatch(/speed \* Math\.max\(0, Math\.cos\(err\)\)/);
  });
});
