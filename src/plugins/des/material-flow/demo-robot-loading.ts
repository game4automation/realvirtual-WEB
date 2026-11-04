// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Internal programmatic reference layout for DES robot unloading.
 *
 * This module is intentionally not imported by the production material-flow
 * aggregator. DEV tools and tests opt in explicitly, keeping the reference
 * scene out of public scene manifests and customer deployments.
 */

import { Object3D } from 'three';
import type { BindContextHost } from '../../../core/behavior-runtime';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type { MaterialFlowSelf } from '../../../core/material-flow/material-flow-self';
import '../../../behaviors/Sink';
import { DESRunner } from '../des-runner';
import { bindSceneToRunner } from '../des-scene-binding';
import { PalletSource } from './PalletSource';
import { RobotHandling } from './RobotHandling';
import { IndexingConveyor } from './IndexingConveyor';
import { Station } from './Station';
import { Processing } from './Processing';
import { PathTransport } from './PathTransport';

const MM_TO_M = 0.001;

export const ROBOT_LOADING_REFERENCE_DURATION_SECONDS = 8 * 60 * 60;
export const ROBOT_LOADING_REFERENCE_SEED = 297;

export interface RobotLoadingDemoOptions {
  readonly palletCount?: number;
  readonly blistersPerPallet?: number;
  readonly partsPerBlister?: number;
  readonly masterSeed?: number;
  readonly durationSeconds?: number;
}

export interface RobotLoadingLogicalConnection {
  readonly from: string;
  readonly to: string;
  readonly port: 'out' | 'empty';
}

export interface RobotLoadingDemoScene {
  readonly root: Object3D;
  readonly nodes: ReadonlyMap<string, Object3D>;
  readonly logicalConnections: readonly RobotLoadingLogicalConnection[];
  readonly expected: {
    readonly pallets: number;
    readonly blisters: number;
    readonly parts: number;
    readonly totalMUs: number;
    readonly emptyCarriers: number;
  };
  readonly masterSeed: number;
  readonly durationSeconds: number;
}

export interface RobotLoadingDemoRuntime extends RobotLoadingDemoScene {
  readonly runner: DESRunner;
  readonly boundCount: number;
}

export interface RobotLoadingDemoResult {
  readonly simTime: number;
  readonly masterSeed: number;
  readonly generatedPallets: number;
  readonly createdMUs: number;
  readonly liveMUs: number;
  readonly partThroughput: number;
  readonly emptyCarrierThroughput: number;
  readonly throughputPerHour: number;
  readonly totalEventsProcessed: number;
  readonly pendingEvents: number;
  readonly activeReservations: number;
  readonly horizonReached: boolean;
  readonly componentLoads: Readonly<Record<string, number>>;
}

const DemoHorizon: MaterialFlowDefinition<MaterialFlowSelf> = defineMaterialFlow<MaterialFlowSelf>({
  type: 'RobotLoadingDemoHorizon',
  kind: 'downtime',
  schema: { durationSeconds: { type: 'number', default: ROBOT_LOADING_REFERENCE_DURATION_SECONDS } },
  continuous: {},
  des: {
    onGenerate(self): void {
      const duration = self.prop.durationSeconds;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('RobotLoadingDemoHorizon: durationSeconds must be greater than zero');
      }
      self.in(duration, 'ProcessComplete', null, { phase: 'reference-horizon' });
    },
    onProcessComplete(self, _mu, data): void {
      if ((data as { phase?: unknown } | null)?.phase === 'reference-horizon') {
        self.prop.horizonReached = true;
      }
    },
  },
});

