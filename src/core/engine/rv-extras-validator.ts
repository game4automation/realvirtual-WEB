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
import { validateOperatorPanelConfig } from '../hmi/operator-devices/operator-panel-model';

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
  Lamp: ['OnColor'], // Unity Color is read raw; scalar fields are schema-derived
  Zone: [],       // plan-521 — all fields in RVZone.schema


  // plan-417 — 3D scene buttons. Only the material NAMES are read raw (they
  // decide whether the cap has a light at all); the rest is schema-derived.
  SceneButtonBase: [],
  SceneButtonMoveable: ['baseMaterial', 'activeMaterial'],
  PushButton3D: [],
  EmergencyButton3D: [],
  HandleSwitch3D: [],

  // Drive behaviors — schema fields auto-derived
  Drive_Simple: [],       // all fields in RVDriveSimple.schema
  Drive_Cylinder: [],     // all fields in RVDriveCylinder.schema
  Drive_ErraticPosition: [], // all fields in RVErraticDriver.schema

  // LayoutObject — layout planner marker component. `Visible` is editable
  // from the Inspector and mirrors node.visible (handled in
  // PropertyInspector.handleFieldEdit).
  LayoutObject: ['Label', 'CatalogId', 'Locked', 'Visible'],

  // Splat — Gaussian-Splat-specific tools, co-mounted with LayoutObject on
  // splat placements (see scene-mutations.addSplatPlacedToScene). The
  // Invert booleans persist via the standard rv-extras overlay; the
  // visual effect is applied through `gaussian-splat-plugin.setSplatScale`
  // on edit (PropertyInspector handleFieldEdit) and on restore
  // (layout-planner _applySplatTransformFromUserData).
  Splat: [
    'InvertX', 'InvertY', 'InvertZ',
    // Axis-aligned crop box in the splat's local frame — Splats outside
    // [min,max] are culled in the vertex shader. Used e.g. to hide the
    // ceiling of a captured room (lower CropMaxY) or floor noise (raise
    // CropMinY). Defaults to ±1000 (effectively "no clip").
    'CropMinX', 'CropMaxX',
    'CropMinY', 'CropMaxY',
    'CropMinZ', 'CropMaxZ',
  ],

  // Path — WebViewer-native path substrate (plan-268). The structured fields
  // (segments/successors/align + the type/id discriminators) and the Phase-2
  // zone attributes (zone/zoneCapacity, control-point model) are consumed by
  // parsePathExtras() in rv-path.ts, not by the scalar factory schema.
  Path: ['type', 'id', 'segments', 'successors', 'align', 'zone', 'zoneCapacity'],

  // AASLink — Asset Administration Shell link (parsed by aas-link-plugin)
  AASLink: ['AASId', 'Description', 'ServerUrl'],

  // WebComponent — JS-in-GLB script component (plan-210 §7), parsed by
  // parseWebComponent() in rv-web-component-registry.ts. Additional primitive
  // fields become the `self.prop` bag (v1 shim) and may warn here until the
  // plan-139 property layer lands.
  WebComponent: ['Active', 'ApiVersion', 'Language', 'DesSafe', 'TypeId', 'Code'],

  // WebPhysicsZone — StaticColliders is a rawFields string array (node paths)
  // captured in the factory beforeSchema hook (rv-physics-zone.ts), not a
  // schema field (the schema mapper has no string-array type).
  WebPhysicsZone: ['StaticColliders'],

  // MU — LoadSeatDepth (plan-577) on carriers; the schema registered in rv-mu.ts adds it too
  MU: ['LoadSeatDepth'],

  // BoxCollider — used by createAABBFromExtras()
  BoxCollider: ['center', 'size'],

  // Signal types — connection-relevant fields editable, Status read-only (object).
  // `Generated` (plan-589) is the PROVENANCE flag written by `addSignal()` and
  // `registerBehaviorSignals()`: it marks a signal the runtime created, whose
  // persisted `Name` is asset-local and gets instance-scoped on load. It must
  // survive the GLB export, so it belongs in this list — without it the
  // validator would drop it and every reload would read the leaf as authored.
  PLCOutputBool: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active', 'Generated'],
  PLCInputBool: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active', 'Generated'],
  PLCOutputFloat: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active', 'Generated'],
  PLCInputFloat: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active', 'Generated'],
  PLCOutputInt: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active', 'Generated'],
  PLCInputInt: ['Comment', 'OriginDataType', 'Settings', 'Metadata', 'Active', 'Generated'],

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
  LogicStep_JavaScript: ['Active'],
  LogicStep_ParallelContainer: ['Active'],
  LogicStep_SetSignalBool: ['Signal', 'SetToTrue', 'Active'],
  LogicStep_WaitForSensor: ['Sensor', 'WaitForOccupied', 'WaitForStopped', 'Active'],
  LogicStep_WaitForZone: ['Zone', 'WaitForOccupied', 'Active'],
  LogicStep_WaitForSignalBool: ['Signal', 'WaitForTrue', 'Edge', 'Active'],  // Edge: plan-538 F5
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
  LogicStep_IKPath: ['IKPath', 'Active'],
  // plan-729 — built by the private mechanism feature through the
  // rv-logic-step-registry seam; the fields are the same shape as IKPath's.
  LogicStep_MechanismPath: ['MechanismPath', 'Active'],
  LogicStep_SetActiveOnly: ['Active'],
  LogicStep_CinemachineCamera: ['Active'],
  LogicStep_StatStartCycle: ['Active'],
  LogicStep_StatEndCycle: ['Active'],
  LogicStep_StatState: ['Active'],
  LogicStep_StatOutput: ['Active'],

  // MechanismPath (plan-729) — the schema fields are derived automatically;
  // StartNextPath is a rawFields entry read straight from the extras.
  MechanismPath: ['StartNextPath'],

  // RuntimeMetadata — parsed by scene loader for tooltip content
  RuntimeMetadata: ['content'],

  // CustomRuntimeInstruction — every authoring field the web viewer consumes
  // renders as a primary editable row. `steps` is a nested raw list drawn by a
  // custom inspector renderer (rv-custom-runtime-instruction-field-renderer);
  // the rest (type/dismissible/Isolate/signal/BlinkSpeed) are schema fields.
  // Listing them all keeps them out of the collapsed "N more fields" read-only
  // dump so the instruction shows type + steps + targets up front.
  CustomRuntimeInstruction: ['type', 'dismissible', 'Isolate', 'signal', 'BlinkSpeed', 'steps'],

  // Group — fields fully covered by the schema in rv-group-component.ts

  // Kinematic — parsed by the scene loader (collect + resolveKinematicGroupNames)
  // and the `Kinematic` pre-bake hook (the re-parenting, rv-pre-bake-hooks.ts)
  Kinematic: [
    'IntegrateGroupEnable', 'GroupName', 'GroupNamePrefix', 'SimplifyHierarchy',
    'KinematicParentEnable', 'Parent',
  ],

  // Fmu (plan-498) — every field is schema-derived; FmuEmbed / FmuVariables
  // are structured and shape-checked by validateFmuExtras() below.
  Fmu: [],

  // Pipeline components — parsed by loadGLB pipeline parsing (schemas in rv-pipe.ts / rv-tank.ts / rv-pump.ts / rv-processing-unit.ts)
  Pipe: [
    'resourceName', 'flowRate', 'source', 'destination', 'uvDirection', 'circuitId',
    // Industry-typical instrumentation
    'pressure', 'temperatureC', 'velocityMs', 'dnSize',
  ],
  ResourceTank: [
    'resourceName', 'capacity', 'amount', 'pressure', 'temperature',
    // Industry-typical instrumentation
    'density', 'ph', 'agitatorOn', 'heatingOn',
    'tempHighLimit', 'tempLowLimit', 'pressureHighLimit',
  ],
  Pump: [
    'flowRate', 'pipe', 'circuitId', 'resourceName',
    // Industry-typical instrumentation
    'state', 'suctionPressure', 'dischargePressure',
    'speedRpm', 'speedPercent', 'powerKw', 'currentA',
    'bearingTempC', 'motorTempC', 'vibrationMmS',
    'npshAvailable', 'npshRequired', 'runHours',
  ],
  ProcessingUnit: [
    'connections',
    // OEE & production telemetry
    'state', 'availability', 'performance', 'quality',
    'cycleTimeS', 'cycleTargetS', 'throughputPerHour',
    'goodCount', 'scrapCount',
    'mtbfHours', 'mttrMinutes', 'runHours', 'downHours',
    'lastFault',
  ],
};

