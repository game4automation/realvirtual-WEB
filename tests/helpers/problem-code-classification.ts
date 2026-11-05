// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0a (F16, test 9.12) — the lifecycle of EVERY Problems code.
 *
 * `tests/problems-clear-per-load.node.test.ts` scans `src/` for every code a
 * module reports and fails when one is missing here (or listed here but gone);
 * `tests/problems-clear-per-load.test.ts` proves the `clear-model` class
 * really leaves the panel on `RVViewer.clearModel()` — the step every load
 * starts with.
 *
 * Retire classes:
 *  - `clear-model`    — document-scoped, dropped by code in `RVViewer.clearModel()`.
 *  - `owner-teardown` — document-scoped, retired by its owning subsystem when the
 *                       model goes (plugin `onModelCleared`, `model-cleared`
 *                       listener, component dispose / reset); `retiredBy` names it.
 *  - `next-load`      — document-scoped, retire-then-report: the next load replaces it.
 *  - `known-gap`      — document-scoped by meaning, but NOT retired on a model change
 *                       today. Listed on purpose so the gap is visible; moving a code
 *                       out of here is a fix, adding one needs a reason.
 *  - `not-document`   — survives a model change by design (file, project, app start,
 *                       PLC interface, user action outside the document).
 */
export type ProblemRetireClass = 'clear-model' | 'owner-teardown' | 'next-load' | 'known-gap' | 'not-document';

export interface ProblemCodeClassification {
  readonly retire: ProblemRetireClass;
  /** Who retires it / why it stays — one line, never empty. */
  readonly retiredBy: string;
  /**
   * Set when the code is reported only by a commercial module in the private repository
   * (plan-2211: the DES experiment manager). The scan finds it there when the private
   * sibling is present; a community checkout does not carry the module.
   */
  readonly module?: 'des-experiments' | 'display-wall';
}