const DemoEmptyCarrierRelay: MaterialFlowDefinition<MaterialFlowSelf> =
  defineMaterialFlow<MaterialFlowSelf>({
    type: 'RobotLoadingDemoEmptyCarrierRelay',
    kind: 'storage',
    schema: { MaxCapacity: { type: 'number', default: 1 } },
    capacity: (self): number => self.prop.MaxCapacity as number,
    continuous: {},
    des: {
      onAccept(self, mu): boolean {
        self.transfer(mu);
        return true;
      },
    },
  });

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Robot loading demo: ${name} must be a positive integer`);
  }
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Robot loading demo: ${name} must be greater than zero`);
  }
  return value;
}

function makeVirtualNode(
  name: string,
  type: string,
  config: Record<string, unknown>,
  positionMm: readonly [number, number, number],
): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(
    positionMm[0] * MM_TO_M,
    positionMm[1] * MM_TO_M,
    positionMm[2] * MM_TO_M,
  );
  node.userData.realvirtual = {
    LayoutObject: { virtual: true, internalReference: 'des-robot-loading' },
    [type]: config,
  };
  return node;
}

function addSnap(root: Object3D, name: string, positionMm: readonly [number, number, number]): void {
  const snap = new Object3D();
  snap.name = `Snap-${name}`;
  snap.position.set(
    positionMm[0] * MM_TO_M,
    positionMm[1] * MM_TO_M,
    positionMm[2] * MM_TO_M,
  );
  root.add(snap);
}

function addIndexingCarriers(root: Object3D, count: number, pitchMm: number): void {
  for (let i = 0; i < count; i++) {
    const carrier = new Object3D();
    carrier.name = `Carrier-${i + 1}`;
    carrier.position.x = i * pitchMm * MM_TO_M;
    root.add(carrier);
  }
}

function addPath(root: Object3D, lengthM: number): void {
  const path = new Object3D();
  path.name = 'Path-Reference';
  path.userData.realvirtual = {
    Path: {
      type: 'Path',
      version: 1,
      id: 'des-robot-loading-reference-path',
      segments: [{ kind: 'line', from: [0, 0, 0], to: [lengthM, 0, 0] }],
      closed: false,
    },
  };
  root.add(path);
}

