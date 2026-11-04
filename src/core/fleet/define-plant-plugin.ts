// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { PlanningHandle } from '../planning/rv-planning-registry';
import type {
  PendingLiveChange, PlanningDeclaration, PlanningValue, StructuralResetContext,
} from '../planning/rv-planning-params';
import type { StationId } from './core/orders';
import type { PausePlan } from './core/order-sources';
import type { RetrievalRule } from './core/strategies';
import type { LampMap, LampNames } from './exec/lamp-map';
import type { FleetJobRunner } from './exec/job-runner';
import { FleetPlugin, type FleetSceneBinder } from '../../plugins/fleet-plugin';

export const PLANT_PLUGIN_API_VERSION = 1 as const;

export interface PlantPluginDefinition {
  readonly apiVersion: typeof PLANT_PLUGIN_API_VERSION;
  readonly id: string;
  readonly config?: Readonly<{
    takts?: readonly { station: StationId; intervalSec: number; startSec?: number }[];
    /** Repeating shipping cycles, in drop-station order (the existing core contract). */
    pauses?: Readonly<PausePlan>;
    lamps?: Readonly<Partial<LampNames>>;
    [key: string]: unknown;
  }>;
  readonly retrieval?: RetrievalRule;
  readonly lampMap?: Partial<LampMap>;
  readonly parameters?: PlantParameters;
}

/** Session services supplied by the lifecycle owner, never owned by project planning. */
export interface PlantParameterContext {
  readonly root: Object3D;
  readonly viewer: RVViewer;
  readonly planning: PlanningHandle | null;
  readonly runtime: FleetJobRunner | null;
  /** Release the current run BEFORE a component rebuild starts materializing. */
  prepareUnbind(): void;
  reconfigure(config: NonNullable<PlantPluginDefinition['config']>): void;
}

export interface PlantLiveContext extends PlantParameterContext {
  /** Acknowledge the actual simulation instant, as required by PlanningDeclaration.onLive. */
  applied(simTime: number): void;
  /** Deferred changes must check this immediately before changing runtime values. */
  isValid(): boolean;
}

export interface PlantParameters {
  declare(doc: Object3D): PlanningDeclaration | null;
  adoptDocument(doc: Object3D, ctx: PlantParameterContext): void;
  /** Called synchronously after declaration, before waiting for scene readiness. */
  afterDeclare?(ctx: PlantParameterContext): void;
  onLive(values: PendingLiveChange, ctx: PlantLiveContext): void;
  onStructuralReset(
    req: Readonly<Record<string, PlanningValue>>,
    ctx: StructuralResetContext & PlantParameterContext,
  ): Promise<void>;
  dispose(): void;
}

/** Typed identity: retain the project's config and callbacks without copying or registration. */
export function definePlantPlugin<T extends PlantPluginDefinition>(def: T): T { return def; }

/** The existing scriptRef convention: register via viewer.use, remove by plugin id. */
export function plantPluginExports(def: PlantPluginDefinition, binder?: FleetSceneBinder): {
  registerModelPlugins(viewer: RVViewer): void;
  unregisterModelPlugins(viewer: RVViewer): void;
} {
  return {
    registerModelPlugins: viewer => viewer.use(new FleetPlugin(def, binder)),
    unregisterModelPlugins: viewer => viewer.removePlugin(def.id),
  };
}
