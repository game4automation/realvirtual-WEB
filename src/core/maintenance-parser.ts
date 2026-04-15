// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-parser.ts — Parse LogicStep node extras from GLB into
 * MaintenanceProcedure data structures for the maintenance wizard.
 *
 * Handles both combined MaintenanceStep format and composable
 * SerialContainer with sub-steps format. Flattens nested containers
 * so each WaitForUserConfirm or MaintenanceStep becomes one visible
 * wizard step.
 */

import type { Object3D } from 'three';

// ─── Public Types ───────────────────────────────────────────────────────

/** Camera bookmark — position + orbit target for animateCameraTo(). */
export interface CameraBookmark {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
}

/** Completion type for a wizard step. */
export type CompletionType = 'Checkbox' | 'ConfirmWarning' | 'Observation';

/** Severity level for annotation display. */
export type StepSeverity = 'Info' | 'Warning' | 'Error' | 'Success';

/** A single visible wizard step in the maintenance procedure. */
export interface MaintenanceStep {
  /** Step index within the procedure (0-based). */
  index: number;
  /** Step title. */
  title: string;
  /** Detailed instruction text. */
  instruction: string;
  /** Optional safety warning (displayed in red). */
  warningNote: string;
  /** Icon name for the step. */
  icon: string;
  /** Severity level. */
  severity: StepSeverity;
  /** Camera bookmark for this step (null if no camera data). */
  camera: CameraBookmark | null;
  /** Camera animation duration in seconds. */
  cameraDuration: number;
  /** Hierarchy paths of objects to highlight. */
  highlightPaths: string[];
  /** Label for the completion checkbox/button. */
  checkboxLabel: string;
  /** Completion type (Checkbox, ConfirmWarning, Observation). */
  completionType: CompletionType;
  /** Estimated time in minutes for this step (0 = not specified). */
  estimatedMinutes: number;
}

/** Root maintenance procedure parsed from GLB. */
export interface MaintenanceProcedure {
  /** Procedure name (from the SerialContainer node name). */
  name: string;
  /** Total estimated time in minutes (sum of step estimates). */
  estimatedMinutes: number;
  /** Ordered list of wizard steps. */
  steps: MaintenanceStep[];
}

// ─── Camera Position Parsing ────────────────────────────────────────────

/**
 * Parse a CameraPos ScriptableObject's inline data into a CameraBookmark.
 * Handles both direct fields and nested `data` wrapper (SO inline format).
 */
export function parseCameraPos(raw: Record<string, unknown>): CameraBookmark | null {
  // Support ScriptableObject inline format with nested `data` field
  const data = (raw['type'] === 'ScriptableObject' && raw['data'])
    ? raw['data'] as Record<string, unknown>
    : raw;

  const cameraTransformPos = data['CameraTransformPos'] as { x: number; y: number; z: number } | undefined;
  const targetPos = data['TargetPos'] as { x: number; y: number; z: number } | undefined;

  if (!cameraTransformPos && !targetPos) return null;

  // Convert Unity LHS to glTF RHS: negate X
  return {
    px: cameraTransformPos ? -cameraTransformPos.x : 0,
    py: cameraTransformPos?.y ?? 0,
    pz: cameraTransformPos?.z ?? 0,
    tx: targetPos ? -targetPos.x : 0,
    ty: targetPos?.y ?? 0,
    tz: targetPos?.z ?? 0,
  };
}

// ─── Highlight Path Extraction ──────────────────────────────────────────

/**
 * Extract highlight target paths from a HighlightTargets array in GLB extras.
 * Targets are serialized as relative hierarchy path strings or component references.
 */
function parseHighlightTargets(targets: unknown): string[] {
  if (!Array.isArray(targets)) return [];
  const paths: string[] = [];
  for (const t of targets) {
    if (typeof t === 'string' && t.length > 0) {
      paths.push(t);
    } else if (t && typeof t === 'object') {
      // ComponentReference format: { path: "...", component: "..." }
      const ref = t as Record<string, unknown>;
      const path = ref['path'] as string | undefined;
      if (path) paths.push(path);
    }
  }
  return paths;
}

// ─── Completion Type Parsing ────────────────────────────────────────────

function parseCompletionType(raw: unknown): CompletionType {
  if (typeof raw === 'string') {
    if (raw === 'ConfirmWarning' || raw === 'WarningAcknowledge') return 'ConfirmWarning';
    if (raw === 'Observation' || raw === 'Button') return 'Observation';
  }
  return 'Checkbox';
}