/** Build the Internal-tier robot-loading reference scene as virtual nodes. */
export function createRobotLoadingDemoScene(options: RobotLoadingDemoOptions = {}): RobotLoadingDemoScene {
  const palletCount = positiveInteger(options.palletCount ?? 1, 'palletCount');
  const blistersPerPallet = positiveInteger(options.blistersPerPallet ?? 2, 'blistersPerPallet');
  const partsPerBlister = positiveInteger(options.partsPerBlister ?? 4, 'partsPerBlister');
  const masterSeed = options.masterSeed ?? ROBOT_LOADING_REFERENCE_SEED;
  const durationSeconds = positive(
    options.durationSeconds ?? ROBOT_LOADING_REFERENCE_DURATION_SECONDS,
    'durationSeconds',
  );
  const indexSlotCount = Math.max(partsPerBlister, 20);
  const pitchMm = 100;
  const root = new Object3D();
  root.name = 'DES Robot Loading Reference';
  const nodes = new Map<string, Object3D>();

  const add = (node: Object3D): void => {
    root.add(node);
    nodes.set(node.name, node);
  };

  for (let i = 0; i < palletCount; i++) {
    // The neutral node name avoids the legacy public `*Source*` model glob;
    // rv_extras.PalletSource remains the single authoritative binding key.
    const name = `PalletInput-${String(i + 1).padStart(2, '0')}`;
    const source = makeVirtualNode(name, PalletSource.type, {
      PalletTemplateRef: '',
      BlisterTemplateRef: '',
      PartTemplateRef: '',
      BlisterCount: blistersPerPallet,
      PartsPerBlister: partsPerBlister,
      CarrierCapacity: partsPerBlister,
      GridRows: 2,
      GridColumns: Math.ceil(partsPerBlister / 2),
      GridPitch: 40,
      MaxCapacity: 1,
    }, [0, 0, i * 250]);
    addSnap(source, 'OUT-des', [500, 0, 0]);
    add(source);
  }

  const robot = makeVirtualNode('RobotHandling', RobotHandling.type, {
    mode: 'unload',
    batchSize: 1,
    timePerPick: 0,
    timePerCycle: 5,
    pickFilter: 'part',
    removeEmptyCarriers: true,
    maxWaitTime: 0,
  }, [1000, 0, 0]);
  addSnap(robot, 'IN-des', [-500, 0, 0]);
  addSnap(robot, 'OUT-des', [500, 0, 0]);
  addSnap(robot, 'ZP-des-empty', [0, 0, 500]);
  add(robot);

  const indexing = makeVirtualNode('IndexingConveyor', IndexingConveyor.type, {
    slotCount: indexSlotCount,
    pitch: pitchMm,
    speed: 20,
    dwellTime: 0,
    reportFreeAt: partsPerBlister,
  }, [2000, 0, 0]);
  addSnap(indexing, 'IN-des', [-500, 0, 0]);
  addSnap(indexing, 'OUT-des', [500, 0, 0]);
  addIndexingCarriers(indexing, indexSlotCount, pitchMm);
  add(indexing);

  const station = makeVirtualNode('Station', Station.type, {
    ProcessingTime: 0,
    MaxCapacity: 1,
  }, [3000, 0, 0]);
  addSnap(station, 'IN-des', [-500, 0, 0]);
  addSnap(station, 'OUT-des', [500, 0, 0]);
  add(station);

  const processing = makeVirtualNode('ProcessAttachment', Processing.type, {
    targetComponentPath: 'Station',
    processingTime: 0.001,
  }, [3000, 0, 500]);
  add(processing);

  const pathTransport = makeVirtualNode('PathTransport', PathTransport.type, {
    speed: 1_000_000,
    capacity: 4,
  }, [4000, 0, 0]);
  addSnap(pathTransport, 'IN-des', [-500, 0, 0]);
  addSnap(pathTransport, 'OUT-des', [500, 0, 0]);
  addPath(pathTransport, 1);
  add(pathTransport);

  const sink = makeVirtualNode('Sink', 'Sink', {}, [5000, 0, 0]);
  addSnap(sink, 'IN-des', [-500, 0, 0]);
  add(sink);

  const emptyBuffer = makeVirtualNode('EmptyCarrierBuffer', DemoEmptyCarrierRelay.type, {
    MaxCapacity: 1,
  }, [1000, 0, 750]);
  addSnap(emptyBuffer, 'IN-des-empty', [0, 0, -250]);
  addSnap(emptyBuffer, 'OUT-des-empty', [0, 0, 250]);
  add(emptyBuffer);

  const emptySink = makeVirtualNode('EmptyCarrierSink', 'Sink', {}, [1000, 0, 1250]);
  addSnap(emptySink, 'IN-des-empty', [0, 0, -500]);
  add(emptySink);

  const horizon = makeVirtualNode('ReferenceHorizon', DemoHorizon.type, {
    durationSeconds,
  }, [0, 0, -1000]);
  add(horizon);

  const logicalConnections: RobotLoadingLogicalConnection[] = [];
  for (let i = 0; i < palletCount; i++) {
    logicalConnections.push({
      from: `PalletInput-${String(i + 1).padStart(2, '0')}`,
      to: 'RobotHandling',
      port: 'out',
    });
  }
  logicalConnections.push(
    { from: 'RobotHandling', to: 'IndexingConveyor', port: 'out' },
    { from: 'RobotHandling', to: 'EmptyCarrierBuffer', port: 'empty' },
    { from: 'EmptyCarrierBuffer', to: 'EmptyCarrierSink', port: 'out' },
    { from: 'IndexingConveyor', to: 'Station', port: 'out' },
    { from: 'Station', to: 'PathTransport', port: 'out' },
    { from: 'PathTransport', to: 'Sink', port: 'out' },
  );
  (root.userData.realvirtual ??= {}).RobotLoadingDemo = {
    internal: true,
    version: 1,
    logicalConnections,
  };

  const blisters = palletCount * blistersPerPallet;
  const parts = blisters * partsPerBlister;
  return {
    root,
    nodes,
    logicalConnections,
    expected: {
      pallets: palletCount,
      blisters,
      parts,
      totalMUs: palletCount + blisters + parts,
      emptyCarriers: palletCount + blisters,
    },
    masterSeed,
    durationSeconds,
  };
}