export const PROBLEM_CODE_CLASSIFICATION: Readonly<Record<string, ProblemCodeClassification>> = Object.freeze({
  // ─── clear-model ───────────────────────────────────────────────────────
  'logic-gated': { retire: 'clear-model', retiredBy: 'clearLogicGatedProblems()' },
  'logic-instant-loop': { retire: 'clear-model', retiredBy: 'clearLogicGatedProblems() (plan-2207 Phase 3)' },
  'override-orphaned': { retire: 'clear-model', retiredBy: 'clearOverrideOrphanedProblems()' },
  'override-transforms-dropped': { retire: 'clear-model', retiredBy: 'clearOverrideOrphanedProblems() (plan-769 F14)' },
  'nested-transform-refused': { retire: 'clear-model', retiredBy: 'clearOverrideOrphanedProblems() + every bakeIntoGlb() start (plan-769 D11)' },
  'placement-transform-orphaned': { retire: 'clear-model', retiredBy: 'clearOverrideOrphanedProblems() + every bakeIntoGlb() start (plan-769 Phase 7, D23)' },
  'plugin-claim-not-applicable': { retire: 'clear-model', retiredBy: 'clearPluginClaimProblems()' },
  'reference-cycle': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems()' },
  'reference-depth': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems()' },
  'parametric-cycle': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems() (NESTED_REFERENCE_PROBLEM_CODES, plan-650 5b)' },
  'parametric-depth': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems() (NESTED_REFERENCE_PROBLEM_CODES, plan-650 5b)' },
  'parametric-budget': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems() (NESTED_REFERENCE_PROBLEM_CODES, plan-650 5b)' },
  'placement-cap': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems()' },
  'placement-register-failed': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems()' },
  'reference-content-discarded': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems() (plan-774 F11)' },
  'placements-still-loading': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems() + the late settle of the authoring join (plan-774 F3)' },
  'replay-op-skipped': { retire: 'clear-model', retiredBy: 'clearNestedReferenceProblems() — re-reported by the replay after the next load (plan-774 F8)' },
  'reference-target-baked-away': { retire: 'clear-model', retiredBy: 'clearReferenceAuditProblems() + retire-then-report per audit (plan-774 F7)' },
  'kinematic-member-in-placed-content': { retire: 'clear-model', retiredBy: 'clearReferenceAuditProblems() + retire-then-report per audit (plan-774 F7)' },
  'bake-failed': { retire: 'clear-model', retiredBy: 'clearBakeFailedProblems()' },
  'reference-unresolved': { retire: 'clear-model', retiredBy: 'clearReferenceAuditProblems()' },
  'reference-rescued': { retire: 'clear-model', retiredBy: 'clearReferenceAuditProblems()' },
  'reference-ambiguous': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 1a)' },
  'reference-legacy-spelling': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 1a)' },
  'reference-target-synthetic': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 1a)' },
  'id-version-newer': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 1b, 9.19)' },
  'plugin-path-not-found': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 1b, F9)' },
  'plugin-path-guessed': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 1b, F9)' },
  'node-id-duplicate-reminted': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 3a, save writer)' },
  'reference-saved-from-guess': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 3a, F9 on save)' },
  'reference-target-unsaved': { retire: 'clear-model', retiredBy: 'clearReferenceMigrationProblems() (plan-769 3b, F21)' },
  'unresolved-instruction-target': { retire: 'clear-model', retiredBy: 'clearUnresolvedInstructionTargetProblems() (plan-769 0a)' },
  'signal-name-collision': { retire: 'clear-model', retiredBy: 'clearSignalNameCollisionProblems() (end of clearModel, plan-559 2b)' },
  'instance-signal-collision': { retire: 'clear-model', retiredBy: 'clearInstanceSignalCollisionProblems() (end of clearModel)' },
  'path-id-collision': { retire: 'clear-model', retiredBy: 'resetPathIdCollisions() (end of clearModel)' },
  'web-operator-panel-config': { retire: 'clear-model', retiredBy: 'webOperatorPanels.clear() inside clearModel' },
  // Robot IK diagnostics: statements about the rig in THIS document.
  'robot-ik-axes-unresolved': { retire: 'clear-model', retiredBy: 'clearIkProblems() inside clearModel' },
  'robot-ik-chain-unresolved': { retire: 'clear-model', retiredBy: 'clearIkProblems() inside clearModel' },
  'robot-ik-tcp-unresolved': { retire: 'clear-model', retiredBy: 'clearIkProblems() inside clearModel' },
  'robot-ik-opw-unusable': { retire: 'clear-model', retiredBy: 'clearIkProblems() inside clearModel' },
  'robot-ik-wrist-type-missing': { retire: 'clear-model', retiredBy: 'clearIkProblems() inside clearModel' },
  'robot-ik-target-no-angles': { retire: 'clear-model', retiredBy: 'clearIkProblems() inside clearModel' },
  // plan-673 Phase 4: the MJCF writer's findings describe the physics document
  // of THIS model. The writer is private and pure; `rv-mjcf-problems.ts` is the
  // public vocabulary it reports through, which is also what puts these codes in
  // front of this test (the scan only sees the public src/).
  'mjcf-mass-degraded': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-body-no-mass': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-axis-no-force-limit': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-shape-degenerate': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-joint-unparented': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-joint-unsupported': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-scaled-frame': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-body-no-geometry': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-mesh-convexified': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-geom-no-profile': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-profile-priority-not-applied': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-gear-unresolved': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  'mjcf-region-disabled': { retire: 'clear-model', retiredBy: 'clearMjcfProblems() inside clearModel (plan-673 Phase 4)' },
  // plan-673 Phase 4 — the axis contract and the overload model.
  'axis-role-conflict': { retire: 'clear-model', retiredBy: 'clearAxisRoleProblems() via AxisDiagnosticsManager.clear() inside clearModel' },
  'axis-overload': { retire: 'clear-model', retiredBy: 'AxisDiagnosticsManager.clear() inside clearModel' },
  'grip-slip': { retire: 'clear-model', retiredBy: 'AxisDiagnosticsManager.clear() inside clearModel' },
  // plan-2022: drop detection is scene-wide (one authority node); a second component on the
  // scene is a visible authoring problem, dropped with the rest of the registry on model change.
  'drop-detection-duplicate': { retire: 'clear-model', retiredBy: 'dropManager.clear() inside clearModel' },

  // ─── owner-teardown ────────────────────────────────────────────────────
  'collision-authored-overlap': { retire: 'owner-teardown', retiredBy: 'CollisionManager.clear() (called from RVViewer.clearModel) runs clearCollisionOverlapProblems; an empty pair list clears the entry (plan-781)' },
  'collision-start-overlap': { retire: 'owner-teardown', retiredBy: 'CollisionManager.clear() (called from RVViewer.clearModel) runs clearCollisionOverlapProblems; an empty pair list clears the entry (plan-781)' },
  'signal-binding-unresolved': { retire: 'owner-teardown', retiredBy: 'SignalBindingManager retires the entries of an element on every applyMappings (retire-then-report), unbindAll and dispose() — clearModel disposes the manager (contract-node-identity R4/R10)' },
  'wall-tracking-prefix-ignored': { retire: 'owner-teardown', retiredBy: 'RVDisplayWall.dispose() clears its entry; every reapplyConfig retires or re-reports it (plan-2233 F8)', module: 'display-wall' },
  'signal-connector-unresolved': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'signal-connector-slot-mismatch': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'signal-connector-direction': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'signal-connector-fan-in': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'signal-connector-cycle': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'signal-connector-width': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'signal-connector-nonfinite': { retire: 'owner-teardown', retiredBy: 'RVSignalConnector.dispose() → SignalConnectorNetwork.remove() clears every code of that connector (plan-2227); the network re-checks on every config change' },
  'des-scripts-unavailable': { retire: 'owner-teardown', retiredBy: 'plan-2212 Phase 3: WebComponentPlugin.onModelCleared/onModelLoaded and a successful QuickJS wiring; DESRunner also clears it on every script bind and re-reports a wiring failure' },
  'des-script-sink-unresolved': { retire: 'owner-teardown', retiredBy: 'plan-2212 Phase 2: the script instance teardown (every DES rebuild / unbind / reload) and WebComponentPlugin.onModelCleared/onModelLoaded' },
  'des-script-sink-runtime': { retire: 'owner-teardown', retiredBy: 'plan-2212 Phase 2: the script instance teardown (every DES rebuild / unbind / reload) and WebComponentPlugin.onModelCleared/onModelLoaded' },
  'path-successor-mismatch': { retire: 'owner-teardown', retiredBy: "PathTopologyCheck.reset() on 'model-cleared'" },
  'path-end-near-miss': { retire: 'owner-teardown', retiredBy: "PathTopologyCheck.reset() on 'model-cleared'" },
  'unit-mismatch': { retire: 'owner-teardown', retiredBy: 'SignalBindPlugin.onModelCleared → clearUnitProblems()' },
  'unit-unknown': { retire: 'owner-teardown', retiredBy: 'SignalBindPlugin.onModelCleared → clearUnitProblems()' },
  'unit-scale-conflict': { retire: 'owner-teardown', retiredBy: 'SignalBindPlugin.onModelCleared → clearUnitProblems()' },
  'unit-scale-not-effective': { retire: 'owner-teardown', retiredBy: 'SignalBindPlugin.onModelCleared → clearUnitProblems()' },
  'unit-scale-not-applied': { retire: 'owner-teardown', retiredBy: 'SignalBindPlugin.onModelCleared → clearUnitProblems()' },
  'grip-seat-occupied': { retire: 'owner-teardown', retiredBy: 'RVGrip reset → clearSeatOccupiedProblems()' },
  'fmu-not-runnable': { retire: 'owner-teardown', retiredBy: 'RVFmu dispose → clearFmuProblems(instanceKey)' },
  'fmu-variable-unsupported': { retire: 'owner-teardown', retiredBy: 'RVFmu dispose → clearFmuProblems(instanceKey)' },
  'fmu-unsupported': { retire: 'owner-teardown', retiredBy: 'RVFmu dispose → clearFmuProblems(instanceKey)' },
  'fmu-metadata-drift': { retire: 'owner-teardown', retiredBy: 'RVFmu dispose → clearFmuProblems(instanceKey)' },
  'fmu-error': { retire: 'owner-teardown', retiredBy: 'RVFmu dispose → clearFmuProblems(instanceKey)' },
  'fmu-override-orphaned': { retire: 'owner-teardown', retiredBy: 'RVFmu dispose → clearFmuProblems(instanceKey)' },
  'fleet-id-collision': { retire: 'owner-teardown', retiredBy: 'AgvFleet unregister / reset' },
  // plan-2019 — the Sound component clears both on re-resolve and in dispose().
  'sound-without-drive': { retire: 'owner-teardown', retiredBy: 'RVSound re-resolve / dispose()' },
  'sound-variant-mismatch': { retire: 'owner-teardown', retiredBy: 'RVSound re-resolve / dispose()' },
  'sensor-chain-infeasible': { retire: 'owner-teardown', retiredBy: 'MovementAuthority.forgetSensorProblem() — on every sensor-limit change, unregister, clear() and newEpoch() (plan-664 R4)' },
  'fleet-wait-timeout': { retire: 'owner-teardown', retiredBy: 'WaitWatch.reset()' },
  'fleet-task-hijacked': { retire: 'owner-teardown', retiredBy: 'FleetJobRunner.start() (reset / rebind) clears it' },
  'agv-merge-check-skipped': { retire: 'owner-teardown', retiredBy: 'Agv teardown: last vehicle gone' },
  'agv-merge-entry-too-short': { retire: 'owner-teardown', retiredBy: 'Agv teardown: last vehicle gone' },
  'agv-merge-without-zone': { retire: 'owner-teardown', retiredBy: 'Agv merge-zone check re-run' },
  // plan-628 live path-network validation (planner mode): the publisher drops its entries.
  'path-open-end': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear()' },
  'path-unreachable-start': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear()' },
  'path-link-gap': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear()' },
  'path-kink': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear() (plan-628 8.3)' },
  'path-radius-too-tight': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear() (plan-628 8.11g)' },
  'path-dangling-successor': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear()' },
  'path-dock-misaligned': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear() (same publisher as path-open-end)' },
  'path-dock-stub-missing': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear() (same publisher as path-open-end)' },
  'path-block-transform-not-identity': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear()' },
  'path-merge-zones-too-close': { retire: 'owner-teardown', retiredBy: 'PathVisualizerPlugin.onModelCleared → PathNetworkLiveValidation.clear()' },
  // plan-630 Phase 2: the PlanningRegistry is pure and reports these; its viewer
  // owner is PlanningParametersPlugin, which retires all five when the document goes.
  'planning-declaration-invalid': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() (plan-630 Phase 2)' },
  'planning-param-orphaned': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() (plan-630 Phase 2)' },
  'planning-scenario-value-invalid': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() (plan-630 Phase 2)' },
  'planning-scenario-block-invalid': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() (plan-630 Phase 3)' },
  'planning-apply-failed': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared(); also cleared by the next successful apply (plan-630 Phase 2)' },
  'planning-apply-rollback-failed': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() (plan-630 Phase 2)' },
  'planning-committed-recovered': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared(); also cleared on owner retire and the next successful apply (plan-681 F2/F5)' },
  'planning-committed-recovery-failed': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared(); also cleared on owner retire and the next successful apply (plan-681 F2/F5)' },
  'param-apply-rollback-failed': { retire: 'owner-teardown', retiredBy: 'VariantsRuntime.unbindDocument() on every document change; also cleared by the next successful rollback (plan-2013 Phase 1)' },
  'variant-target-missing': { retire: 'owner-teardown', retiredBy: 'VariantsRuntime.unbindDocument() + every activation (plan-2013 Phase 1)' },
  'variant-apply-warning': { retire: 'owner-teardown', retiredBy: 'VariantsRuntime.unbindDocument() (plan-2013 Phase 1)' },
  'variants-block-invalid': { retire: 'owner-teardown', retiredBy: 'VariantsRuntime.unbindDocument() before the next block is read (plan-2013 Phase 1)' },
  'planning-selection-invalid': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() + ComponentParamsOwner.newDocument() (plan-630 Phase 8)' },
  'planning-selection-unsupported': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared() + ComponentParamsOwner.newDocument() (plan-630 Phase 8)' },
  'experiment-restore-failed': { retire: 'owner-teardown', retiredBy: 'PlanningParametersPlugin.onModelCleared(); also cleared by the next successful batch restore (plan-2005 Phase 7)', module: 'des-experiments' },
  'variant-scope-failed': { retire: 'owner-teardown', retiredBy: 'VariantsRuntime.unbindDocument() (DOCUMENT_PROBLEMS, plan-2013 V1-A)' },

  // plan-522 Phase 7a: maintenance trigger diagnostics of THIS document's procedures.
  'maintenance-trigger-invalid': { retire: 'owner-teardown', retiredBy: 'MaintenancePlugin.onModelCleared → MaintenanceTriggerHost.clear() (plan-522 7a)' },
  'maintenance-trigger-unresolved': { retire: 'owner-teardown', retiredBy: 'MaintenancePlugin.onModelCleared → MaintenanceTriggerHost.clear() (plan-522 7a)' },
  'maintenance-trigger-type': { retire: 'owner-teardown', retiredBy: 'MaintenancePlugin.onModelCleared → MaintenanceTriggerHost.clear() (plan-522 7a)' },
  'maintenance-output-external': { retire: 'owner-teardown', retiredBy: 'MaintenancePlugin.onModelCleared → MaintenanceTriggerHost.clear() (plan-522 7a)' },
  'maintenance-in-placement-unsupported': { retire: 'owner-teardown', retiredBy: 'MaintenancePlugin.onModelCleared → MaintenanceTriggerHost.clear() (plan-522 7a)' },

  // plan-2005: the DES runner is disposed with the model (clearModel → SimulationKernel.dispose()).
  'des-action-failed': { retire: 'owner-teardown', retiredBy: 'DESRunner.dispose() via SimulationKernel.dispose() in RVViewer.clearModel() (plan-2005)' },
  'des-legacy-component': { retire: 'owner-teardown', retiredBy: 'DESRunner.dispose() → clearSceneBindingProblems() via SimulationKernel.dispose() in RVViewer.clearModel(); also at every bindSceneToRunner() (plan-2005)' },
  'des-invalid-capacity': { retire: 'owner-teardown', retiredBy: 'DESRunner.dispose() → clearSceneBindingProblems() via SimulationKernel.dispose() in RVViewer.clearModel(); also at every bindSceneToRunner() (plan-2005)' },
  // plan-2207 Phase 1: both belong to one DES run of this model.
  'des-tick-ownership-conflict': { retire: 'owner-teardown', retiredBy: 'DESRunner._clearTickOwnership() on rebind/reset/clearMUs and DESRunner.dispose() via SimulationKernel.dispose() in RVViewer.clearModel() (plan-2207)' },
  'des-settle-overflow': { retire: 'owner-teardown', retiredBy: 'SettleController.reset()/dispose() (DESRunner reset and dispose via SimulationKernel.dispose() in RVViewer.clearModel(), plan-2207)' },
  'des-logic-not-event-suitable': { retire: 'owner-teardown', retiredBy: 'DESRunner._detachLogicOwner() on re-register/reset/clearMUs/dispose (SimulationKernel.dispose() in RVViewer.clearModel(), plan-2207 Phase 3)' },
  'des-plc-not-event-suitable': { retire: 'owner-teardown', retiredBy: 'DESRunner unsuitable-problem teardown on reset/clearMUs/dispose (SimulationKernel.dispose() in RVViewer.clearModel(), plan-2207 Phase 5b)' },
  'des-logic-poll-hint': { retire: 'owner-teardown', retiredBy: 'DESRunner._detachLogicOwner() on re-register/reset/clearMUs/dispose (SimulationKernel.dispose() in RVViewer.clearModel(), plan-2207 Phase 3)' },
  'des-zero-time-pulse': { retire: 'owner-teardown', retiredBy: 'DESRunner.clearMUs() and DESRunner.dispose() call offPulseWatch() beside offButtonBlocker; _bindEventOwners() detaches before rebinding (plan-2207 Phase 4)' },
  'muswitcher-no-sensor': { retire: 'owner-teardown', retiredBy: 'MUSwitcher.dispose()' },

  // ─── next-load ─────────────────────────────────────────────────────────
  'blockage-deadlock': { retire: 'clear-model', retiredBy: 'clearBlockageProblems()' },
  'blockage-stall': { retire: 'clear-model', retiredBy: 'clearBlockageProblems()' },
  'blockage-coverage-gap': { retire: 'clear-model', retiredBy: 'clearBlockageProblems()' },
  'missing-reference': { retire: 'next-load', retiredBy: 'loadGLB → reportMissingReferences() retire-then-report' },
  'memory-budget': { retire: 'next-load', retiredBy: 'reportLoadMemoryBudget() at every GLB parse' },
  // plan-559 Phase 8: definePlantPlugin's own version guard, re-evaluated at every FleetPlugin
  // construction (one per model load of a plant-plugin project).
  'plant-plugin-api-version': { retire: 'next-load', retiredBy: 'FleetPlugin constructor retire-then-report' },

  // ─── known-gap (document-scoped, not retired on a model change today) ──
  'source-pose-unsupported': { retire: 'known-gap', retiredBy: 'Source behaviour reports once per source; nothing retires it' },
  'transfer-pose-off-belt': { retire: 'known-gap', retiredBy: 'Conveyor clears only on the next successful accept' },
  // plan-680: the DES runner moved into src/ — its codes became visible to this scan.
  'des-component-disabled': { retire: 'known-gap', retiredBy: 'DESRunner clears the code on every DES start and re-reports (plugins/des/des-runner.ts); not on a model change' },
  // plan-680: the PalletYard model plugin moved into src/ (public demo) — its codes became visible to this scan.
  'pallet-yard-spawn-missing': { retire: 'known-gap', retiredBy: 'PalletYard continuous backend reports per bind; cleared by its next successful bind' },
  'pallet-yard-no-active-agv': { retire: 'known-gap', retiredBy: 'PalletYard clears it on the next bind with an active vehicle' },
  'pallet-yard-bind-incomplete': { retire: 'known-gap', retiredBy: 'PalletYard plugin clears it on the next successful bind' },
  'pallet-yard-snapshot-unsupported': { retire: 'known-gap', retiredBy: 'PalletYard plugin reports when a DES snapshot is requested; not on a model change' },
  // plan-559 Phase 8: FleetPlugin's generic fallback for a project binder that does not supply
  // its own reportBindGap/reportSnapshot hook (PalletYard's own, more specific pallet-yard-*
  // codes above take precedence for that project; these are the default for any other project).
  'fleet-bind-incomplete': { retire: 'known-gap', retiredBy: 'FleetPlugin clears it on the next successful bind' },
  'fleet-snapshot-unsupported': { retire: 'known-gap', retiredBy: 'FleetPlugin reports when a DES snapshot is requested; not on a model change' },
  'des-restore-scene-changed': { retire: 'known-gap', retiredBy: 'DESRunner clears it after the next successful bind (plugins/des/des-runner.ts); not on a model change' },
  'des-snapshot-fingerprint': { retire: 'known-gap', retiredBy: 'plan-2059 3a: raised when a snapshot/restore is refused (plugins/des/des-runner.ts); not retired on a model change' },
  'des-restore-commit-failed': { retire: 'known-gap', retiredBy: 'plan-2059 3a: raised when a restore commit fails (plugins/des/des-runner.ts); not retired on a model change' },
  'agv-reverse-stub-refused': { retire: 'known-gap', retiredBy: 'Agv runtime finding; no clear' },
  'agv-service-stop-missed-no-return': { retire: 'known-gap', retiredBy: 'Agv runtime finding; no clear' },
  'agv-turn-point-overshoot': { retire: 'known-gap', retiredBy: 'Agv runtime finding; no clear' },
  'placement-name-collision': { retire: 'known-gap', retiredBy: 'layout-planner scene mutation; no clear' },
  'library-scope-placement': { retire: 'known-gap', retiredBy: 'plan-780: layout-planner warns about a placement in the edited library document; neither onModelCleared nor dispose clears it' },
  'placement-name-empty': { retire: 'known-gap', retiredBy: 'scene GLB bake (save); no clear' },
  'aasx-import-refused': { retire: 'known-gap', retiredBy: 'AAS link field: cleared on the next attempt only' },
  'fmu-attach-refused': { retire: 'known-gap', retiredBy: 'FMU attach action: cleared on the next attempt only' },
  'parametric-manual-attach': { retire: 'known-gap', retiredBy: 'asset-editor addComponent refusal under a generated variant; no clear' },
  'parametric-regenerate-failed': { retire: 'known-gap', retiredBy: 'regenerateParametric: cleared on the next successful / unchanged regenerate only' },
  'parametric-child-missing': { retire: 'known-gap', retiredBy: 'placeMissingPlacement (load) + share export/import (plan-650 5b); no clear' },
  'feature-late-component': { retire: 'known-gap', retiredBy: 'FeatureLoader deferred-component handler, once per type per session; no clear (plan-652 3)' },
  'mu-owner-conflict': { retire: 'known-gap', retiredBy: 'setMuOwner (rv-mu-owner.ts) runtime finding, once per MU name; no clear (plan-661 P1)' },
  'policy-axis-not-a-reference': { retire: 'known-gap', retiredBy: "RVLocomotionPolicyComponent reports it in init/reapplyConfig; neither dispose() nor clearAll() clears it, so it survives a model change (plan-673 Phase 2, found by this test in Phase 3)" },
  'merge-uv-missing': { retire: 'known-gap', retiredBy: 'asset-editor mergeMesh → reportMergeUVGaps() warning per merge; no clear (plan-675)' },
  'roller-spin-unbound': { retire: 'known-gap', retiredBy: 'bindRollerSpin() retire-then-report per surface path only; binding dispose() / uninstall does not clear it (plan-675)' },
  'roller-spin-mixed': { retire: 'known-gap', retiredBy: 'bindRollerSpin() retire-then-report per surface path only; binding dispose() / uninstall does not clear it (plan-675)' },
  'roller-spin-under-surface': { retire: 'known-gap', retiredBy: 'bindRollerSpin() retire-then-report per surface path only; binding dispose() / uninstall does not clear it (plan-675)' },

  // ─── not-document ──────────────────────────────────────────────────────
  // plan-2013 V1: experiment columns, recovery snapshots and run series live in the project's experiment store (IndexedDB), keyed by model + experiment — not by the loaded document.
  'experiment-legacy-factors': { retire: 'not-document', retiredBy: 'project experiment store; re-reported per model + project on scope resolution, matrix sync and project-file sync while legacy factor columns remain (plan-2211 G7)', module: 'des-experiments' },
  'experiment-migration-conflict': { retire: 'not-document', retiredBy: 'project experiment store; re-reported per model + experiment on the next variant recovery', module: 'des-experiments' },
  'experiment-variant-restored': { retire: 'not-document', retiredBy: 'project experiment store; informational, per model + experiment on bind / matrix open', module: 'des-experiments' },
  'experiment-snapshot-failed': { retire: 'not-document', retiredBy: 'recovery copy in the project experiment store; the next successful snapshot write' },
  'des-series-store-failed': { retire: 'not-document', retiredBy: 'run series store (rv-des-series IndexedDB)', module: 'des-experiments' },
  'des-series-unavailable': { retire: 'not-document', retiredBy: 'run series store (rv-des-series IndexedDB)', module: 'des-experiments' },
  'des-series-truncated': { retire: 'not-document', retiredBy: 'describes one archived run record in the series store', module: 'des-experiments' },
  'experiment-project-conflict': { retire: 'not-document', retiredBy: 'project-folder experiment archive (des-experiment-project-file); re-reported per document on the next import', module: 'des-experiments' },
  'experiment-project-write': { retire: 'not-document', retiredBy: 'project-folder experiment archive (des-experiment-project-file); the next successful save', module: 'des-experiments' },
  'experiment-project-save': { retire: 'not-document', retiredBy: 'project-folder experiment archive (des-experiment-project-file); the next successful save', module: 'des-experiments' },
  'experiment-project-open': { retire: 'not-document', retiredBy: 'project-folder experiment archive (des-experiment-project-file); the next successful open', module: 'des-experiments' },
  'experiment-project-read': { retire: 'not-document', retiredBy: 'project-folder experiment archive (des-experiment-project-file); the next successful open', module: 'des-experiments' },
  'des-batch-logic-unsupported': { retire: 'known-gap', retiredBy: 'plan-2062: cleared by the next batch start on a model without logic (des-batch-runner); not retired on a model change' },
  'des-fastforward-logic-warning': { retire: 'known-gap', retiredBy: 'plan-2062: cleared when DES leaves fast-forward/hybrid (des-runner setSubMode); not retired on a model change' },
  // plan-778: the saved library file is fine; only B's manifest row is stale. Retired by a successful row refresh (Retry action) — a library project is not the loaded document.
  'library-row-stale': { retire: 'not-document', retiredBy: 'library project manifest row; the Retry action (library.refreshDocumentRow) or the next successful save of that document retires it' },
  'save-reference-loss': { retire: 'not-document', retiredBy: 'describes a written FILE; the next save of that document retires it' },
  'reference-not-upgraded': { retire: 'not-document', retiredBy: 'plan-780 R4a: describes a legacy reference preserved in a written file; survives model changes, no explicit clear today' },
  'duplicate-asset-id': { retire: 'not-document', retiredBy: 'project manifest scope (reportDocumentIdCollisions)' },
  'library-unavailable': { retire: 'not-document', retiredBy: 'project scope: installLibraryAvailability mirrors the library-project loader — cleared when the library is ready or the project is closed / switched (plan-778)' },
  'library-reference-update': { retire: 'not-document', retiredBy: 'project scope: installLibraryReferenceUpdate mirrors the open project — cleared when the reference is migrated (Update) or the project is closed / switched (plan-778 Decision B)' },
  'aasx-duplicate-id': { retire: 'not-document', retiredBy: 'project AASX index' },
  'aasx-unreadable': { retire: 'not-document', retiredBy: 'project AASX index' },
  'hosted-start-failed': { retire: 'not-document', retiredBy: 'app start (main.ts)' },
  'hosted-start-unresolved': { retire: 'not-document', retiredBy: 'app start (main.ts)' },
  // Same call site as hosted-start-unresolved (main.ts), just the deep-link id variant.
  'projecturl-start-unresolved': { retire: 'not-document', retiredBy: 'app start (main.ts)' },
  'macro-step-failed': { retire: 'not-document', retiredBy: 'MCP macro run' },
  'signal-reconcile': { retire: 'not-document', retiredBy: 'per PLC interface (connect-plugin)' },
  'signal-rename-inconsistent': { retire: 'not-document', retiredBy: 'CONNECT rename journal' },
  'tween-handle-exhausted': { retire: 'not-document', retiredBy: 'TweenRegistry pool capacity (app-wide, fatal); no document owns it' },
  'feature-load-failed': { retire: 'not-document', retiredBy: 'FeatureLoader: app-level feature activation; cleared on a successful retry' },
  // plan-2022 Phase 0: a stable, non-document id for the whole HMI React root; never cleared —
  // it is the historical record that the UI crashed once this session, until a manual rebuild.
  'hmi-root-crash': { retire: 'not-document', retiredBy: 'RootErrorBoundary.componentDidCatch(); no clear, by design' },
  'feature-stale-build': { retire: 'not-document', retiredBy: 'vite:preloadError handler: a newer deploy; the reload retires it' },
});

/** `true` when the code describes the loaded document (every class except `not-document`). */
export function isDocumentScoped(code: string): boolean {
  const c = PROBLEM_CODE_CLASSIFICATION[code];
  return c !== undefined && c.retire !== 'not-document';
}

/** Codes of one retire class, sorted. */
export function codesOf(retire: ProblemRetireClass): string[] {
  return Object.entries(PROBLEM_CODE_CLASSIFICATION)
    .filter(([, c]) => c.retire === retire)
    .map(([code]) => code)
    .sort();
}