function parseSeverity(raw: unknown): StepSeverity {
  if (typeof raw === 'string') {
    if (raw === 'Warning') return 'Warning';
    if (raw === 'Error') return 'Error';
    if (raw === 'Success') return 'Success';
  }
  return 'Info';
}

// ─── Step Extraction from Node Extras ───────────────────────────────────

/**
 * Try to extract a MaintenanceStep from a combined MaintenanceStep component.
 */
function parseMaintenanceStepComponent(
  data: Record<string, unknown>,
  nodeName: string,
  index: number,
): MaintenanceStep {
  const cameraRaw = data['CameraPosition'] as Record<string, unknown> | undefined;
  const camera = cameraRaw ? parseCameraPos(cameraRaw) : null;

  return {
    index,
    title: (data['Title'] as string) || nodeName,
    instruction: (data['Instruction'] as string) || '',
    warningNote: (data['WarningNote'] as string) || '',
    icon: (data['Icon'] as string) || 'build',
    severity: parseSeverity(data['Severity']),
    camera,
    cameraDuration: (data['CameraDuration'] as number) ?? 0.8,
    highlightPaths: parseHighlightTargets(data['HighlightTargets']),
    checkboxLabel: (data['CheckboxLabel'] as string) || 'Done',
    completionType: parseCompletionType(data['CompletionType']),
    estimatedMinutes: (data['EstimatedMinutes'] as number) ?? 0,
  };
}

// ─── Composable Step Flattening ─────────────────────────────────────────

/**
 * Accumulator for composable sub-steps inside a SerialContainer.
 * Each WaitForUserConfirm creates a visible wizard step using the
 * accumulated camera, highlight, and annotation data.
 */
interface StepAccumulator {
  camera: CameraBookmark | null;
  cameraDuration: number;
  highlightPaths: string[];
  title: string;
  instruction: string;
  warningNote: string;
  icon: string;
  severity: StepSeverity;
}

function emptyAccumulator(): StepAccumulator {
  return {
    camera: null,
    cameraDuration: 0.8,
    highlightPaths: [],
    title: '',
    instruction: '',
    warningNote: '',
    icon: 'build',
    severity: 'Info',
  };
}

/**
 * Flatten composable sub-steps within a SerialContainer into wizard steps.
 * Each WaitForUserConfirm or blocking step becomes one visible step,
 * incorporating any preceding SetCameraPosition, Highlight, ShowAnnotation.
 */
function flattenComposableSteps(
  children: { name: string; rv: Record<string, unknown> }[],
  startIndex: number,
): MaintenanceStep[] {
  const steps: MaintenanceStep[] = [];
  let acc = emptyAccumulator();

  for (const child of children) {
    const rv = child.rv;

    // SetCameraPosition component
    if (rv['LogicStep_SetCameraPosition']) {
      const data = rv['LogicStep_SetCameraPosition'] as Record<string, unknown>;
      const cameraRaw = data['CameraPosition'] as Record<string, unknown> | undefined;
      if (cameraRaw) acc.camera = parseCameraPos(cameraRaw);
      acc.cameraDuration = (data['Duration'] as number) ?? 0.8;
    }

    // Highlight component
    if (rv['LogicStep_Highlight']) {
      const data = rv['LogicStep_Highlight'] as Record<string, unknown>;
      const clearPrev = (data['ClearPrevious'] as boolean) ?? true;
      if (clearPrev) acc.highlightPaths = [];
      const targets = parseHighlightTargets(data['Targets']);
      acc.highlightPaths.push(...targets);
    }

    // ShowAnnotation component
    if (rv['LogicStep_ShowAnnotation']) {
      const data = rv['LogicStep_ShowAnnotation'] as Record<string, unknown>;
      acc.title = (data['Title'] as string) || child.name;
      acc.instruction = (data['Instruction'] as string) || '';
      acc.warningNote = (data['WarningNote'] as string) || '';
      acc.icon = (data['Icon'] as string) || 'build';
      acc.severity = parseSeverity(data['Severity']);
    }

    // WaitForUserConfirm — creates a visible wizard step
    if (rv['LogicStep_WaitForUserConfirm']) {
      const data = rv['LogicStep_WaitForUserConfirm'] as Record<string, unknown>;
      steps.push({
        index: startIndex + steps.length,
        title: acc.title || child.name,
        instruction: acc.instruction,
        warningNote: acc.warningNote,
        icon: acc.icon,
        severity: acc.severity,
        camera: acc.camera,
        cameraDuration: acc.cameraDuration,
        highlightPaths: [...acc.highlightPaths],
        checkboxLabel: (data['ButtonLabel'] as string) || 'Done',
        completionType: parseCompletionType(data['ConfirmationType']),
        estimatedMinutes: 0,
      });
      // Reset accumulator for next sub-step group
      acc = emptyAccumulator();
    }

    // MaintenanceStep inside a SerialContainer (combined component as child)
    if (rv['LogicStep_MaintenanceStep']) {
      const data = rv['LogicStep_MaintenanceStep'] as Record<string, unknown>;
      steps.push(parseMaintenanceStepComponent(
        data,
        child.name,
        startIndex + steps.length,
      ));
      acc = emptyAccumulator();
    }
  }

  return steps;
}

