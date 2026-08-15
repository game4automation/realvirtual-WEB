// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * inline-schemas-baseline.ts — FROZEN snapshot of the component schemas as they
 * were defined INLINE in the component classes before the rv-ODT migration
 * (plan-187). The determinism test in tests/spec-loading.test.ts compares
 * `loadSchemaFromSpec(<key>)` against these literals to prove the JSON spec
 * (schema/v1/rv-odt.json) reproduces the exact pre-migration schemas.
 *
 * DO NOT "fix" this file to make a failing test green — it is the regression
 * baseline. When a component schema intentionally changes, update BOTH the
 * rv-odt.json spec AND this baseline in the same commit.
 */

import type { ComponentSchema } from '../../src/core/engine/rv-component-registry';

export const INLINE_SCHEMA_BASELINE: Record<string, ComponentSchema> = {
  Drive: {
    Direction: { type: 'enum', enumMap: {
      LinearX: 'LinearX',
      LinearY: 'LinearY',
      LinearZ: 'LinearZ',
      RotationX: 'RotationX',
      RotationY: 'RotationY',
      RotationZ: 'RotationZ',
      Virtual: 'Virtual',
    }},
    ReverseDirection: { type: 'boolean', default: false },
    Offset: { type: 'number', default: 0 },
    StartPosition: { type: 'number', default: 0 },
    TargetSpeed: { type: 'number', default: 100 },
    Acceleration: { type: 'number', default: 100 },
    UseAcceleration: { type: 'boolean', default: false },
    UseLimits: { type: 'boolean', default: false },
    LowerLimit: { type: 'number', default: -180 },
    UpperLimit: { type: 'number', default: 180 },
    JogForward: { type: 'boolean', default: false },
    JogBackward: { type: 'boolean', default: false },
    TargetPosition: { type: 'number', default: 0 },
  },

  Drive_Simple: {
    Speed:        { type: 'componentRef', signal: 'PLCOutputFloat' },
    Accelaration: { type: 'componentRef', signal: 'PLCOutputFloat' },
    Forward:      { type: 'componentRef', signal: 'PLCOutputBool' },
    Backward:     { type: 'componentRef', signal: 'PLCOutputBool' },
    IsAtPosition: { type: 'componentRef', signal: 'PLCInputFloat' },
    IsAtSpeed:    { type: 'componentRef', signal: 'PLCInputFloat' },
    IsDriving:    { type: 'componentRef', signal: 'PLCInputBool' },
    ScaleSpeed:            { type: 'number',  default: 1 },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    CurrentPositionOffset: { type: 'number',  default: 0 },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_Cylinder: {
    MinPos: { type: 'number', default: 0 },
    MaxPos: { type: 'number', default: 100 },
    TimeOut: { type: 'number', default: 1 },
    TimeIn: { type: 'number', default: 1 },
    OneBitCylinder: { type: 'boolean', default: false },
    InvertOutputLogic: { type: 'boolean', default: false },
    Out: { type: 'componentRef', signal: 'PLCOutputBool' },
    In: { type: 'componentRef', signal: 'PLCOutputBool' },
    IsOut: { type: 'componentRef', signal: 'PLCInputBool' },
    IsIn: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMax: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMin: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMovingOut: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMovingIn: { type: 'componentRef', signal: 'PLCInputBool' },
  },

  Drive_Speed: {
    SignalTargetSpeed:     { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalAcceleration:    { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalCurrentSpeed:    { type: 'componentRef', signal: 'PLCInputFloat' },
    SignalCurrentPosition: { type: 'componentRef', signal: 'PLCInputFloat' },
    SignalIsDriving:       { type: 'componentRef', signal: 'PLCInputBool' },
    TargetSpeed:           { type: 'number',  default: 100 },
    Acceleration:          { type: 'number',  default: 100 },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    CurrentPositionOffset: { type: 'number',  default: 0 },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_Gear: {
    MasterDrive: { type: 'componentRef' },
    GearFactor: { type: 'number', default: 1 },
    Offset: { type: 'number', default: 0 },
  },

  Drive_FollowPosition: {
    Position:        { type: 'componentRef', signal: 'PLCOutputFloat' },
    CurrentPosition: { type: 'componentRef', signal: 'PLCInputFloat' },
    Offset:                { type: 'number',  default: 0 },
    Scale:                 { type: 'number',  default: 1 },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_DestinationMotor: {
    StartDrive:      { type: 'componentRef', signal: 'PLCOutputBool' },
    Destination:     { type: 'componentRef', signal: 'PLCOutputFloat' },
    TargetSpeed:     { type: 'componentRef', signal: 'PLCOutputFloat' },
    Acceleration:    { type: 'componentRef', signal: 'PLCOutputFloat' },
    IsAtPosition:    { type: 'componentRef', signal: 'PLCInputFloat' },
    IsAtSpeed:       { type: 'componentRef', signal: 'PLCInputFloat' },
    IsAtDestination: { type: 'componentRef', signal: 'PLCInputBool' },
    IsDriving:       { type: 'componentRef', signal: 'PLCInputBool' },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    CurrentPositionOffset: { type: 'number',  default: 0 },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_PositionSwitch: {
    OutputSignal:  { type: 'componentRef', signal: 'PLCInputBool' },
    InvertAreas:   { type: 'boolean', default: false },
    PositionOffset: { type: 'number', default: 0 },
  },

  Drive_ErraticPosition: {
    MinPos: { type: 'number', default: 0 },
    MaxPos: { type: 'number', default: 100 },
    Speed: { type: 'number', default: 100 },
    IterateBetweenMaxAndMin: { type: 'boolean', default: false },
    SignalEnable: { type: 'componentRef' },
  },

  Sensor: {
    UseRaycast: { type: 'boolean', default: false },
    RayCastDirection: { type: 'vector3', unityCoords: true },
    RayCastLength: { type: 'number', default: 1000 },
    SensorOccupied: { type: 'componentRef', signal: 'PLCInputBool' },
    SensorNotOccupied: { type: 'componentRef', signal: 'PLCInputBool' },
    AutoRay: { type: 'boolean', default: false },
    // plan-276 Phase 5 (intentional schema change, updated together with rv-odt.json):
    PhysicsMode: { type: 'boolean', default: false },
  },

  TransportSurface: {
    TransportDirection: { type: 'vector3', unityCoords: true },
    Radial: { type: 'boolean', default: false },
    TextureScale: { type: 'number', default: 1 },
    HeightOffsetOverride: { type: 'number', default: 0 },
    AnimateSurface: { type: 'boolean', default: true },
    DriveReference: { type: 'componentRef' },
    // plan-255 (intentional schema change, updated together with rv-odt.json):
    Accumulate: { type: 'boolean', default: true },
    MinGap: { type: 'number', default: 0 },
    // plan-276 Phase 4 (intentional schema change, updated together with rv-odt.json):
    PhysicsMode: { type: 'boolean', default: false },
  },

  Source: {
    AutomaticGeneration: { type: 'boolean', default: true },
    Interval: { type: 'number', default: 0, aliases: ['SpawnInterval'] },
    GenerateIfDistance: { type: 'number', default: 300, aliases: ['SpawnDistance'] },
    PlaceOnTransportSurface: { type: 'boolean', default: true },
    ThisObjectAsMU: { type: 'string', default: '' },
    // plan-394 — role handed to every MU this source spawns (rv_extras of a
    // clone are stripped, so the role cannot travel on the MU itself).
    CollisionRoleForMUs: {
      type: 'enum',
      enumMap: {
        None: 'None', Tool: 'Tool', Workpiece: 'Workpiece',
        Machine: 'Machine', Robot: 'Robot', Environment: 'Environment',
        // plan-409 — appended, never inserted (see COLLISION_ROLES).
        Cutter: 'Cutter',
      },
      default: 'None',
    },
  },

  Sink: {},

  Grip: {
    GripRange: { type: 'number', default: 50 },
    OneBitControl: { type: 'boolean', default: true },
    PlaceMode: { type: 'enum', enumMap: { Auto: 'Auto', Static: 'Static', Physics: 'Physics' }, default: 'Auto' },
    GripTargetSearchRadius: { type: 'number', default: 500 },
    SignalPick: { type: 'componentRef' },
    SignalPlace: { type: 'componentRef' },
    PartToGrip: { type: 'componentRef' },
  },

  GripTarget: {
    AlignPosition: { type: 'boolean', default: true },
    AlignRotation: { type: 'boolean', default: true },
  },

  ConnectSignal: {
    ConnectedSignal: { type: 'componentRef' },
  },

  // plan-328 - OnColor remains raw because the schema mapper deliberately
  // does not support object-valued properties.
  Lamp: {
    SignalLampOn:       { type: 'componentRef', signal: 'PLCOutputBool' },
    SingalLampFlashing: { type: 'componentRef', signal: 'PLCOutputBool', aliases: ['SignalLampFlashing'] },
    Intensity:          { type: 'number', default: 2 },
    Flashing:           { type: 'boolean', default: false },
    Period:             { type: 'number', default: 1 },
    LampOn:             { type: 'boolean', default: false },
  },

  // plan-417 — 3D scene buttons. The Unity classes use camelCase field names
  // (untypical for realvirtual), so the schema keys do too: schema key = GLB
  // extras key = C# field name, no conversion anywhere.
  SceneButtonBase: {
    moveable:        { type: 'componentRef' },
    autoLight:       { type: 'boolean', default: true },
    isToggle:        { type: 'boolean', default: false },
    simpleClickTime: { type: 'number', default: 0.5 },
  },

  SceneButtonMoveable: {
    axis:              { type: 'vector3', unityCoords: true },
    moveSpeed:         { type: 'number', default: 30 },
    hoverOffset:       { type: 'number', default: 0.1 },
    activeOffset:      { type: 'number', default: 0.05 },
    mirrorHoverOffset: { type: 'boolean', default: false },
    angularMovement:   { type: 'boolean', default: false },
  },

  PushButton3D: {
    stateSignal:   { type: 'componentRef', signal: 'PLCInputBool' },
    lightSignal:   { type: 'componentRef', signal: 'PLCOutputBool' },
    label:         { type: 'string' },
    timer:         { type: 'number', default: 0.5 },
    toggle:        { type: 'boolean', default: false },
    activeOnStart: { type: 'boolean', default: false },
  },

  EmergencyButton3D: {
    stateSignal:   { type: 'componentRef', signal: 'PLCInputBool' },
    activeOnStart: { type: 'boolean', default: false },
  },

  HandleSwitch3D: {
    stateSignal:   { type: 'componentRef', signal: 'PLCInputBool' },
    activeOnStart: { type: 'boolean', default: false },
  },

  // plan-362. Anchor/Follower are plain NODE refs (Unity `public Transform`),
  // not signal slots — hence no `signal` key. `readonly` because structural
  // references are not editable in the inspector; they are corrected through
  // `web_editor_set_field`, which the component resolves live.
  EnergyChain: {
    Anchor:      { type: 'componentRef', readonly: true },
    Follower:    { type: 'componentRef', readonly: true },
    BendRadius:  { type: 'number', default: 0 },
    ChainLength: { type: 'number', default: 0 },
    Axis:        { type: 'enum', enumMap: { Auto: 'Auto', X: 'X', Y: 'Y', Z: 'Z' }, default: 'Auto' },
    BendUp:      { type: 'boolean', default: true },
    Bones:       { type: 'number', default: 24 },
    Enabled:     { type: 'boolean', default: true },
  },

  // plan-394 — collision role marker. Added AFTER the rv-ODT migration: not a
  // pre-migration snapshot but the frozen reference for the determinism test.
  CollisionRole: {
    CollisionRole: {
      type: 'enum',
      enumMap: {
        None: 'None', Tool: 'Tool', Workpiece: 'Workpiece',
        Machine: 'Machine', Robot: 'Robot', Environment: 'Environment',
        // plan-409 — appended, never inserted (see COLLISION_ROLES).
        Cutter: 'Cutter',
      },
      default: 'None',
    },
  },

  // plan-405 — CSG material removal. Added AFTER the rv-ODT migration: not a
  // pre-migration snapshot but the frozen reference for the determinism test.
  // `Shape` is readonly on BOTH components on purpose: the bare field name is
  // shared, and the generic enum editor is indexed by the bare name, so a
  // writable row would offer the other component's options.
  MachiningVolume: {
    gridResolution: { type: 'vector3', default: { x: 64, y: 64, z: 64 } },
    workpieceSize: { type: 'vector3', default: { x: 200, y: 100, z: 200 } },
    Shape: {
      type: 'enum',
      enumMap: { Box: 'Box', Cylinder: 'Cylinder', Mesh: 'Mesh' },
      default: 'Box',
      readonly: true,
    },
    CylinderAxis: {
      type: 'enum',
      enumMap: { X: 'X', Y: 'Y', Z: 'Z' },
      default: 'X',
    },
    Tools: { type: 'componentRefArray', default: [] },
    ToolGroup: { type: 'string', default: '' },
    SweepToolMotion: { type: 'boolean', default: true },
    MaxSweepSubsteps: { type: 'number', default: 16 },
    Meshing: {
      type: 'enum',
      enumMap: { MarchingCubes: 'MarchingCubes', DualContouring: 'DualContouring' },
      default: 'MarchingCubes',
    },
    CreaseAngle: { type: 'number', default: 35 },
    GenerateUVs: { type: 'boolean', default: true },
    StatisticsInterval: { type: 'number', default: 0.25 },
    UpdateCollider: { type: 'boolean', default: false, readonly: true },
    SignalSpindleOn: { type: 'componentRef', signal: 'PLCOutputBool' },
    SignalReset: { type: 'componentRef', signal: 'PLCOutputBool' },
    SignalMachiningActive: { type: 'componentRef', signal: 'PLCInputBool' },
  },

  MachiningTool: {
    Shape: {
      type: 'enum',
      enumMap: {
        Sphere: 'Sphere', Cylinder: 'Cylinder', BallNose: 'BallNose',
        Torus: 'Torus', ConicalEnd: 'ConicalEnd',
      },
      default: 'Cylinder',
      readonly: true,
    },
    ToolDiameter: { type: 'number', default: 10 },
    ToolLength: { type: 'number', default: 50 },
    CornerRadius: { type: 'number', default: 2 },
    TaperAngleDeg: { type: 'number', default: 15 },
  },

  WebSensor: {
    SignalBool:  { type: 'componentRef' },
    SignalInt:   { type: 'componentRef' },
    IntStateMap: { type: 'string', default: '' },
    Label:       { type: 'string', default: '' },
  },

  // plan-253 — added AFTER the rv-ODT migration: not a pre-migration snapshot
  // but the frozen reference for the spec-loading determinism test.
  WebDiagnostics: {
    SignalBool: { type: 'componentRef' },
    SignalInt:  { type: 'componentRef' },
    DocFilter:  { type: 'string', default: '' },
    ErrorId:    { type: 'string', default: '' },
    Label:      { type: 'string', default: '' },
    AutoOpen:   { type: 'boolean', default: true },
  },

  WebSafetyDoor: {
    HazardZoneRadius: { type: 'number', default: 1500 },
    LabelHeight:      { type: 'number', default: 200 },
  },

  // plan-276: physics zone (StaticColliders is a rawFields string array,
  // captured raw in rv-physics-zone.ts — deliberately NOT a schema field).
  WebPhysicsZone: {
    ZoneEnabled:  { type: 'boolean', default: true },
    WholeScene:   { type: 'boolean', default: false },
    Friction:     { type: 'number',  default: 0.8 },
    Restitution:  { type: 'number',  default: 0 },
    RemoveBelowY: { type: 'number',  default: -10 },
    ShowGizmo:    { type: 'boolean', default: true },
  },

  WebError: {
    SignalError: { type: 'componentRef' },
    ErrorText:   { type: 'string', default: '' },
    HighlightStyle: {
      type: 'enum',
      enumMap: {
        Auto: 'Auto', FlashObject: 'FlashObject', Circle: 'Circle',
        '0': 'Auto', '1': 'FlashObject', '2': 'Circle',
      },
      default: 'Auto',
    },
  },

  WebVisibility: {
    SignalVisible:  { type: 'componentRef' },
    InvertSignal:   { type: 'boolean', default: false },
    DefaultVisible: { type: 'boolean', default: true },
    AdditionalTargets: { type: 'componentRefArray', default: [] },
    SignalError: { type: 'componentRef' },
    ErrorText:   { type: 'string', default: '' },
    HighlightStyle: {
      type: 'enum',
      enumMap: {
        Auto: 'Auto', FlashObject: 'FlashObject', Circle: 'Circle',
        '0': 'Auto', '1': 'FlashObject', '2': 'Circle',
      },
      default: 'Auto',
    },
    BlinkSpeed: { type: 'number', default: 2 },
  },

  CustomRuntimeInstruction: {
    type: {
      type: 'enum',
      enumMap: {
        Info: 'info', Maintenance: 'maintenance', Warning: 'warning', Error: 'error', Success: 'success',
        '0': 'info', '1': 'maintenance', '2': 'warning', '3': 'error', '4': 'success',
      },
      default: 'info',
    },
    dismissible: { type: 'boolean', default: true },
    Isolate: { type: 'boolean', default: false },
    signal: { type: 'componentRef' },
    BlinkSpeed: { type: 'number', default: 2 },
  },

  RuntimeMetadata: {
    content: { type: 'string', default: '' },
  },

  IKPath: {
    SpeedOverride:   { type: 'number',  default: 1 },
    SetNewTCP:       { type: 'boolean', default: false },
    DrawPath:        { type: 'boolean', default: true },
    DrawTargets:     { type: 'boolean', default: true },
    DebugPath:       { type: 'boolean', default: false },
    DebugBlending:   { type: 'boolean', default: false },
    StartPath:       { type: 'boolean', default: false },
    LoopPath:        { type: 'boolean', default: false },
    SignalStart:     { type: 'componentRef' },
    SignalIsStarted: { type: 'componentRef' },
    SignalEnded:     { type: 'componentRef' },
    Path:            { type: 'componentRefArray' },
  },

  IKTarget: {
    FollowInEditMode:     { type: 'boolean', default: true },
    SpeedToTarget:        { type: 'number',  default: 1 },
    LinearAcceleration:   { type: 'number',  default: 100 },
    InterpolationToTarget: { type: 'enum', enumMap: {
      PointToPoint: 'PointToPoint',
      PointToPointUnsynced: 'PointToPointUnsynced',
      Linear: 'Linear',
    }, default: 'PointToPoint' },
    LinearSpeedToTarget:  { type: 'number',  default: 500 },
    TurnCorrection:       { type: 'boolean', default: false },
    SetSignalDuration:    { type: 'number',  default: 0.5 },
    WaitForSeconds:       { type: 'number',  default: 0 },
    PickAndPlace:         { type: 'boolean', default: false },
    Pick:                 { type: 'boolean', default: false },
    Place:                { type: 'boolean', default: false },
    EnableBlending:       { type: 'boolean', default: false },
    BlendRadius:          { type: 'number',  default: 25 },
    SetSignal:            { type: 'componentRef' },
    WaitForSignal:        { type: 'componentRef' },
  },

  RobotIK: {
    WristType: { type: 'enum', enumMap: { Spherical: 'Spherical', NonSpherical: 'NonSpherical' }, default: 'Spherical', readonly: true },
    ElbowInUnityX: { type: 'boolean', default: false, readonly: true },
    DrawGizmos: { type: 'boolean', default: true },
  },

  CADLink: {
    File:              { type: 'string',  default: '',         readonly: true },
    Sha256:            { type: 'string',  default: '',         readonly: true },
    Quality:           { type: 'string',  default: 'standard', readonly: true },
    ImportScaleFactor: { type: 'number',  default: 0.001,      readonly: true },
    ZIsUpVector:       { type: 'boolean', default: true,       readonly: true },
  },

  // Read-only CAD metadata written by the rv-jt reader (plan-335). No defaults on purpose:
  // every field is optional and the reader omits what the source file does not provide, so a
  // default would invent a value the file never carried.
  JTData: {
    ContractVersion: { type: 'number', readonly: true },
    PartName:        { type: 'string', readonly: true },
    Mass:            { type: 'number', readonly: true },
    MassSource:      { type: 'string', readonly: true },
    SourceUnits:     { type: 'string', readonly: true },
    Layer:           { type: 'string', readonly: true },
    BodyUid:         { type: 'string', readonly: true },
  },

  Pipe: {
    resourceName: { type: 'string', default: '' },
    flowRate: { type: 'number', default: 0 },
    source: { type: 'componentRef' },
    destination: { type: 'componentRef' },
    uvDirection: { type: 'number', default: 1 },
    circuitId: { type: 'number', default: -1 },
    pressure: { type: 'number', default: 0 },
    temperatureC: { type: 'number', default: 0 },
    velocityMs: { type: 'number', default: 0 },
    dnSize: { type: 'number', default: 0 },
  },

  Pump: {
    flowRate: { type: 'number', default: 0 },
    pipe: { type: 'componentRef' },
    circuitId: { type: 'number', default: -1 },
    resourceName: { type: 'string', default: '' },
    state: { type: 'string', default: 'ok' },
    suctionPressure: { type: 'number', default: 0 },
    dischargePressure: { type: 'number', default: 0 },
    speedRpm: { type: 'number', default: 0 },
    speedPercent: { type: 'number', default: 0 },
    powerKw: { type: 'number', default: 0 },
    currentA: { type: 'number', default: 0 },
    bearingTempC: { type: 'number', default: 0 },
    motorTempC: { type: 'number', default: 0 },
    vibrationMmS: { type: 'number', default: 0 },
    npshAvailable: { type: 'number', default: 0 },
    npshRequired: { type: 'number', default: 0 },
    runHours: { type: 'number', default: 0 },
  },

  ResourceTank: {
    resourceName: { type: 'string', default: '' },
    capacity: { type: 'number', default: 0 },
    amount: { type: 'number', default: 0 },
    pressure: { type: 'number', default: 0 },
    temperature: { type: 'number', default: 0 },
    density: { type: 'number', default: 0 },
    ph: { type: 'number', default: 0 },
    agitatorOn: { type: 'boolean', default: false },
    heatingOn: { type: 'boolean', default: false },
    tempHighLimit: { type: 'number', default: 0 },
    tempLowLimit: { type: 'number', default: 0 },
    pressureHighLimit: { type: 'number', default: 0 },
  },

  ProcessingUnit: {
    connections: { type: 'componentRefArray' },
    state: { type: 'string', default: 'idle' },
    availability: { type: 'number', default: 0 },
    performance: { type: 'number', default: 0 },
    quality: { type: 'number', default: 0 },
    cycleTimeS: { type: 'number', default: 0 },
    cycleTargetS: { type: 'number', default: 0 },
    throughputPerHour: { type: 'number', default: 0 },
    goodCount: { type: 'number', default: 0 },
    scrapCount: { type: 'number', default: 0 },
    mtbfHours: { type: 'number', default: 0 },
    mttrMinutes: { type: 'number', default: 0 },
    runHours: { type: 'number', default: 0 },
    downHours: { type: 'number', default: 0 },
    lastFault: { type: 'string', default: '' },
  },
  Group: {
    GroupName: { type: 'string', default: 'Group' },
    GroupNamePrefix: { type: 'string', readonly: true },
  },

  // Path (plan-268) — scalar fields only; the structured fields
  // (segments/successors/align) are parsed by parsePathExtras() in rv-path.ts
  // (the executable TS-SSOT); they are declared as generic 'json' schema fields
  // (plan-921) so the inspector / overlay editor / MCP tools can author them.
  Path: {
    version: { type: 'number', default: 1 },
    id: { type: 'string' },
    segments: { type: 'json', default: [] },
    closed: { type: 'boolean', default: false },
    successors: { type: 'json', default: [] },
    align: { type: 'json', default: [0, 1, 0] },
    zone: { type: 'string' },
    zoneCapacity: { type: 'number' },
  },

  // plan-404 — rigid-body mechanisms. Added AFTER the rv-ODT migration: not a
  // pre-migration snapshot but the frozen reference for the determinism test.
  // NOTE these are the RIGID-BODY types (joint graph + constraint solve), not
  // the older axis-group `Kinematic` component under `structure`.
  KinematicMechanism: {
    SolverIterations: { type: 'number', default: 4 },
    Damping:          { type: 'number', default: 0.01 },
    Tolerance:        { type: 'number', default: 0.001 },
    SignalConverged:  { type: 'componentRef', signal: 'PLCOutputBool' },
    Converged:        { type: 'boolean', default: true, readonly: true },
    ResidualError:    { type: 'number', default: 0, readonly: true },
    SolveTimeMs:      { type: 'number', default: 0, readonly: true },
  },

  KinematicJoint: {
    JointType: {
      type: 'enum',
      enumMap: {
        Revolute: 'Revolute', Prismatic: 'Prismatic',
        Spherical: 'Spherical', Universal: 'Universal',
      },
      default: 'Revolute',
    },
    // BodyA absent = world anchor (plan-404 §2.4); the schema cannot express
    // that, the READ side must — see rv-kinematic-mechanism.ts.
    BodyA:          { type: 'componentRef' },
    BodyB:          { type: 'componentRef' },
    AnchorA:        { type: 'vector3', unityCoords: true },
    AnchorB:        { type: 'vector3', unityCoords: true },
    AxisA:          { type: 'vector3', unityCoords: true },
    SecondaryAxisB: { type: 'vector3', unityCoords: true },
    UseLimits:      { type: 'boolean', default: false },
    LowerLimit:     { type: 'number', default: -180 },
    UpperLimit:     { type: 'number', default: 180 },
    DrivenBy:       { type: 'componentRef' },
    CurrentValue:   { type: 'number', default: 0, readonly: true },
  },

  KinematicTarget: {
    Mechanism:      { type: 'componentRef' },
    TargetLink:     { type: 'componentRef' },
    TrackingActive: { type: 'boolean', default: false },
    Reachable:      { type: 'boolean', default: true, readonly: true },
  },

  // plan-412 — per-link mass properties for the inverse-dynamics force analysis. No default for
  // the two overrides: an ABSENT key means "use the value computed from the geometry", which is
  // a different statement from "zero" and the one the exporter has to be able to write back.
  MechanismBody: {
    DensityPreset: {
      type: 'enum',
      default: 'steel',
      enumMap: {
        steel: 'steel', stainless: 'stainless', aluminum: 'aluminum',
        pa: 'pa', pom: 'pom', custom: 'custom',
      },
    },
    DensityKgM3:        { type: 'number', default: 7850 },
    MassOverrideKg:     { type: 'number' },
    ComOverrideLocalMm: { type: 'vector3', unityCoords: true },
    MassSource:         { type: 'string', default: 'mesh', readonly: true },
  },
};

/** All in-scope rv-ODT v1 component registry keys. */
export const ODT_V1_COMPONENT_KEYS = Object.keys(INLINE_SCHEMA_BASELINE);
