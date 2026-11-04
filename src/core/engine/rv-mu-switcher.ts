// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVMUSwitcher — TypeScript counterpart of Unity `MUSwitcher.cs` (plan-2016 S5).
 *
 * Switches the visible variant of an MU when it enters the `Sensor` on the same
 * node: inside the entering MU, every node carrying a group whose name is
 * `SwitchToGroup` becomes visible, every node carrying another group becomes
 * hidden. Nodes without a group are left alone. Unity semantics, exactly:
 *  - trigger: `Sensor.EventMUSensor(mu, occupied)` with `occupied == true` —
 *    here the sensor's MU-enter event (`addMuEnterListener`), which also fires
 *    for MU B entering right after MU A without a free state in between;
 *  - scope: `mu.GetComponentsInChildren<Group>(true)` — the MU root included,
 *    inactive nodes included; only THIS MU, never the scene-wide GroupRegistry;
 *  - a node with several groups: Unity visits each `Group` component in order
 *    and the LAST one decides the `SetActive` — mirrored here;
 *  - leaving the sensor does nothing.
 *
 * Group names are read by `groupLabelsOf` (rv-mu-group-labels.ts), which works
 * for a spawned clone too (its rv-extras are stripped, the label list is kept).
 * Switching is Unity `SetActive` (`setNodeActive`): an authored-inactive variant
 * becomes active. Afterwards the MU's mesh box is re-measured from the active
 * variant and the MU re-indexed (`refreshShapeFromMeshes` + `reindexMU`).
 * An instanced MU has no node subtree to switch and is skipped (a template with
 * switchable variants never takes the instanced path, `analyzeTemplate`).
 *
 * No per-frame code: the work happens only at an MU entry.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { RVSensor } from './rv-sensor';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { groupLabelsOf } from './rv-mu-group-labels';
import { setNodeActive } from './rv-authored-inactive';
import { NodeRegistry } from './rv-node-registry';
import { reportProblem, clearProblem } from '../hmi/problems-store';
import { debug } from './rv-debug';

/** Problem code: a MUSwitcher without a Sensor on its node never fires. */
export const MUSWITCHER_NO_SENSOR = 'muswitcher-no-sensor';

/**
 * Apply `group` to the subtree of `root` (Unity `MUSwitcher.OnSensorEvent`):
 * group nodes named `group` visible, other group nodes hidden. Returns the
 * number of group nodes visited. Exported for tests and tools.
 */
export function switchMuGroup(root: Object3D, group: string): number {
  let visited = 0;
  root.traverse((node) => {
    const labels = groupLabelsOf(node);
    if (labels.length === 0) return;
    visited++;
    // The last Group component of the node decides (Unity iterates them in order).
    // `SetActive`, not just `.visible`: a variant authored inactive
    // (`activeSelf: false`, flagged `_rvInactive`) becomes ACTIVE — it counts for
    // the MU size again — and a variant switched off stops counting.
    setNodeActive(node, labels[labels.length - 1] === group);
  });
  return visited;
}

export class RVMUSwitcher implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('MUSwitcher');

  readonly node: Object3D;
  isOwner = true;

  /** Name of the group shown in an entering MU; every other group of that MU is hidden. */
  SwitchToGroup = '';

  private sensor: RVSensor | null = null;
  private problemId: string | null = null;
  private ctx: ComponentContext | null = null;
  private readonly listener = (mu: RVMovingUnit | InstancedMovingUnit): void => this.onMuEnter(mu);

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this.ctx = context;
    // A load path with a late pass binds there — the Sensor on this node may be
    // created after this component. Runtime construction binds right away.
    if (!context.expectSceneReady) this.bind();
  }

  onSceneReady(context: ComponentContext): void {
    this.ctx = context;
    this.bind();
  }

  /** The sensor this switcher listens to (null when none was found). */
  getSensor(): RVSensor | null {
    return this.sensor;
  }

  getLiveState(): Record<string, unknown> {
    return { SwitchToGroup: this.SwitchToGroup };
  }

  private bind(): void {
    if (this.sensor) return;
    const sensor = this.findSensor();
    if (!sensor) {
      const path = NodeRegistry.computeNodePath(this.node);
      this.problemId = `${MUSWITCHER_NO_SENSOR}:${path}`;
      reportProblem({
        id: this.problemId,
        severity: 'warning',
        code: MUSWITCHER_NO_SENSOR,
        title: `MUSwitcher without Sensor on ${this.node.name}`,
        detail: `The MUSwitcher on "${path}" needs a Sensor component on the same node — `
          + `it switches an MU to group "${this.SwitchToGroup}" when that MU enters the sensor. `
          + 'Without a sensor nothing is ever switched.',
      });
      return;
    }
    this.sensor = sensor;
    sensor.addMuEnterListener(this.listener);
    debug('loader', `  MUSwitcher "${this.node.name}": sensor bound, SwitchToGroup="${this.SwitchToGroup}"`);
  }

  private findSensor(): RVSensor | null {
    const registry = this.ctx?.registry;
    if (registry) {
      const path = registry.getPathForNode(this.node);
      const viaRegistry = path ? registry.getByPath<RVSensor>('Sensor', path) : null;
      if (viaRegistry instanceof RVSensor) return viaRegistry;
    }
    const inst = this.node.userData?._rvComponentInstance as unknown;
    return inst instanceof RVSensor ? inst : null;
  }

  private onMuEnter(mu: RVMovingUnit | InstancedMovingUnit): void {
    if (mu.isInstanced || mu.markedForRemoval) return;
    const clone = mu as RVMovingUnit;
    const visited = switchMuGroup(clone.node, this.SwitchToGroup);
    // The MU now has another shape: re-measure its box from the active variant
    // and re-index it, so transport, grid and sensors see the new form at once.
    if (visited > 0 && clone.refreshShapeFromMeshes()) this.ctx?.transportManager?.reindexMU(clone);
    debug('sensor', `MUSwitcher "${this.node.name}": MU "${mu.getName()}" → group "${this.SwitchToGroup}" (${visited} group node(s))`);
  }

  dispose(): void {
    this.sensor?.removeMuEnterListener(this.listener);
    this.sensor = null;
    if (this.problemId) clearProblem(this.problemId);
    this.problemId = null;
    this.ctx = null;
  }
}

registerComponent({
  type: 'MUSwitcher',
  schema: RVMUSwitcher.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    pick: 'none',
    // bake stays 'merge': a pure listener; its node survives as a component node.
    ui: { badge: '#66bb6a', category: 'sensors' },
  },
  create: (node) => new RVMUSwitcher(node),
});