/**
 * Fields intentionally ignored — present in GLB but not needed in WebViewer.
 * These are runtime status fields, Unity-only features, or component references
 * that have no WebViewer equivalent.
 */
/**
 * Universal Unity serialization metadata present on (almost) every exported
 * component. These are never real component fields — no TypeScript parser
 * consumes them — so they are ignored for ALL types instead of being repeated
 * in every per-type IGNORED list. Without this, the dev-mode parity check spams
 * ~3 lines per component per load (`_fullTypeName`, `_version`, `_enabled`).
 */
const GLOBAL_IGNORED: string[] = ['_fullTypeName', '_version', '_enabled'];

/**
 * Runtime status of the C# `LogicStep` base class (`LogicStep.cs`): the inspector
 * progress bar and the two execution flags. Every exported LogicStep carries them, so
 * they are spread into each `LogicStep_*` entry instead of being repeated by hand.
 * Status, not configuration — the TypeScript logic engine owns its own step state.
 */
const LOGIC_STEP_STATUS: string[] = ['State', 'StepActive', 'IsWaiting'];

const IGNORED: Record<string, string[]> = {
  // plan-417 — 3D scene buttons. `Name`/`Active` are realvirtual component
  // metadata; `renderer`/`colliders` are Unity component references the viewer
  // resolves by traversal instead; `currentOffset` is Unity runtime state and
  // the UnityEvents have no web equivalent.
  // plan-466 — `Active` is the realvirtualBehavior ActiveOnly flag that every Unity
  // component carries (Connected/Disconnected playback). The ribbon components have no
  // web equivalent for it, exactly like the signals and LogicSteps above.
  RibbonRoller: ['Active', 'RotationDirection'],
  RibbonWinder: ['Active', 'RotationDirection'],
  RibbonDancer: ['Active', 'RotationDirection'],
  RibbonPath: ['Active', 'ReportAlarms'],

  SceneButtonBase: ['Name', 'Active', 'OnToggleOn', 'OnToggleOff'],
  SceneButtonMoveable: ['renderer', 'currentOffset', 'Name', 'Active'],
  PushButton3D: ['Name', 'Active'],
  EmergencyButton3D: ['Name', 'Active'],
  HandleSwitch3D: ['Name', 'Active'],

  Drive: [
    // Runtime status (read-only in C#, meaningless at load time)
    'CurrentSpeed', 'CurrentPosition', 'PositionOverwriteValue',
    'IsPosition', 'IsSpeed', 'IsStopped', 'IsRunning',
    'IsAtTargetSpeed', 'IsAtTarget', 'IsAtLowerLimit', 'IsAtUpperLimit',
    'IsSubDrive',
    // Features not implemented in WebViewer
    // NOTE: JogForward / JogBackward / TargetPosition used to be listed here and
    // were therefore dropped at load — an authored `JogForward: true` never
    // reached the engine and the drive silently refused to move. They are now
    // real schema fields (see rv-odt.json → $defs/Drive) applied by initDrive().
    'SpeedScaleTransportSurface',
    'LimitRayCast',
    // NOTE (plan-281 Phase 4): SmoothAcceleration / Jerk / SpeedOverride /
    // JumpToLowerLimitOnUpperLimit used to be listed here as "not implemented"
    // and were therefore dropped at load. They are now real schema fields (see
    // rv-odt.json → $defs/Drive) consumed by the jerk-limited motion path.
    // `smoothMotion` stays ignored on purpose: it is the serialized internal C#
    // solver object, not an end-user property (plan-281 §3.2).
    'smoothMotion',
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
  // Containers additionally export their step cursor and the inspector cycle-time
  // statistics (`LogicStep_SerialContainer.cs`) — runtime status, recomputed by the
  // TypeScript logic engine.
  LogicStep_SerialContainer: [
    ...LOGIC_STEP_STATUS, 'Name',
    'ActiveLogicStep', 'NumberLogicSteps',
    'minCycleTimeDisplay', 'maxCycleTimeDisplay', 'medianCycleTimeDisplay',
    'completedCyclesDisplay',
  ],
  LogicStep_ParallelContainer: [
    ...LOGIC_STEP_STATUS, 'Name',
    'ActiveLogicStep', 'NumberLogicSteps',
    'minCycleTimeDisplay', 'maxCycleTimeDisplay', 'medianCycleTimeDisplay',
    'completedCyclesDisplay',
  ],
  LogicStep_SetSignalBool: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_WaitForSensor: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_WaitForZone: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_WaitForSignalBool: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_Delay: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_DriveToPosition: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_SetDriveSpeed: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_Enable: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_Pause: [...LOGIC_STEP_STATUS, 'Name'],
  // `LiveEdit` is an editor-only handle toggle — already ignored for StartDriveTo.
  LogicStep_DriveTo: [...LOGIC_STEP_STATUS, 'Name', 'LiveEdit'],
  LogicStep_StartDriveTo: [...LOGIC_STEP_STATUS, 'Name', 'LiveEdit'],
  LogicStep_StartDriveSpeed: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_WaitForDrivesAtTarget: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_SetSignalFloat: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_WaitForSignalFloat: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_GripPick: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_GripPlace: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_JumpOnSignal: [...LOGIC_STEP_STATUS, 'Name'],
  LogicStep_SetActiveOnly: [...LOGIC_STEP_STATUS, 'Name', 'Behaviors', 'SetToAlways'],
  LogicStep_CinemachineCamera: [...LOGIC_STEP_STATUS, 'Name', 'Camera', 'UseCustomBlend', 'CustomBlendTime', 'CustomBlendStyle'],
  LogicStep_StatStartCycle: [...LOGIC_STEP_STATUS, 'Name', 'StatCycleTimeComponent'],
  LogicStep_StatEndCycle: [...LOGIC_STEP_STATUS, 'Name', 'StatCycleTimeComponent'],
  LogicStep_StatState: [...LOGIC_STEP_STATUS, 'Name', 'StatStatesComponent', 'SetState'],
  LogicStep_StatOutput: [...LOGIC_STEP_STATUS, 'Name', 'StatOutputComponent', 'OutputIncrement'],

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

  // Machining (plan-405) — the configuration fields are schema-derived; what remains
  // is runtime status the TypeScript side computes itself, one Unity-only meshing
  // option, and the standard component metadata.
  MachiningVolume: [
    // Runtime status, recomputed from the worker's acks / countSolid
    'MaterialRemainingPercent', 'VoxelsModified', 'LastUpdateMs', 'IsInitialized',
    // Unity-only: the WASM kernel's crease-angle normals cover this (CreaseAngle)
    'SmoothNormals',
    'ConnectionInfo', 'Name', 'Active',
  ],
  MachiningTool: ['ConnectionInfo', 'Name', 'Active'],

  // Pipeline — Unity-only fields (mesh handling, shader state)
  Pipe: ['entryPoint', 'exitPoint'],
  ResourceTank: ['connections'],

  // ── Rigid-body mechanism (plan-404) ──────────────────────────────────────
  // These five fields DO ride along in a Unity mechanism export but are
  // deliberately not consumed by the web host, so the dev parity check must not
  // report them. They are not "not yet implemented" — they have no web meaning:
  //   Active            realvirtualBehavior metadata; enable/disable is driven by
  //                     the mechanism's own disabled-reason path, not this flag.
  //   capturedJointLocalPos/Rot, hasCapture
  //                     Unity EDITOR authoring state — the pose KinematicJoint
  //                     captures so the Unity inspector can restore it. It is the
  //                     documented, deliberately accepted `[HideInInspector]`
  //                     side effect of plan-273 §2.3 and has no runtime role on
  //                     either side. The web host derives joint state from the
  //                     solver, never from a captured editor pose.
  // MeshCollider (plan-467 Phase 1) — a `colliders[]` ENTRY type, not a
  // top-level extras key, so `validateExtras('MeshCollider', …)` is never
  // called for it. It is listed here so `isKnownComponentType('MeshCollider')`
  // reports it as known: the physics side DOES consume `convex` / `enabled` /
  // `isTrigger` (rv-collider-extras.ts → convex-hull kinematic bodies). The
  // entry lives in IGNORED rather than CONSUMED on purpose — CONSUMED types are
  // asserted to have an rv-ODT `$def` (tests/spec-loading.test.ts) and the
  // collider array has no `$def` in schema v1.
  MeshCollider: ['type', 'convex', 'enabled', 'isTrigger', 'cookingOptions', 'sharedMaterial'],

  KinematicMechanism: ['Active'],
  KinematicJoint: [
    'Active',
    'capturedJointLocalPos', 'capturedJointLocalRot', 'hasCapture',
  ],
};

/** Summary of unhandled fields per component type (collected during load) */
// ─── Fmu shape (plan-498) ──────────────────────────────────────────────

/** The package record of an `Fmu` component, shape-checked. */
export interface FmuEmbedShape {
  fileName: string;
  sha256: string;
  guid: string;
  modelName: string;
  fmiVersion: string;
  generationTool?: string;
  generationDateAndTime?: string;
  byteLength: number;
  /** Index of the bufferView holding the bytes; -1 = not saved with bytes. */
  bufferView: number;
}

/** One `FmuVariables[]` record, shape-checked. */
export interface FmuVariableShape {
  name: string;
  valueReference: number;
  causality: 'input' | 'output' | 'parameter' | 'calculatedParameter';
  variability: string;
  type: 'Real' | 'Integer' | 'Boolean' | 'String' | 'Enumeration';
  start?: string;
  unit?: string;
  description?: string;
  /** plan-502 — FMI `initial` attribute. */
  initial?: 'exact' | 'approx' | 'calculated';
  /** plan-502 — numeric range of the variable (absent in pre-502 extras). */
  min?: number;
  max?: number;
  /** plan-502 — `declaredType` (SimpleType name). */
  declaredType?: string;
  /** plan-502 — enumeration items `{ name, value }` (Enumeration variables only). */
  enumItems?: Array<{ name: string; value: number; description?: string }>;
}

/** Result of {@link validateFmuExtras}: what is usable plus what was dropped. */
export interface FmuExtrasCheck {
  /** Null when no package is attached (no `FmuEmbed.sha256`). */
  embed: FmuEmbedShape | null;
  variables: FmuVariableShape[];
  /**
   * plan-502 — `FmuStartOverrides` as a name → string map. Only the SHAPE is
   * checked here (string values; numbers/booleans are stringified); whether a
   * name is known and allowed is `RVFmu`'s call (orphaned overrides).
   */
  startOverrides: Record<string, string>;
  /** Human-readable reasons for every dropped record/field. */
  issues: string[];
}

const FMU_CAUSALITIES = new Set(['input', 'output', 'parameter', 'calculatedParameter']);
const FMU_TYPES = new Set(['Real', 'Integer', 'Boolean', 'String', 'Enumeration']);
const FMU_BASE_UNIT_KEYS = new Set(['kg', 'm', 's', 'A', 'K', 'mol', 'cd', 'rad', 'factor', 'offset']);

function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Defensive reader of an `Fmu` extras record — the ONE shape check of
 * `FmuEmbed` and `FmuVariables` (plan-498 F11). Never throws: a malformed
 * variable is dropped and named in `issues`; an `FmuEmbed` without a SHA means
 * "no package attached" (`embed: null`), which is a valid authoring state.
 */
export function validateFmuExtras(data: Record<string, unknown> | undefined | null): FmuExtrasCheck {
  const issues: string[] = [];
  const rawEmbed = data?.FmuEmbed;
  let embed: FmuEmbedShape | null = null;
  if (rawEmbed && typeof rawEmbed === 'object' && !Array.isArray(rawEmbed)) {
    const e = rawEmbed as Record<string, unknown>;
    const sha = typeof e.sha256 === 'string' ? e.sha256.trim().toLowerCase() : '';
    if (sha && /^[0-9a-f]{64}$/.test(sha)) {
      const bufferView = Number.isInteger(e.bufferView) ? (e.bufferView as number) : -1;
      const byteLength = typeof e.byteLength === 'number' && e.byteLength >= 0 ? e.byteLength : 0;
      embed = {
        fileName: optString(e.fileName) ?? '',
        sha256: sha,
        guid: optString(e.guid) ?? '',
        modelName: optString(e.modelName) ?? '',
        fmiVersion: optString(e.fmiVersion) ?? '2.0',
        byteLength,
        bufferView: bufferView >= 0 ? bufferView : -1,
      };
      const tool = optString(e.generationTool);
      if (tool !== undefined) embed.generationTool = tool;
      const when = optString(e.generationDateAndTime);
      if (when !== undefined) embed.generationDateAndTime = when;
      if (embed.fmiVersion !== '2.0') issues.push(`FmuEmbed.fmiVersion "${embed.fmiVersion}" is not 2.0`);
    } else if (sha) {
      issues.push(`FmuEmbed.sha256 "${sha}" is not a SHA-256 hex digest`);
    }
  } else if (rawEmbed !== undefined && rawEmbed !== null) {
    issues.push('FmuEmbed is not an object');
  }

  const variables: FmuVariableShape[] = [];
  const rawVars = data?.FmuVariables;
  if (Array.isArray(rawVars)) {
    const seen = new Set<string>();
    rawVars.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') { issues.push(`FmuVariables[${i}] is not an object`); return; }
      const v = raw as Record<string, unknown>;
      const name = typeof v.name === 'string' ? v.name : '';
      const vr = typeof v.valueReference === 'number' ? v.valueReference : Number(v.valueReference);
      const causality = String(v.causality ?? '');
      const type = String(v.type ?? '');
      if (!name || name.includes('/')) { issues.push(`FmuVariables[${i}] has no usable name`); return; }
      if (!Number.isInteger(vr) || vr < 0) { issues.push(`FmuVariables[${i}] (${name}) has no valueReference`); return; }
      if (!FMU_CAUSALITIES.has(causality)) { issues.push(`FmuVariables[${i}] (${name}) has causality "${causality}"`); return; }
      if (!FMU_TYPES.has(type)) { issues.push(`FmuVariables[${i}] (${name}) has type "${type}"`); return; }
      if (seen.has(name)) { issues.push(`FmuVariables[${i}] (${name}) is a duplicate`); return; }
      seen.add(name);
      const out: FmuVariableShape = {
        name, valueReference: vr,
        causality: causality as FmuVariableShape['causality'],
        variability: typeof v.variability === 'string' ? v.variability : 'continuous',
        type: type as FmuVariableShape['type'],
      };
      if (v.start !== undefined && v.start !== null) out.start = String(v.start);
      const unit = optString(v.unit);
      if (unit !== undefined) out.unit = unit;
      const description = optString(v.description);
      if (description !== undefined) out.description = description;
      // plan-502 — optional; every field is dropped silently when malformed.
      const initial = v.initial;
      if (initial === 'exact' || initial === 'approx' || initial === 'calculated') out.initial = initial;
      if (typeof v.min === 'number' && Number.isFinite(v.min)) out.min = v.min;
      if (typeof v.max === 'number' && Number.isFinite(v.max)) out.max = v.max;
      const declaredType = optString(v.declaredType);
      if (declaredType !== undefined) out.declaredType = declaredType;
      if (Array.isArray(v.enumItems)) {
        const items: NonNullable<FmuVariableShape['enumItems']> = [];
        for (const it of v.enumItems as unknown[]) {
          if (!it || typeof it !== 'object') continue;
          const r = it as Record<string, unknown>;
          if (typeof r.name !== 'string' || !r.name || typeof r.value !== 'number' || !Number.isInteger(r.value)) continue;
          const item: { name: string; value: number; description?: string } = { name: r.name, value: r.value };
          if (typeof r.description === 'string') item.description = r.description;
          items.push(item);
        }
        if (items.length > 0) out.enumItems = items;
      }
      variables.push(out);
    });
  } else if (rawVars !== undefined && rawVars !== null) {
    issues.push('FmuVariables is not an array');
  }

  const startOverrides: Record<string, string> = {};
  const rawOverrides = data?.FmuStartOverrides;
  if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
    for (const [name, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (!name) continue;
      if (typeof value === 'string') startOverrides[name] = value;
      else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') startOverrides[name] = String(value);
      else issues.push(`FmuStartOverrides.${name} is not a string value`);
    }
  } else if (rawOverrides !== undefined && rawOverrides !== null) {
    issues.push('FmuStartOverrides is not an object');
  }

  // plan-512 F11 — `FmuUnits` (unit name → FMI BaseUnit). Shape only: the unit
  // kernel reads it defensively (`unitDefsFromBaseUnits`), a malformed entry is
  // named here and then ignored there.
  const rawUnits = data?.FmuUnits;
  if (rawUnits && typeof rawUnits === 'object' && !Array.isArray(rawUnits)) {
    for (const [name, value] of Object.entries(rawUnits as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        issues.push(`FmuUnits.${name} is not a BaseUnit object`);
        continue;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!FMU_BASE_UNIT_KEYS.has(k)) issues.push(`FmuUnits.${name}.${k} is not a BaseUnit attribute`);
        else if (typeof v !== 'number' || !Number.isFinite(v)) issues.push(`FmuUnits.${name}.${k} is not a number`);
      }
    }
  } else if (rawUnits !== undefined && rawUnits !== null) {
    issues.push('FmuUnits is not an object');
  }
  return { embed, variables, startOverrides, issues };
}

