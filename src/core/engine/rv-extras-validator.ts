// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-extras-validator.ts — Dev-mode GLB extras parity validator.
 *
 * Logs warnings for GLB extras fields that are present in the data
 * but not consumed or explicitly ignored by the TypeScript parsers.
 * This catches C#→TypeScript drift when new fields are added to Unity components.
 *
 * Only active in dev mode (import.meta.env.DEV). Zero overhead in production.
 *
 * Component types with registered schemas (Drive, TransportSurface, Sensor, Source,
 * Sink, Grip, GripTarget, ConnectSignal) auto-derive their CONSUMED fields from the
 * schema keys + aliases. Manual entries are only needed for non-schema components.
 *
 * Usage:
 *   validateExtras('Drive', driveData);
 *   // Logs: [Parity] Unhandled Drive field: "SpeedOverride" (value: 0)
 */

import { getConsumedFieldsFromSchema, getRegisteredCapabilities } from './rv-component-registry';

/**
 * Fields consumed by each TypeScript parser (actively read and used).
 *
 * For schema-based components, the CONSUMED list is auto-derived from the schema.
 * Manual entries below are for additional fields consumed outside the schema
 * (e.g., DriveReference in TransportSurface loader, legacy aliases in Source).
 * Non-schema components (signals, recorders, LogicSteps, etc.) are fully manual.
 */
const CONSUMED: Record<string, string[]> = {
  // Schema-based components: additional fields consumed outside schema
  // (schema fields are auto-merged at validation time)
  Drive: [],      // all fields in RVDrive.schema
  TransportSurface: ['DriveReference'],  // consumed by loader, not in schema
  Sensor: ['Mode'],  // Mode handled in init() (legacy → UseRaycast conversion)
  Source: ['Spawn', 'SpawnInterval', 'SpawnDistance'],  // legacy aliases consumed by computeSpawnConfig
  Sink: [],       // all fields in RVSink.schema (empty)
  Grip: [],       // all fields in RVGrip.schema
  GripTarget: [], // all fields in RVGripTarget.schema
  ConnectSignal: [], // all fields in RVConnectSignal.schema

  // Drive behaviors — schema fields auto-derived
  Drive_Simple: [],       // all fields in RVDriveSimple.schema
  Drive_Cylinder: [],     // all fields in RVDriveCylinder.schema
  Drive_ErraticPosition: [], // all fields in RVErraticDriver.schema

  // LayoutObject — layout planner marker component
  LayoutObject: ['Label', 'CatalogId', 'Locked'],

  // AASLink — Asset Administration Shell link (parsed by aas-link-plugin)
  AASLink: ['AASId', 'Description', 'ServerUrl'],

  // MU — no extras parsed yet (template nodes only)
  MU: [],

  // BoxCollider — used by createAABBFromExtras()
  BoxCollider: ['center', 'size'],

  // Signal types — connection-relevant fields editable, Status read-only (object)
  PLCOutputBool: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active'],
  PLCInputBool: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active'],
  PLCOutputFloat: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active'],
  PLCInputFloat: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active'],
  PLCOutputInt: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active'],
  PLCInputInt: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active'],

  // DrivesRecorder — recorder settings parsing
  DrivesRecorder: [
    'PlayOnStart', 'ReplayStartFrame', 'ReplayEndFrame', 'Loop',
    'DrivesRecording',  // ScriptableObject reference
    'Active',           // ActiveOnly — controls playback in Connected/Disconnected mode
  ],

  // DrivesRecording_compact — parsed by parseCompactRecording()
  DrivesRecording_compact: [
    'fixedDeltaTime', 'numberFrames', 'driveCount', 'drives', 'positions', 'sequences',
  ],

  // ReplayRecording — parsed in the traverse loop
  ReplayRecording: [
    'Sequence', 'StartOnSignal', 'IsReplayingSignal',
    'Active',  // ActiveOnly — controls replay in Connected/Disconnected mode
  ],

  // LogicStep types — parsed by RVLogicEngine.build()
  LogicStep_SerialContainer: ['Active'],  // container, Active parsed for top-level guard
  LogicStep_ParallelContainer: ['Active'],
  LogicStep_SetSignalBool: ['Signal', 'SetToTrue', 'Active'],
  LogicStep_WaitForSensor: ['Sensor', 'WaitForOccupied', 'Active'],
  LogicStep_WaitForSignalBool: ['Signal', 'WaitForTrue', 'Active'],
  LogicStep_Delay: ['Duration', 'Active'],
  LogicStep_DriveToPosition: ['drive', 'Destination', 'Relative', 'Direction', 'Active'],
  LogicStep_DriveTo: ['drive', 'Destination', 'Relative', 'Direction', 'Active'],
  LogicStep_SetDriveSpeed: ['drive', 'Speed', 'Active'],
  LogicStep_Enable: ['Target', 'Enable', 'Active'],
  LogicStep_Pause: ['Active'],  // debugging breakpoint, no other fields consumed
  LogicStep_StartDriveTo: ['drive', 'Destination', 'Relative', 'Direction', 'Active'],
  LogicStep_StartDriveSpeed: ['drive', 'Speed', 'Active'],
  LogicStep_WaitForDrivesAtTarget: ['Drives', 'Active'],
  LogicStep_SetSignalFloat: ['Signal', 'Value', 'Active'],
  LogicStep_WaitForSignalFloat: ['Signal', 'Comparison', 'Value', 'Tolerance', 'Active'],
  LogicStep_GripPick: ['Grip', 'Blocking', 'Active'],
  LogicStep_GripPlace: ['Grip', 'Blocking', 'Active'],
  LogicStep_JumpOnSignal: ['Signal', 'JumpOn', 'JumpToStep', 'Active'],
  LogicStep_SetActiveOnly: ['Active'],
  LogicStep_CinemachineCamera: ['Active'],
  LogicStep_StatStartCycle: ['Active'],
  LogicStep_StatEndCycle: ['Active'],
  LogicStep_StatState: ['Active'],
  LogicStep_StatOutput: ['Active'],

  // RuntimeMetadata — parsed by scene loader for tooltip content
  RuntimeMetadata: ['content'],

  // Group — parsed by loadGLB group parsing
  Group: ['GroupName', 'GroupNamePrefix'],

  // Pipeline components — parsed by loadGLB pipeline parsing
  Pipe: ['resourceName', 'flowRate', 'source', 'destination', 'uvDirection'],
  ResourceTank: ['resourceName', 'capacity', 'amount', 'pressure', 'temperature'],
  Pump: ['flowRate', 'pipe'],
  ProcessingUnit: ['connections'],
};