function wireLogicalConnections(
  runner: DESRunner,
  connections: readonly RobotLoadingLogicalConnection[],
): void {
  const byName = new Map(runner.liveInstances.map((instance) => [instance.self.root.name, instance]));
  for (const instance of runner.liveInstances) {
    instance.adapter.nextComponents = [];
    instance.adapter.previousComponents = [];
  }
  for (const connection of connections) {
    const from = byName.get(connection.from);
    const to = byName.get(connection.to);
    if (!from || !to) {
      throw new Error(`Robot loading demo: unresolved logical connection ${connection.from} -> ${connection.to}`);
    }
    if (!from.adapter.nextComponents.includes(to.adapter)) from.adapter.nextComponents.push(to.adapter);
    if (!to.adapter.previousComponents.includes(from.adapter)) to.adapter.previousComponents.push(from.adapter);
  }
}

/** Bind and start a fresh DES runner for a programmatic reference scene. */
export function createRobotLoadingDemoRuntime(
  host: BindContextHost,
  options: RobotLoadingDemoOptions = {},
): RobotLoadingDemoRuntime {
  const scene = createRobotLoadingDemoScene(options);
  const runner = new DESRunner({
    subMode: 'animated',
    durationSeconds: scene.durationSeconds,
    masterSeed: scene.masterSeed,
  });
  const boundCount = bindSceneToRunner(runner, scene.root, host);
  wireLogicalConnections(runner, scene.logicalConnections);
  const definitions = [...new Set(runner.liveInstances.map((instance) => instance.def))];
  runner.start(definitions, { root: scene.root, host });
  return { ...scene, runner, boundCount };
}

function instanceByName(runtime: RobotLoadingDemoRuntime, name: string) {
  const instance = runtime.runner.liveInstances.find((candidate) => candidate.self.root.name === name);
  if (!instance) throw new Error(`Robot loading demo: missing bound instance '${name}'`);
  return instance;
}

/** Capture deterministic correctness and end-state KPIs for a completed run. */
export function robotLoadingDemoResult(runtime: RobotLoadingDemoRuntime): RobotLoadingDemoResult {
  const manager = runtime.runner.getManager();
  const statistics = runtime.runner.statistics();
  const componentLoads = Object.fromEntries(
    runtime.runner.liveInstances
      .map((instance) => [instance.self.root.name, instance.adapter.currentLoad] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const generatedPallets = runtime.runner.liveInstances
    .filter((instance) => instance.def.type === PalletSource.type)
    .reduce((sum, instance) => {
      const value = instance.self.prop.generatedPallets;
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);
  return {
    simTime: statistics.simTime,
    masterSeed: runtime.runner.masterSeed,
    generatedPallets,
    createdMUs: manager.muCount,
    liveMUs: Array.from({ length: manager.muCount }, (_, id) => manager.getMU(id)).filter(mu => mu && !mu.retired).length,
    partThroughput: instanceByName(runtime, 'Sink').adapter.getStatistics().totalProcessed,
    emptyCarrierThroughput: instanceByName(runtime, 'EmptyCarrierSink').adapter.getStatistics().totalProcessed,
    throughputPerHour: statistics.throughputPerHour,
    totalEventsProcessed: manager.totalEventsProcessed,
    pendingEvents: manager.pendingEventCount,
    activeReservations: manager.activeReservationCount,
    horizonReached: instanceByName(runtime, 'ReferenceHorizon').self.prop.horizonReached === true,
    componentLoads,
  };
}
