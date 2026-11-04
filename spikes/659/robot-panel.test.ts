// plan-659 — the guard that lets the operator panel live in the DOCUMENT.
//
// The panel moved out of the plugin and into the GLB
// (`extras.realvirtual.WebOperatorPanel.Config`). That buys self-description
// and a panel change without a plugin rebuild, and it costs ONE thing: the
// config now names its signals as plain strings instead of referencing
// `ROBOT_CMD` / `ROBOT_OUT`, so a rename in `rv-mujoco-signals.ts` no longer
// breaks the build.
//
// At runtime that failure is loud — the controller refuses a config whose
// signal is not in the store, with the JSON path, and the Problems panel shows
// it. This file makes it loud at TEST time too, which is where a rename is
// made. Three questions, in the order they can go wrong:
//
//   1. is the JSON a valid operator panel at all?
//   2. does every signal it names exist in the robot's signal interface?
//   3. does the generated demo document actually carry it?
//
// (3) is skipped when the document has not been generated — it is a build
// artefact (`node spikes/659/make-demo-project.mjs`), not a checked-in file.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  operatorPanelAnalogSignals, operatorPanelSignals, validateOperatorPanelConfig,
} from '@rv/core/hmi/operator-devices/operator-panel-model';
import { parseWebOperatorPanelConfig } from '@rv/core/engine/rv-extras-validator';
import ROBOT_PANEL from '../../../realvirtual-WebViewer-Private~/src/mujoco/robot-panel.json';
import {
  ROBOT_CMD, ROBOT_OUT, robotSignals,
} from '../../../realvirtual-WebViewer-Private~/src/mujoco/rv-mujoco-signals';

const DEMO_GLB = resolve(__dirname, '../../public/spike-659-duck/rv-walker.glb');

/** Every signal name the plugin registers — the store the panel will meet. */
const INTERFACE = new Set(robotSignals(0.25).map((s) => s.name));

describe('robot operator panel (as a document component)', () => {
  it('is a valid operator panel config', () => {
    const { config, errors } = validateOperatorPanelConfig(ROBOT_PANEL);
    expect(errors).toEqual([]);
    expect(config).not.toBeNull();
    expect(config!.id).toBe('robot-locomotion-panel');
  });

  it('names only signals the robot interface registers', () => {
    const { config, errors } = validateOperatorPanelConfig(ROBOT_PANEL, (n) => INTERFACE.has(n));
    // With `hasSignal` the validator reports an unknown signal WITH its JSON
    // path, which is exactly the message a renamer needs.
    expect(errors).toEqual([]);
    const used = [...operatorPanelSignals(config!), ...operatorPanelAnalogSignals(config!)];
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(INTERFACE.has(name)).toBe(true);
  });

  it('uses the four commands and the four readouts the demo is built around', () => {
    const used = new Set(JSON.stringify(ROBOT_PANEL).match(/"Robot[A-Za-z]+"/g)?.map((s) => s.slice(1, -1)) ?? []);
    for (const name of [ROBOT_CMD.enable, ROBOT_CMD.reset, ROBOT_CMD.push, ROBOT_CMD.camFollow,
      ROBOT_CMD.vx, ROBOT_CMD.pushStrength]) expect(used.has(name)).toBe(true);
    for (const name of [ROBOT_OUT.distance, ROBOT_OUT.baseHeight, ROBOT_OUT.falls,
      ROBOT_OUT.recoveries, ROBOT_OUT.running, ROBOT_OUT.fallen, ROBOT_OUT.recovering]) {
      expect(used.has(name)).toBe(true);
    }
  });

  it.skipIf(!existsSync(DEMO_GLB))('is carried by the generated demo document', async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const doc = await new NodeIO().read(DEMO_GLB);
    const carriers = doc.getRoot().listNodes().filter((n) => {
      const rv = (n.getExtras() as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
      return rv !== undefined && rv.WebOperatorPanel !== undefined;
    });
    expect(carriers).toHaveLength(1);
    const comp = (carriers[0].getExtras() as { realvirtual: { WebOperatorPanel: { Config: unknown } } })
      .realvirtual.WebOperatorPanel;
    // Stored as a JSON STRING (the authored form) and byte-identical to the SSOT.
    expect(typeof comp.Config).toBe('string');
    expect(parseWebOperatorPanelConfig(comp.Config).raw).toEqual(ROBOT_PANEL);
    // …and the SSOT on disk is what was written, not a stale copy.
    expect(JSON.parse(readFileSync(
      resolve(__dirname, '../../../realvirtual-WebViewer-Private~/src/mujoco/robot-panel.json'), 'utf8',
    ))).toEqual(ROBOT_PANEL);
  });
});