/** The fields of a `Zone` the authoring rules look at (plan-521 F2/F3). */
export interface ZoneRuleInput {
  Detect: boolean;
  Block: boolean;
  Hold: boolean;
  Activation: string;
  /** Resolved signal address (or the raw reference when unresolved), null when unset. */
  ActivationSignal: unknown;
  /** Resolved drive (or the raw reference when unresolved), null when unset. */
  ActivationDrive: unknown;
  Size: { x: number; y: number; z: number };
  /** plan-530 — optional so older callers keep compiling (absent = false). */
  SingleRelease?: boolean;
}

/**
 * Field rules of a `Zone` (plan-521, spec §7a.66 "Authoring rules"). Returns
 * human-readable problems — empty when the configuration is complete. A zone
 * with a problem still loads (defensive parsing); the reader warns instead of
 * refusing it. Active in every build: a silently inert zone is exactly the
 * failure an author cannot see.
 */
export function zoneRuleWarnings(zone: ZoneRuleInput): string[] {
  const out: string[] = [];
  if (!zone.Detect && !zone.Block && !zone.Hold) {
    out.push('no effect set (Detect, Block and Hold are all false) — the zone does nothing');
  }
  if (zone.Activation === 'Signal' && !zone.ActivationSignal) {
    out.push('Activation "Signal" needs ActivationSignal — the zone stays inactive');
  }
  if (zone.Activation === 'Axis' && !zone.ActivationDrive) {
    out.push('Activation "Axis" needs ActivationDrive — the zone stays inactive');
  }
  const sz = zone.Size;
  if (!(sz.x > 0 && sz.y > 0 && sz.z > 0)) {
    out.push('Size must be positive on all three axes — the box is empty');
  }
  if (zone.SingleRelease === true && !zone.Block) {
    out.push('SingleRelease needs Block — without it SingleRelease does nothing');
  }
  if (zone.SingleRelease === true && zone.Hold) {
    out.push('SingleRelease is ignored while Hold is on');
  }
  return out;
}

