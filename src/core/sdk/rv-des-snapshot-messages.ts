// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export const SNAPSHOT_MESSAGES = {
  "des-snapshot-contract": {
    "title": "Invalid snapshot data",
    "text": "The snapshot contains data that cannot be saved or loaded. Check the Problems panel, correct the component or script, then take a new snapshot."
  },
  "des-snapshot-legacy": {
    "title": "Older snapshot format",
    "text": "This snapshot comes from an older format and cannot be converted. Start a new run."
  },
  "des-snapshot-fingerprint": {
    "title": "Model changed",
    "text": "The model changed since this snapshot was taken. Load the original model or start a new run."
  },
  "des-snapshot-unaddressable": {
    "title": "Missing component ID",
    "text": "A component has no stable ID for saving. Assign stable IDs to the affected components, then start a new run."
  },
  "des-snapshot-unsupported-component": {
    "title": "Cannot be saved yet",
    "text": "A PLC program, IK path, replay, playback, smooth-motion drive, unsupported logic step or a gripped part is active. Stop it, or continue without saving."
  },
  "des-snapshot-scripts-pending": {
    "title": "Run still starting",
    "text": "The run is waiting for its scripts to load and has not started its components yet. Wait until the run has started, then save or load the snapshot."
  },
  "des-snapshot-plc-pending": {
    "title": "PLC program still loading",
    "text": "A PLC program is still being deployed. Wait until it has loaded, then save or load the snapshot."
  },
  "des-snapshot-agv-busy": {
    "title": "AGV is busy",
    "text": "An AGV is running a callback and cannot be saved now. Wait for the callback to finish, then try again."
  },
  "des-snapshot-agv-state": {
    "title": "Invalid AGV state",
    "text": "The AGV state is invalid or refers to missing paths or zones. Check the AGV configuration and start a new run."
  },
  "des-snapshot-agv-task-callbacks": {
    "title": "AGV task cannot be saved",
    "text": "An AGV task uses callbacks that cannot be restored. Register a task codec that reattaches them, or start without saving."
  },
  "des-snapshot-authority-busy": {
    "title": "Movement control is busy",
    "text": "Movement control is processing a callback or update. Wait for it to finish, then try saving again."
  },
  "des-snapshot-authority-state": {
    "title": "Invalid movement state",
    "text": "The movement control state is invalid or refers to missing paths. Check the path configuration and start a new run."
  },
  "des-restore-commit-failed": {
    "title": "Snapshot restore failed",
    "text": "The snapshot could not be applied and the simulation was reset. Check the Problems panel and start a new run."
  },
  "des-restore-scene-changed": {
    "title": "Placements changed",
    "text": "Placements were added or removed after the run was bound. Reset the simulation, then take a new snapshot."
  },
  "des-state-not-declared": {
    "title": "Component state not declared",
    "text": "A component has state that is not declared for saving. Declare its persistent state and services, then start a new run."
  },
  "des-script-undeclared-state": {
    "title": "Script state not declared",
    "text": "A script has state that cannot be restored safely. Declare persistent state with self.persist(...), then start a new run."
  },
  "des-plc-not-event-suitable": {
    "title": "PLC program cannot run on events",
    "text": "A PLC program never settles in event-driven DES. Fix the lines marked DES: in the PLC editor."
  },
  "des-batch-logic-unsupported": {
    "title": "Experiments not available",
    "text": "Experiments cannot run on IK paths, smooth-motion drives or logic steps that cannot run on events. The detail names them. Remove them, or run the simulation live."
  },
  "des-fastforward-logic-warning": {
    "title": "Logic timing is not exact",
    "text": "This model has IK paths, smooth-motion drives or logic that cannot run on events. In fast forward and hybrid mode their cycles are counted wrongly. Use animated mode for exact timing."
  },
  "rng-version-unknown": {
    "title": "Unknown random generator version",
    "text": "The random generator version is not supported. Select version 1 or 2 and start a new run."
  },
  "rng-version-conflict": {
    "title": "Random generator version conflict",
    "text": "This experiment is pinned to a different random generator version than the run, snapshot or archive. Use the pinned version, or create a new experiment for the other version."
  },
  "rng-version-unavailable": {
    "title": "Random generator version unavailable",
    "text": "The requested random generator version could not be selected for this batch. Select version 1 or 2, reset the simulation, then start the batch again."
  },
  "rng-version-run-in-progress": {
    "title": "Run in progress",
    "text": "The random generator version cannot change while a run is in progress. Reset the simulation first, then select the version."
  }
} satisfies Record<string, { title: string; text: string }>;

export const SNAPSHOT_PROBLEM_CODES: readonly (keyof typeof SNAPSHOT_MESSAGES)[] = Object.freeze(Object.keys(SNAPSHOT_MESSAGES) as (keyof typeof SNAPSHOT_MESSAGES)[]);

export function snapshotUserMessage(code: unknown): { title: string; text: string } {
  return typeof code === "string" && Object.hasOwn(SNAPSHOT_MESSAGES, code)
    ? SNAPSHOT_MESSAGES[code as keyof typeof SNAPSHOT_MESSAGES]
    : { title: "Snapshot unavailable", text: "The snapshot could not be saved or loaded. See the Problems panel." };
}

export function snapshotRefusalText(error: unknown): string {
  const code = error !== null && (typeof error === "object" || typeof error === "function") && "code" in error ? error.code : undefined;
  return snapshotUserMessage(code).text + " See the Problems panel for details.";
}