/**
 * Fields intentionally ignored — present in GLB but not needed in WebViewer.
 * These are runtime status fields, Unity-only features, or component references
 * that have no WebViewer equivalent.
 */
const IGNORED: Record<string, string[]> = {
  Drive: [
    // Runtime status (read-only in C#, meaningless at load time)
    'CurrentSpeed', 'CurrentPosition', 'PositionOverwriteValue',
    'IsPosition', 'IsSpeed', 'IsStopped', 'IsRunning',
    'IsAtTargetSpeed', 'IsAtTarget', 'IsAtLowerLimit', 'IsAtUpperLimit',
    'IsSubDrive',
    // Features not implemented in WebViewer
    'SpeedOverride', 'SpeedScaleTransportSurface',
    'JumpToLowerLimitOnUpperLimit', 'LimitRayCast',
    'SmoothAcceleration', 'Jerk', 'smoothMotion',
    'JogForward', 'JogBackward', 'TargetPosition',
    'TargetStartMove', 'ResetDrive', '_StopDrive',
    'MoveThisRigidBody', 'UseInteract',
    // realvirtual component metadata
    'Name', 'Active',
  ],

  TransportSurface: [
    // Unity physics features not in WebViewer
    'AdvancedSurface',
    'ChangeConstraintsOnEnter', 'ConstraintsEnter',
    'ChangeConstraintsOnExit', 'ConstraintsExit',
    'ParentDrive',
    'UseMeshCollider', 'DebugMode', 'Layer',
    'UseAGXPhysics',
    // Runtime status
    'speed', 'SpeedScaleTransportSurface', 'IsGuided', 'LoadedPart',
    'Name', 'Active',
  ],

  Sensor: [
    // Display/visualization (not in WebViewer)
    'DisplayStatus', 'MaterialOccupied', 'MaterialNotOccupied',
    'ShowSensorLinerenderer', 'RayCastDisplayWidth',
    // Raycast details (not consumed)
    'AdditionalRayCastLayers',
    // SensorOccupied, SensorNotOccupied — now in schema (componentRef)
    // Filtering
    'LimitSensorToTag',
    // Debug
    'PauseOnSensor',
    // Runtime status
    'Occupied', 'LastTriggeredBy', 'RayCastDistance',
    'LastTriggeredID', 'LastTriggeredGlobalID',
    'Counter', 'ColliderCounter', 'CollidingMus', 'CollidingObjects',
    'Name', 'Active',
    // Legacy WebViewer fields that don't exist in C#
    'InvertSignal', 'Mode',
  ],

  Source: [
    // Features not in WebViewer
    'Destination', 'Enabled', 'FreezeSourcePosition',
    'DontVisualize', 'HideOnStop',
    'Mass', 'SetCenterOfMass', 'CenterOfMass',
    'GenerateOnLayer', 'OnCreateDestroyComponents',
    'StartInterval', 'RandomDistance', 'RangeDistance',
    'LimitNumber', 'MaxNumberMUs',
    'UsePooling', 'PoolSize', 'PrewarmPool', 'AllowPoolGrowth',
    'GenerateMU', 'DeleteAllMU',
    'SourceGenerate', 'SourceGenerateOnDistance',
    'UseAGXPhysics', 'overrideMaterial',
    // Runtime status
    'Created', 'PooledCount', 'ActiveCount',
    'Name', 'Active',
  ],

  Sink: [
    'DeleteMus', 'DeleteOnlyTag', 'DestroyFadeTime', 'Dissolve',
    'Delete', 'UseAGXPhysics',
    'SumDestroyed', 'DestroyedPerHour', 'CollidingObjects',
    'Name', 'Active',
  ],

  MU: [
    'DebugMode', 'ID', 'GlobalID', 'MUAppearences',
    'FixedBy', 'LastFixedBy', 'LoadedOn', 'StandardParent',
    'ParentBeforeFix', 'CollidedWithSensors', 'LoadedMus', 'CreatedBy',
    'SurfaceAlignSmoothment', 'UnfixSpeedInterpolate', 'NumInterpolations',
    'TransportSurfaces', 'Velocity',
    'Name', 'Active',
  ],

  DrivesRecorder: [
    // Runtime status
    'RecordAllDrivesWithinScene', 'Recording', 'Replaying',
    'RecordOnStart', 'CurrentFrame', 'NumberFrames',
    'CurrentSeconds', 'Duration', 'JumpToPositon',
    'Name',  // Active moved to CONSUMED
  ],

  // Signal types — runtime status (read-only structs)
  PLCOutputBool: ['Status', 'Name'],
  PLCInputBool: ['Status', 'Name'],
  PLCOutputFloat: ['Status', 'Name'],
  PLCInputFloat: ['Status', 'Name'],
  PLCOutputInt: ['Status', 'Name'],
  PLCInputInt: ['Status', 'Name'],

  // Drive behaviors — schema fields auto-derived, only non-schema fields here
  Drive_ErraticPosition: ['Name', 'Active'],
  Drive_Cylinder: [
    'StopWhenDrivingToMin', 'StopWhenDrivingToMax',
    '_out', '_in', '_isOut', '_isIn', '_movingOut', '_movingIn', '_isMax', '_isMin',
    'Name', 'Active', '_fullTypeName', '_version', '_enabled'],
  Drive_Gear: ['*'],      // Not yet consumed, pass-through
  Drive_Simple: ['Speed', 'Accelaration', 'IsAtPosition', 'IsAtSpeed', 'IsDriving',
    'ScaleSpeed', 'CurrentPositionScale', 'CurrentPositionOffset', 'ScaleFeedbackPosition', 'Name', 'Active'],
  Drive_CAM: ['*'],       // Not yet consumed, pass-through

  // ReplayRecording
  ReplayRecording: ['Name'],  // Active moved to CONSUMED

  // LogicStep containers — generic fields (Active moved to CONSUMED)
  LogicStep_SerialContainer: ['Name'],
  LogicStep_ParallelContainer: ['Name'],
  LogicStep_SetSignalBool: ['Name'],
  LogicStep_WaitForSensor: ['Name'],
  LogicStep_WaitForSignalBool: ['Name'],
  LogicStep_Delay: ['Name'],
  LogicStep_DriveToPosition: ['Name'],
  LogicStep_SetDriveSpeed: ['Name'],
  LogicStep_Enable: ['Name'],
  LogicStep_Pause: ['Name'],
  LogicStep_DriveTo: ['Name'],
  LogicStep_StartDriveTo: ['Name', 'LiveEdit'],
  LogicStep_StartDriveSpeed: ['Name'],
  LogicStep_WaitForDrivesAtTarget: ['Name'],
  LogicStep_SetSignalFloat: ['Name'],
  LogicStep_WaitForSignalFloat: ['Name'],
  LogicStep_GripPick: ['Name'],
  LogicStep_GripPlace: ['Name'],
  LogicStep_JumpOnSignal: ['Name'],
  LogicStep_SetActiveOnly: ['Name', 'Behaviors', 'SetToAlways'],
  LogicStep_CinemachineCamera: ['Name', 'Camera', 'UseCustomBlend', 'CustomBlendTime', 'CustomBlendStyle'],
  LogicStep_StatStartCycle: ['Name', 'StatCycleTimeComponent'],
  LogicStep_StatEndCycle: ['Name', 'StatCycleTimeComponent'],
  LogicStep_StatState: ['Name', 'StatStatesComponent', 'SetState'],
  LogicStep_StatOutput: ['Name', 'StatOutputComponent', 'OutputIncrement'],

  // RuntimeMetadata — Unity-only UI references
  RuntimeMetadata: ['window', 'interactable'],

  // ConnectSignal — internal state, Name/Active metadata
  ConnectSignal: ['Name', 'Active'],

  // Grip — fields not consumed in WebViewer
  Grip: [
    'AdvancedMode', 'DirectlyGrip', 'PickAlignWithObject', 'AlignRotation',
    'PickBasedOnSensor', 'PickBasedOnCylinder', 'PickOnCylinderMax',
    'RaycastDistance', 'NoPhysicsWhenPlaced', 'PlaceAlignWithObject',
    'PlaceLoadOnMU', 'PlaceLoadOnMUSensor', 'ConnectToJoint',
    'PickObjects', 'PlaceObjects',  // runtime state
    'EventMUGrip', 'ShowGizmo', 'PickedMUs',
    'Name', 'Active',
  ],

  // GripTarget — component metadata
  GripTarget: ['Name', 'Active'],

  // Group — component metadata
  Group: ['Name', 'Active', '_fullTypeName', '_version', '_enabled'],

  // Pipeline — Unity-only fields (mesh handling, shader state)
  Pipe: ['entryPoint', 'exitPoint'],
  ResourceTank: ['connections'],
};