/** One top-level logic root as the plan-538 root rules see it. */
export interface LogicRootRuleInput {
  /** Root name (for the message). */
  name: string;
  /** The root's `Active` value (`DontChange` counts as `Always`). */
  active: string;
  /** Signal addresses written by the root's SetSignal steps (owned outputs). */
  outputs: readonly string[];
  /** Drives commanded by the root's motion steps (identity compared). */
  drives: readonly unknown[];
  /** Names of steps that start motion but have no cancel hook. */
  motionWithoutCancel: readonly string[];
}

/**
 * Rules of the per-root `Active` lifecycle (plan-538 F1f / F1g). Returns
 * human-readable warnings — empty when the roots are unproblematic. Active in
 * every build (like {@link zoneRuleWarnings}): an output fought over by a
 * virtual PLC and a real PLC is exactly the failure an author cannot see.
 *
 * - An output signal or a drive used by roots with DIFFERENT `Active` values
 *   is shared between a virtual-PLC root and its counterpart: deactivating one
 *   never resets what an active root currently owns, but the author should
 *   know the two compete.
 * - A step that starts motion without a cancel hook in a root whose `Active`
 *   is not `Always`: switching the root off could not stop that motion.
 */
export function logicRootRuleWarnings(roots: readonly LogicRootRuleInput[]): string[] {
  const out: string[] = [];
  const norm = (a: string): string => (a === 'DontChange' ? 'Always' : a);
  const report = (kind: string, key: unknown, label: string): void => {
    const users = roots.filter((r) => (kind === 'output' ? r.outputs : r.drives).includes(key as never));
    const actives = new Set(users.map((r) => norm(r.active)));
    if (actives.size > 1) {
      out.push(`${kind} ${label} is shared between roots with different Active (${users.map((r) => `"${r.name}"=${norm(r.active)}`).join(', ')})`);
    }
  };
  const outputs = new Set<string>();
  for (const r of roots) for (const o of r.outputs) outputs.add(o);
  for (const o of outputs) report('output', o, `"${o}"`);
  const drives = new Set<unknown>();
  for (const r of roots) for (const d of r.drives) drives.add(d);
  for (const d of drives) {
    const name = (d as { name?: unknown; node?: { name?: unknown } }).name ?? (d as { node?: { name?: unknown } }).node?.name ?? '?';
    report('drive', d, `"${String(name)}"`);
  }
  for (const r of roots) {
    if (norm(r.active) === 'Always') continue;
    for (const step of r.motionWithoutCancel) {
      out.push(`root "${r.name}" (Active=${r.active}): step "${step}" starts motion but cannot be cancelled — deactivating the root leaves it moving`);
    }
  }
  return out;
}