// ─── Main Parser ────────────────────────────────────────────────────────

/**
 * Scan a GLB scene tree for maintenance procedures.
 *
 * Looks for SerialContainer nodes whose children contain MaintenanceStep
 * or composable step types. Each qualifying SerialContainer becomes a
 * MaintenanceProcedure.
 *
 * @param root  The GLB scene root Object3D.
 * @returns     Array of parsed maintenance procedures.
 */
export function parseMaintenanceProcedures(root: Object3D): MaintenanceProcedure[] {
  const procedures: MaintenanceProcedure[] = [];

  root.traverse((node: Object3D) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;

    // Look for SerialContainer nodes
    if (!rv['LogicStep_SerialContainer']) return;

    // Check children for maintenance step types
    const childInfos: { name: string; rv: Record<string, unknown> }[] = [];
    let hasMaintenanceContent = false;

    for (const child of node.children) {
      const childRv = child.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!childRv) continue;

      childInfos.push({ name: child.name, rv: childRv });

      // Check if this child or its children have maintenance-related steps
      if (childRv['LogicStep_MaintenanceStep']) {
        hasMaintenanceContent = true;
      }
      if (childRv['LogicStep_SerialContainer']) {
        // Nested SerialContainer — check for composable steps
        for (const grandchild of child.children) {
          const gcRv = grandchild.userData?.realvirtual as Record<string, unknown> | undefined;
          if (!gcRv) continue;
          if (gcRv['LogicStep_WaitForUserConfirm'] || gcRv['LogicStep_MaintenanceStep'] ||
              gcRv['LogicStep_SetCameraPosition'] || gcRv['LogicStep_Highlight'] ||
              gcRv['LogicStep_ShowAnnotation']) {
            hasMaintenanceContent = true;
          }
        }
      }
    }

    if (!hasMaintenanceContent) return;

    // Parse steps
    const steps: MaintenanceStep[] = [];

    for (const childInfo of childInfos) {
      const childRv = childInfo.rv;

      // Direct MaintenanceStep child
      if (childRv['LogicStep_MaintenanceStep']) {
        const data = childRv['LogicStep_MaintenanceStep'] as Record<string, unknown>;
        steps.push(parseMaintenanceStepComponent(data, childInfo.name, steps.length));
        continue;
      }

      // Nested SerialContainer — flatten composable sub-steps
      if (childRv['LogicStep_SerialContainer']) {
        // Find the actual Object3D child to access grandchildren
        const childNode = node.children.find(c => c.name === childInfo.name);
        if (!childNode) continue;

        const grandchildInfos: { name: string; rv: Record<string, unknown> }[] = [];
        for (const gc of childNode.children) {
          const gcRv = gc.userData?.realvirtual as Record<string, unknown> | undefined;
          if (gcRv) grandchildInfos.push({ name: gc.name, rv: gcRv });
        }

        const subSteps = flattenComposableSteps(grandchildInfos, steps.length);
        steps.push(...subSteps);
      }
    }

    if (steps.length === 0) return;

    // Re-index steps sequentially
    for (let i = 0; i < steps.length; i++) {
      steps[i].index = i;
    }

    const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);

    procedures.push({
      name: node.name,
      estimatedMinutes: totalEstimated,
      steps,
    });
  });

  return procedures;
}

/**
 * Convenience: parse a single procedure from mock GLB extras.
 * Used primarily by tests and the maintenance plugin.
 */
export function parseMaintenanceProcedure(
  name: string,
  stepExtras: { name: string; rv: Record<string, unknown> }[],
): MaintenanceProcedure {
  const steps: MaintenanceStep[] = [];

  for (const entry of stepExtras) {
    const rv = entry.rv;

    if (rv['LogicStep_MaintenanceStep']) {
      const data = rv['LogicStep_MaintenanceStep'] as Record<string, unknown>;
      steps.push(parseMaintenanceStepComponent(data, entry.name, steps.length));
    }
  }

  // Re-index
  for (let i = 0; i < steps.length; i++) {
    steps[i].index = i;
  }

  const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);

  return { name, estimatedMinutes: totalEstimated, steps };
}
