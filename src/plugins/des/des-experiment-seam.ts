// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RunIdentity } from './rv-des-run-identity';
import type { RunnerExperimentOperations } from './des-runner';
import type { SimDesControl } from '../../core/material-flow/simulation-kernel';
export const DES_EXPERIMENT_SEAM_VERSION = 1;
export type DesRunnerExperimentHost = RunnerExperimentOperations;
export const EXPERIMENT_METHODS = ["setExperimentStore", "listExperiments", "readManifestJson", "readColumnSeriesJson", "saveSnapshot", "loadSnapshot", "deleteSnapshot", "deleteReplication", "deleteExperiment", "renameExperiment", "exportExperiment", "importExperiment", "estimateStorage", "activeRunInfoJson", "patchExperimentMetaJson", "batchBlockReason", "runExperimentBatch", "runAllExperiments", "cancelBatch", "batchOutcomeJson", "batchProgressJson"] as const;
export type ExperimentBackend = Partial<Pick<SimDesControl, 'listExperiments' | 'readManifestJson' | 'readColumnSeriesJson' | 'saveSnapshot' | 'loadSnapshot' | 'deleteSnapshot' | 'deleteReplication' | 'deleteExperiment' | 'renameExperiment' | 'exportExperiment' | 'importExperiment' | 'estimateStorage' | 'activeRunInfoJson' | 'patchExperimentMetaJson' | 'batchBlockReason' | 'runExperimentBatch' | 'runAllExperiments' | 'cancelBatch' | 'batchOutcomeJson' | 'batchProgressJson'>> & {
  setExperimentStore?(store: unknown): void;
  beforeStart(): void; dispose(): void;
  /** The live end or warm-up was set (clock window, des.setEnd, the scene's DESManager on start). */
  onClockSet?(field: 'end' | 'warmup'): void;
};
type Factory = (host: DesRunnerExperimentHost, identity: RunIdentity) => ExperimentBackend;
let factory: Factory | null = null;
const runners = new Set<{ attach(): void; detach(): void }>();
export function installExperimentBackend(next: Factory): () => void {
  if (factory) throw new Error('Experiment backend already installed');
  factory = next;
  for (const runner of runners) runner.attach();
  return () => {
    if (factory !== next) return;
    factory = null;
    for (const runner of runners) runner.detach();
  };
}
export function registerExperimentRunner(host: DesRunnerExperimentHost, identity: RunIdentity,
  receive: (backend: ExperimentBackend | null) => void): () => void {
  let backend: ExperimentBackend | null = null;
  const entry = {
    attach() { if (!backend && factory) { backend = factory(host, identity); receive(backend); } },
    detach() { const old = backend; backend = null; receive(null); old?.dispose(); },
  };
  runners.add(entry); entry.attach();
  return () => { runners.delete(entry); entry.detach(); };
}

// Experiments window opener (plan-2211 G5/S9): lives in core so startup UI reaches it without
// loading the DES body; re-exported here as part of the experiment seam.
export {
  registerDesExperimentWindowProvider, desExperimentWindowProvider, subscribeDesExperimentWindowProvider,
  type DesExperimentWindowProvider, type DesExperimentWindowState,
} from '../../core/hmi/des-experiment-window';