// ─── WebOperatorPanel (plan-543) ───────────────────────────────────────

/** Result of {@link parseWebOperatorPanelConfig}: the parsed JSON, or why there is none. */
export interface WebOperatorPanelConfigParse {
  /** The parsed config (unvalidated), or null when `Config` is empty or not JSON. */
  raw: unknown;
  /** JSON-level problems ("Config is not valid JSON: …"); empty when it parsed. */
  errors: string[];
}

/**
 * Reads the `Config` field of a `WebOperatorPanel`: a JSON STRING (the authored
 * form), tolerating an already-parsed object (an MCP `valueJson` that carried
 * the object instead of a JSON string). Never throws.
 */
export function parseWebOperatorPanelConfig(value: unknown): WebOperatorPanelConfigParse {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { raw: value, errors: [] };
  if (typeof value !== 'string' || value.trim() === '') {
    return { raw: null, errors: ['Config is empty — paste an operator panel JSON (web_help topic "operator-panel")'] };
  }
  try {
    return { raw: JSON.parse(value) as unknown, errors: [] };
  } catch (e) {
    return { raw: null, errors: [`Config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/**
 * Field rule of a `WebOperatorPanel` (plan-543 F1, spec §7d.14): `Config` must
 * parse and be a valid operator panel; with `hasSignal`, every signal it uses
 * must exist in the model. Returns the problems, each with its JSON path
 * (`buttons[3].signal 'BT9' not found in model`) — empty when valid. Active in
 * every build: a panel that silently shows nothing is the failure an author
 * cannot see.
 */
export function webOperatorPanelRuleWarnings(config: unknown, hasSignal?: (name: string) => boolean): string[] {
  const parsed = parseWebOperatorPanelConfig(config);
  if (parsed.errors.length > 0) return parsed.errors;
  return validateOperatorPanelConfig(parsed.raw, hasSignal).errors;
}

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
  const known = new Set([...consumed, ...ignoredSet, ...GLOBAL_IGNORED]);

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
 * All component types with a manual CONSUMED entry. Used by the rv-ODT spec
 * coverage test (tests/spec-loading.test.ts) to assert that every rv_extras
 * surface consumed by the WebViewer has a $def in schema/v1/rv-odt.json.
 */
export function getValidatorConsumedTypes(): readonly string[] {
  return Object.keys(CONSUMED);
}

/**
 * Clear collected summary (call before loading a new model).
 */
export function resetParityValidator(): void {
  unhandledSummary.clear();
}