/** Summary of unhandled fields per component type (collected during load) */
const unhandledSummary = new Map<string, Map<string, unknown>>();

/**
 * Validate GLB extras for a component type.
 * Logs warnings for fields not in CONSUMED or IGNORED lists.
 * Only active in dev mode.
 */
export function validateExtras(componentType: string, data: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;

  // Merge manual CONSUMED with schema-derived fields (keys + aliases)
  const manualConsumed = CONSUMED[componentType] ?? [];
  const schemaConsumed = getConsumedFieldsFromSchema(componentType);
  const consumed = new Set([...manualConsumed, ...schemaConsumed]);
  const ignored = IGNORED[componentType] ?? [];

  // Wildcard '*' in ignored means skip all validation for this type
  if (ignored.includes('*')) return;

  const ignoredSet = new Set(ignored);
  const known = new Set([...consumed, ...ignoredSet]);

  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      // Collect for summary
      if (!unhandledSummary.has(componentType)) {
        unhandledSummary.set(componentType, new Map());
      }
      const typeMap = unhandledSummary.get(componentType)!;
      if (!typeMap.has(key)) {
        typeMap.set(key, data[key]);
      }
    }
  }
}

/**
 * Print summary of all unhandled fields found during GLB load.
 * Call once after the full traverse is complete.
 */
export function printParitySummary(): void {
  if (!import.meta.env.DEV) return;
  if (unhandledSummary.size === 0) return;

  let totalFields = 0;
  const lines: string[] = [];

  for (const [type, fields] of unhandledSummary) {
    for (const [field, value] of fields) {
      const preview = typeof value === 'object' ? '{...}' : JSON.stringify(value);
      lines.push(`  ${type}.${field} = ${preview}`);
      totalFields++;
    }
  }

  console.warn(
    `[Parity] ${totalFields} unhandled GLB extras field(s) — add to CONSUMED or IGNORED in rv-extras-validator.ts:\n` +
    lines.join('\n')
  );
}

/**
 * Get editable field names for a component type. Used by property editor.
 * Returns the CONSUMED fields merged with schema-derived fields for the given type,
 * or an empty array if the type is unknown.
 */
export function getConsumedFields(componentType: string): readonly string[] {
  const manual = CONSUMED[componentType] ?? [];
  const schema = getConsumedFieldsFromSchema(componentType);
  if (schema.length === 0) return manual;
  // Deduplicate: schema first, then any manual extras
  return [...new Set([...schema, ...manual])];
}

/**
 * Get ignored field names for a component type. Used by property inspector.
 * Returns the IGNORED fields list for the given type, or an empty array
 * if the type is unknown. A wildcard entry ['*'] means all fields are ignored.
 */
export function getIgnoredFields(componentType: string): readonly string[] {
  return IGNORED[componentType] ?? [];
}

/**
 * Returns true if the component type is known to the WebViewer —
 * i.e. it appears in CONSUMED, IGNORED, or has a registered schema.
 * Unknown components are completely unused and can be auto-hidden in the inspector.
 */
export function isKnownComponentType(componentType: string): boolean {
  if (componentType in CONSUMED) return true;
  if (componentType in IGNORED) return true;
  if (getConsumedFieldsFromSchema(componentType).length > 0) return true;
  if (getRegisteredCapabilities().has(componentType)) return true;
  return false;
}

/**
 * Clear collected summary (call before loading a new model).
 */
export function resetParityValidator(): void {
  unhandledSummary.clear();
}
