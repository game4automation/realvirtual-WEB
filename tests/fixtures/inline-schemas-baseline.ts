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
 *
 * plan-512: the loader now carries the `unit` keyword of number fields and the
 * `signalUnit` / `scaleField` keywords of signal slots into the descriptor —
 * an intentional schema change, applied here field by field.
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
    Offset: { type: 'number', default: 0, unit: 'mm' },
    StartPosition: { type: 'number', default: 0, unit: 'mm' },
    TargetSpeed: { type: 'number', default: 100, unit: 'mm/s' },
    Acceleration: { type: 'number', default: 100, unit: 'mm/s2' },
    UseAcceleration: { type: 'boolean', default: false },
    // plan-281 Phase 4 — jerk-limited motion. Intentional schema change: spec
    // and baseline updated together, as this file's header prescribes.
    SmoothAcceleration: { type: 'boolean', default: false },
    Jerk: { type: 'number', default: 1000, unit: 'mm/s3' },
    SpeedOverride: { type: 'number', default: 1 },
    JumpToLowerLimitOnUpperLimit: { type: 'boolean', default: false },
    UseLimits: { type: 'boolean', default: false },
    LowerLimit: { type: 'number', default: -180, unit: 'mm' },
    UpperLimit: { type: 'number', default: 180, unit: 'mm' },
    JogForward: { type: 'boolean', default: false },
    JogBackward: { type: 'boolean', default: false },
    TargetPosition: { type: 'number', default: 0, unit: 'mm' },
  },

  Drive_Simple: {
    Speed:        { type: 'componentRef', signal: 'PLCOutputFloat', signalUnit: '@drive-speed', scaleField: 'ScaleSpeed' },
    Accelaration: { type: 'componentRef', signal: 'PLCOutputFloat', signalUnit: '@drive-acceleration', scaleField: 'ScaleSpeed' },
    Forward:      { type: 'componentRef', signal: 'PLCOutputBool' },
    Backward:     { type: 'componentRef', signal: 'PLCOutputBool' },
    IsAtPosition: { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: '@drive-position', scaleField: 'CurrentPositionScale' },
    IsAtSpeed:    { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: '@drive-speed', scaleField: 'ScaleSpeed' },
    IsDriving:    { type: 'componentRef', signal: 'PLCInputBool' },
    Enable:       { type: 'componentRef', signal: 'PLCOutputBool' },
    ScaleSpeed:            { type: 'number',  default: 1 },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    CurrentPositionOffset: { type: 'number',  default: 0, unit: 'mm' },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_Cylinder: {
    MinPos: { type: 'number', default: 0, unit: 'mm' },
    MaxPos: { type: 'number', default: 100, unit: 'mm' },
    TimeOut: { type: 'number', default: 1, unit: 's' },
    TimeIn: { type: 'number', default: 1, unit: 's' },
    OneBitCylinder: { type: 'boolean', default: false },
    InvertOutputLogic: { type: 'boolean', default: false },
    // plan-570 F3 — valve mode (intentional schema change, updated together with rv-odt.json).
    Mode: { type: 'enum', enumMap: { Legacy: 'Legacy', DoubleActing: 'DoubleActing', SingleActingPositive: 'SingleActingPositive', SingleActingNegative: 'SingleActingNegative' }, default: 'Legacy' },
    Out: { type: 'componentRef', signal: 'PLCOutputBool' },
    In: { type: 'componentRef', signal: 'PLCOutputBool' },
    IsOut: { type: 'componentRef', signal: 'PLCInputBool' },
    IsIn: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMax: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMin: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMovingOut: { type: 'componentRef', signal: 'PLCInputBool' },
    IsMovingIn: { type: 'componentRef', signal: 'PLCInputBool' },
    // plan-538 F3 — optional motion enable (intentional schema change).
    Enable: { type: 'componentRef', signal: 'PLCOutputBool' },
  },

  Drive_Speed: {
    SignalTargetSpeed:     { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalAcceleration:    { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalCurrentSpeed:    { type: 'componentRef', signal: 'PLCInputFloat' },
    SignalCurrentPosition: { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: '@drive-position', scaleField: 'CurrentPositionScale' },
    SignalIsDriving:       { type: 'componentRef', signal: 'PLCInputBool' },
    TargetSpeed:           { type: 'number',  default: 100, unit: 'mm/s' },
    Acceleration:          { type: 'number',  default: 100, unit: 'mm/s2' },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    CurrentPositionOffset: { type: 'number',  default: 0, unit: 'mm' },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  // plan-457 — port of Drive_SEWMovilink.cs (SEW MOVILINK unit profile).
  Drive_SEWMovilink: {
    ControlWord1:  { type: 'componentRef', signal: 'PLCOutputInt' },
    SpeedSetpoint: { type: 'componentRef', signal: 'PLCOutputInt' },
    StatusWord1:   { type: 'componentRef', signal: 'PLCInputInt' },
    SpeedActual:   { type: 'componentRef', signal: 'PLCInputInt' },
    MaxSpeed:      { type: 'number',  default: 100, unit: 'mm/s' },
    Encoding:      { type: 'enum',    default: 'PercentNmax', enumMap: { PercentNmax: 'PercentNmax', Rpm: 'Rpm' } },
    MaxSpeedRpm:   { type: 'number',  default: 3000 },
    Acceleration:  { type: 'number',  default: 1000, unit: 'mm/s2' },
    SimulateFault: { type: 'boolean', default: false },
    FaultCode:     { type: 'number',  default: 6 },
  },

  // Port of Drive_ContinousDestination.cs (destination change starts the move).
  Drive_ContinousDestination: {
    Destination: { type: 'number', default: 0, unit: 'mm' },
    Acceleration: { type: 'number', default: 100, unit: 'mm/s2' },
    TargetSpeed: { type: 'number', default: 100, unit: 'mm/s' },
    CurrentPositionScale: { type: 'number', default: 1 },
    CurrentPositionOffset: { type: 'number', default: 0, unit: 'mm' },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
    SignalDestination: { type: 'componentRef', signal: 'PLCOutputFloat', signalUnit: '@drive-position', scaleField: 'CurrentPositionScale' },
    SignalAcceleration: { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalTargetSpeed: { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalIsAtPosition: { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: '@drive-position', scaleField: 'CurrentPositionScale' },
    SignalIsAtSpeed: { type: 'componentRef', signal: 'PLCInputFloat' },
    SignalIsAtDestination: { type: 'componentRef', signal: 'PLCInputBool' },
    SignalIsDriving: { type: 'componentRef', signal: 'PLCInputBool' },
  },

  // Port of DrivePulseEncoder.cs (incremental pulse encoder on a Drive node).
  DrivePulseEncoder: {
    PulseIntervall: { type: 'number', default: 0, unit: 'mm' },
    Offset: { type: 'number', default: 0, unit: 'mm' },
    PulseEncoderSignal: { type: 'componentRef', signal: 'PLCInputBool' },
  },

  // Port of Drive_ProfidriveSpeed.cs (PROFIdrive telegram 1).
  Drive_ProfidriveSpeed: {
    ReferenceSpeed: { type: 'number', default: 100, unit: 'mm/s' },
    SetpointScale: { type: 'number', default: 16384 },
    Acceleration: { type: 'number', default: 1000, unit: 'mm/s2' },
    SimulateFault: { type: 'boolean', default: false },
    SimulateWarning: { type: 'boolean', default: false },
    ControlWord: { type: 'componentRef', signal: 'PLCOutputInt' },
    SpeedSetpoint: { type: 'componentRef', signal: 'PLCOutputInt' },
    StatusWord: { type: 'componentRef', signal: 'PLCInputInt' },
    SpeedActual: { type: 'componentRef', signal: 'PLCInputInt' },
  },

  // Port of Drive_ProfidrivePos.cs (PROFIdrive telegram 111 / EPOS).
  Drive_ProfidrivePos: {
    PositionScale: { type: 'number', default: 1 },
    PositionOffset: { type: 'number', default: 0, unit: 'mm' },
    VelocityScale: { type: 'number', default: 1 },
    ReferenceSpeed: { type: 'number', default: 100, unit: 'mm/s' },
    JogSpeed: { type: 'number', default: 50, unit: 'mm/s' },
    Acceleration: { type: 'number', default: 1000, unit: 'mm/s2' },
    SimulateFault: { type: 'boolean', default: false },
    SimulateWarning: { type: 'boolean', default: false },
    ControlWord: { type: 'componentRef', signal: 'PLCOutputInt' },
    PosControlWord1: { type: 'componentRef', signal: 'PLCOutputInt' },
    PosControlWord2: { type: 'componentRef', signal: 'PLCOutputInt' },
    Override: { type: 'componentRef', signal: 'PLCOutputInt' },
    MdiTargetPosition: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-position', scaleField: 'PositionScale' },
    MdiVelocity: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-speed', scaleField: 'VelocityScale' },
    StatusWord: { type: 'componentRef', signal: 'PLCInputInt' },
    PosStatusWord1: { type: 'componentRef', signal: 'PLCInputInt' },
    PosStatusWord2: { type: 'componentRef', signal: 'PLCInputInt' },
    PositionActual: { type: 'componentRef', signal: 'PLCInputInt', signalUnit: '@drive-position', scaleField: 'PositionScale' },
    SpeedActual: { type: 'componentRef', signal: 'PLCInputInt' },
  },

  // Port of Drive_FestoFHPP.cs (Festo Handling and Positioning Profile).
  Drive_FestoFHPP: {
    PositionScale: { type: 'number', default: 1 },
    PositionOffset: { type: 'number', default: 0, unit: 'mm' },
    BaseVelocity: { type: 'number', default: 100, unit: 'mm/s' },
    JogSpeed: { type: 'number', default: 50, unit: 'mm/s' },
    Acceleration: { type: 'number', default: 1000, unit: 'mm/s2' },
    Records: { type: 'json', default: [] },
    SimulateFault: { type: 'boolean', default: false },
    SimulateWarning: { type: 'boolean', default: false },
    Ccon: { type: 'componentRef', signal: 'PLCOutputInt' },
    Cpos: { type: 'componentRef', signal: 'PLCOutputInt' },
    RecordOrCdir: { type: 'componentRef', signal: 'PLCOutputInt' },
    VelocityPercent: { type: 'componentRef', signal: 'PLCOutputInt' },
    TargetPosition: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-position', scaleField: 'PositionScale' },
    Scon: { type: 'componentRef', signal: 'PLCInputInt' },
    Spos: { type: 'componentRef', signal: 'PLCInputInt' },
    RecordOrSdir: { type: 'componentRef', signal: 'PLCInputInt' },
    PositionActual: { type: 'componentRef', signal: 'PLCInputInt', signalUnit: '@drive-position', scaleField: 'PositionScale' },
  },

  // Port of Drive_UniDriveMotor.cs (UniDrive-style positioning controller).
  Drive_UniDriveMotor: {
    PositionScale: { type: 'number', default: 1 },
    PositionOffset: { type: 'number', default: 0, unit: 'mm' },
    SpeedScale: { type: 'number', default: 1 },
    AccelerationScale: { type: 'number', default: 1 },
    SetupSpeed: { type: 'number', default: 50, unit: 'mm/s' },
    Ready: { type: 'boolean', default: true },
    Referenced: { type: 'boolean', default: true },
    Run: { type: 'componentRef', signal: 'PLCOutputBool' },
    JogPlus: { type: 'componentRef', signal: 'PLCOutputBool' },
    JogMinus: { type: 'componentRef', signal: 'PLCOutputBool' },
    StartCalibration: { type: 'componentRef', signal: 'PLCOutputBool' },
    SpeedSelection: { type: 'componentRef', signal: 'PLCOutputBool' },
    StartPositioning: { type: 'componentRef', signal: 'PLCOutputBool' },
    ResetFault: { type: 'componentRef', signal: 'PLCOutputBool' },
    SetPosition: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-position', scaleField: 'PositionScale' },
    SetSpeed: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-speed', scaleField: 'SpeedScale' },
    SetAcceleration: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-acceleration', scaleField: 'AccelerationScale' },
    SetDeceleration: { type: 'componentRef', signal: 'PLCOutputInt', signalUnit: '@drive-acceleration', scaleField: 'AccelerationScale' },
    IsReady: { type: 'componentRef', signal: 'PLCInputBool' },
    IsReferenced: { type: 'componentRef', signal: 'PLCInputBool' },
    IsAtPosition1: { type: 'componentRef', signal: 'PLCInputBool' },
    ActualPosition: { type: 'componentRef', signal: 'PLCInputInt', signalUnit: '@drive-position', scaleField: 'PositionScale' },
    ActualSpeed: { type: 'componentRef', signal: 'PLCInputInt', signalUnit: '@drive-speed', scaleField: 'SpeedScale' },
  },

  // Port of Drive_ProportionalValve.cs (FlowCurve → FlowExponent, the curve does not travel through GLB).
  Drive_ProportionalValve: {
    Setpoint: { type: 'number', default: 0 },
    SetpointZero: { type: 'number', default: 0 },
    SetpointFull: { type: 'number', default: 10 },
    Deadband: { type: 'number', default: 0.05 },
    EnableHysteresis: { type: 'boolean', default: false },
    Hysteresis: { type: 'number', default: 0.02 },
    FlowExponent: { type: 'number', default: 1 },
    ResponseTime: { type: 'number', default: 0.1, unit: 's' },
    MaxSpeed: { type: 'number', default: 100, unit: 'mm/s' },
    Acceleration: { type: 'number', default: 1000, unit: 'mm/s2' },
    SignalSetpoint: { type: 'componentRef', signal: 'PLCOutputFloat' },
    SignalSpoolPosition: { type: 'componentRef', signal: 'PLCInputFloat' },
    SignalCurrentSpeed: { type: 'componentRef', signal: 'PLCInputFloat' },
    SignalCurrentPosition: { type: 'componentRef', signal: 'PLCInputFloat' },
  },

  Drive_Gear: {
    MasterDrive: { type: 'componentRef' },
    GearFactor: { type: 'number', default: 1 },
    Offset: { type: 'number', default: 0, unit: 'mm' },
  },

  Drive_FollowPosition: {
    Position:        { type: 'componentRef', signal: 'PLCOutputFloat', signalUnit: '@drive-position', scaleField: 'Scale' },
    CurrentPosition: { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: '@drive-position', scaleField: 'Scale' },
    Offset:                { type: 'number',  default: 0, unit: 'mm' },
    Scale:                 { type: 'number',  default: 1 },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_DestinationMotor: {
    StartDrive:      { type: 'componentRef', signal: 'PLCOutputBool' },
    Destination:     { type: 'componentRef', signal: 'PLCOutputFloat', signalUnit: '@drive-position', scaleField: 'CurrentPositionScale' },
    TargetSpeed:     { type: 'componentRef', signal: 'PLCOutputFloat' },
    Acceleration:    { type: 'componentRef', signal: 'PLCOutputFloat' },
    IsAtPosition:    { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: '@drive-position', scaleField: 'CurrentPositionScale' },
    IsAtSpeed:       { type: 'componentRef', signal: 'PLCInputFloat' },
    IsAtDestination: { type: 'componentRef', signal: 'PLCInputBool' },
    IsDriving:       { type: 'componentRef', signal: 'PLCInputBool' },
    CurrentPositionScale:  { type: 'number',  default: 1 },
    CurrentPositionOffset: { type: 'number',  default: 0, unit: 'mm' },
    ScaleFeedbackPosition: { type: 'boolean', default: true },
  },

  Drive_PositionSwitch: {
    OutputSignal:  { type: 'componentRef', signal: 'PLCInputBool' },
    InvertAreas:   { type: 'boolean', default: false },
    PositionOffset: { type: 'number', default: 0, unit: 'mm' },
  },

  Drive_ErraticPosition: {
    MinPos: { type: 'number', default: 0, unit: 'mm' },
    MaxPos: { type: 'number', default: 100, unit: 'mm' },
    Speed: { type: 'number', default: 100, unit: 'mm/s' },
    IterateBetweenMaxAndMin: { type: 'boolean', default: false },
    SignalEnable: { type: 'componentRef' },
  },

  Sensor: {
    LimitSensorToTag: { type: 'string', default: '' },
    ShowGizmo: { type: 'boolean', default: true },
    UseRaycast: { type: 'boolean', default: false },
    RayCastDirection: { type: 'vector3', unityCoords: true },
    RayCastLength: { type: 'number', default: 1000, unit: 'mm' },
    // plan-2016 S6c (intentional schema change, updated together with rv-odt.json):
    AdditionalRayCastLayers: { type: 'json', default: [] },
    SensorOccupied: { type: 'componentRef', signal: 'PLCInputBool' },
    SensorNotOccupied: { type: 'componentRef', signal: 'PLCInputBool' },
    AutoRay: { type: 'boolean', default: false },
    // plan-276 Phase 5 (intentional schema change, updated together with rv-odt.json):
    PhysicsMode: { type: 'boolean', default: false },
  },

  // plan-2016 S5 (new component, added together with rv-odt.json):
  MUSwitcher: {
    SwitchToGroup: { type: 'string', default: '' },
  },

  // plan-2016 S6b (new component, added together with rv-odt.json):
  MUPusher: {
    Drive: { type: 'componentRef' },
    Pusher: { type: 'componentRef' },
    Sensor: { type: 'componentRef' },
    ReleasePosition: { type: 'number', default: 0, unit: 'mm' },
    ReleaseSurface: { type: 'componentRef' },
  },

  TransportStopper: {
    Enabled: { type: 'boolean', default: true },
    Center: { type: 'vector3', default: { x: 0, y: 0, z: 0 } },
    Size: { type: 'vector3', default: { x: 100, y: 100, z: 100 } },
  },
  // plan-521 (intentional schema change, updated together with rv-odt.json):
  Zone: {
    Center: { type: 'vector3', default: { x: 0, y: 0, z: 0 } },
    Size: { type: 'vector3', default: { x: 100, y: 100, z: 100 } },
    Detect: { type: 'boolean', default: true },
    Block: { type: 'boolean', default: false },
    Hold: { type: 'boolean', default: false },
    Activation: { type: 'enum', enumMap: { Always: 'Always', Signal: 'Signal', Axis: 'Axis' }, default: 'Always' },
    ActivationSignal: { type: 'componentRef', signal: 'PLCOutputBool' },
    InvertSignal: { type: 'boolean', default: false },
    ActivationDrive: { type: 'componentRef' },
    AxisFrom: { type: 'number', default: 0 },
    AxisTo: { type: 'number', default: 0 },
    SignalOccupied: { type: 'componentRef', signal: 'PLCInputBool' },
    HoldAcquire: { type: 'enum', enumMap: { OnActivate: 'OnActivate', WhileActive: 'WhileActive' }, default: 'OnActivate' },
    HoldCount: { type: 'enum', enumMap: { All: 'All', One: 'One' }, default: 'All' },
    GripTargetSearchRadius: { type: 'number', default: 500, unit: 'mm' },
    ShowGizmo: { type: 'boolean', default: true },
    // plan-530 (intentional schema change, updated together with rv-odt.json):
    SingleRelease: { type: 'boolean', default: false },
  },
  TransportSurface: {
    TransportDirection: { type: 'vector3', unityCoords: true },
    Radial: { type: 'boolean', default: false },
    TextureScale: { type: 'number', default: 1 },
    HeightOffsetOverride: { type: 'number', default: 0, unit: 'mm' },
    AnimateSurface: { type: 'boolean', default: true },
    DriveReference: { type: 'componentRef' },
    // plan-255 (intentional schema change, updated together with rv-odt.json):
    Accumulate: { type: 'boolean', default: true },
    MinGap: { type: 'number', default: 0, unit: 'mm' },
    // Festo 2026-11-04 (intentional schema change; 35de9bb2 changed rv-odt.json without this line):
    VerticalReach: { type: 'number', default: 0, unit: 'mm', min: 0 },
    // plan-276 Phase 4 (intentional schema change, updated together with rv-odt.json):
    PhysicsMode: { type: 'boolean', default: false },
  },
  // plan-2016 Phase 3 (new component, updated together with rv-odt.json):
  TransportGuided: {
    Circular: { type: 'boolean', default: false },
    Length: { type: 'number', default: 1, unit: 'm', min: 0.0001 },
    Radius: { type: 'number', default: 1, unit: 'm', min: 0.0001 },
    Angle: { type: 'number', default: 90, unit: 'deg', min: -360, max: 360 },
    Height: { type: 'number', default: 0.5, unit: 'm', min: 0 },
    Width: { type: 'number', default: 0.5, unit: 'm', min: 0 },
    ColliderBorderX: { type: 'number', default: 0.2, unit: 'm', min: 0 },
    ColliderBorderZ: { type: 'number', default: 0.2, unit: 'm', min: 0 },
    DistanceCollider: { type: 'number', default: 0.005, unit: 'm', min: 0 },
  },

  Source: {
    Enabled: { type: 'boolean', default: true },
    GenerateMU: { type: 'boolean', default: true },
    DeleteAllMU: { type: 'boolean', default: false },
    StartInterval: { type: 'number', default: 0, unit: 's' },
    RandomDistance: { type: 'boolean', default: false },
    RangeDistance: { type: 'number', default: 300, unit: 'mm' },
    LimitNumber: { type: 'boolean', default: false },
    MaxNumberMUs: { type: 'number', default: 1 },
    Mass: { type: 'number', default: 1, unit: 'kg' },
    SourceGenerate: { type: 'componentRef', signal: 'PLCOutputBool' },
    SourceGenerateOnDistance: { type: 'componentRef', signal: 'PLCOutputBool' },
    AutomaticGeneration: { type: 'boolean', default: true },
    Interval: { type: 'number', default: 0, aliases: ['SpawnInterval'], unit: 's' },
    GenerateIfDistance: { type: 'number', default: 300, aliases: ['SpawnDistance'], unit: 'mm' },
    PlaceOnTransportSurface: { type: 'boolean', default: true },
    ThisObjectAsMU: { type: 'string', default: '' },
    // plan-2016 S1 (intentional schema change, updated together with rv-odt.json):
    Destination: { type: 'string', default: '' },
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

  Sink: {
    DeleteMus: { type: 'boolean', default: true },
    DeleteOnlyTag: { type: 'string', default: '' },
  },

  Grip: {
    GripRange: { type: 'number', default: 50, unit: 'mm' },
    OneBitControl: { type: 'boolean', default: true },
    PlaceMode: { type: 'enum', enumMap: { Auto: 'Auto', Static: 'Static', Physics: 'Physics' }, default: 'Auto' },
    GripTargetSearchRadius: { type: 'number', default: 500, unit: 'mm' },
    SignalPick: { type: 'componentRef' },
    SignalPlace: { type: 'componentRef' },
    PartToGrip: { type: 'componentRef' },
    // plan-2016 S4 (intentional schema change, updated together with rv-odt.json):
    DirectlyGrip: { type: 'boolean', default: false },
    PickAlignWithObject: { type: 'string', default: '' },
    AlignRotation: { type: 'boolean', default: true },
  },

  GripTarget: {
    AlignPosition: { type: 'boolean', default: true },
    AlignRotation: { type: 'boolean', default: true },
    // plan-577 F5 — place as a load of the MU below (intentional schema change, updated together with rv-odt.json).
    LoadOnCarrier: { type: 'boolean', default: false },
  },

  // plan-577 F1 — the MU marker's first consumed field (intentional schema change, updated together with rv-odt.json).
  MU: {
    LoadSeatDepth: { type: 'number', default: 0, unit: 'mm' },
  },

  ConnectSignal: {
    ConnectedSignal: { type: 'componentRef' },
  },

  // plan-2227 — SignalConnector: six typed signal slots + conversion options.
  SignalConnector: {
    Mode: { type: 'enum', enumMap: { Copy: 'Copy', IntToBool: 'IntToBool', BoolToInt: 'BoolToInt', BitFromWord: 'BitFromWord', BitToWord: 'BitToWord', Scale: 'Scale' }, default: 'Copy' },
    Enabled: { type: 'boolean', default: true },
    SourceBool: { type: 'componentRef', signal: 'PLCOutputBool' },
    SourceInt: { type: 'componentRef', signal: 'PLCOutputInt' },
    SourceFloat: { type: 'componentRef', signal: 'PLCOutputFloat' },
    TargetBool: { type: 'componentRef', signal: 'PLCInputBool' },
    TargetInt: { type: 'componentRef', signal: 'PLCInputInt' },
    TargetFloat: { type: 'componentRef', signal: 'PLCInputFloat' },
    Condition: { type: 'enum', enumMap: { NotZero: 'NotZero', Equals: 'Equals', GreaterOrEqual: 'GreaterOrEqual' }, default: 'NotZero' },
    CompareValue: { type: 'number', default: 0, step: 1 },
    TrueValue: { type: 'number', default: 1, step: 1 },
    FalseValue: { type: 'number', default: 0, step: 1 },
    Bit: { type: 'number', default: 0, min: 0, max: 31, step: 1 },
    Width: { type: 'enum', enumMap: { Byte: 'Byte', Word: 'Word', DWord: 'DWord' }, default: 'Word' },
    Signed: { type: 'boolean', default: true },
    Factor: { type: 'number', default: 1 },
    Offset: { type: 'number', default: 0 },
    Rounding: { type: 'enum', enumMap: { Round: 'Round', Truncate: 'Truncate' }, default: 'Round' },
    Invert: { type: 'boolean', default: false },
  },

  // plan-328 - OnColor remains raw because the schema mapper deliberately
  // does not support object-valued properties.
  Lamp: {
    SignalLampOn:       { type: 'componentRef', signal: 'PLCOutputBool' },
    SingalLampFlashing: { type: 'componentRef', signal: 'PLCOutputBool', aliases: ['SignalLampFlashing'] },
    Intensity:          { type: 'number', default: 2 },
    Flashing:           { type: 'boolean', default: false },
    Period:             { type: 'number', default: 1, unit: 's' },
    LampOn:             { type: 'boolean', default: false },
  },

  // plan-2019 — procedural drive sound. SoundType / Mode are the legacy Unity
  // fields: read for the mapping only, never shown (scope 'none').
  Sound: {
    Kind:      { type: 'enum', enumMap: { Auto: 'Auto', Drive: 'Drive', Cylinder: 'Cylinder', Hydraulic: 'Hydraulic' }, default: 'Auto' },
    Variant:   { type: 'enum', enumMap: { Auto: 'Auto', Large: 'Large', Medium: 'Medium', Small: 'Small', Hard: 'Hard', Cushioned: 'Cushioned' }, default: 'Auto' },
    Volume:    { type: 'number', default: 1, min: 0, max: 1 },
    SoundType: {
      type: 'enum',
      enumMap: {
        Robot1: 'Robot1', Robot2: 'Robot2', SmallElectric1: 'SmallElectric1', SmallElectric2: 'SmallElectric2', AirPressure: 'AirPressure',
        0: 'Robot1', 1: 'Robot2', 2: 'SmallElectric1', 3: 'SmallElectric2', 4: 'AirPressure',
      },
      scope: 'none',
    },
    Mode: { type: 'enum', enumMap: { Drive: 'Drive', Pick: 'Pick', 0: 'Drive', 1: 'Pick' }, scope: 'none' },
  },

  // plan-417 — 3D scene buttons. The Unity classes use camelCase field names
  // (untypical for realvirtual), so the schema keys do too: schema key = GLB
  // extras key = C# field name, no conversion anywhere.
  SceneButtonBase: {
    moveable:        { type: 'componentRef' },
    autoLight:       { type: 'boolean', default: true },
    isToggle:        { type: 'boolean', default: false },
    simpleClickTime: { type: 'number', default: 0.5, unit: 's' },
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
    timer:         { type: 'number', default: 0.5, unit: 's' },
    toggle:        { type: 'boolean', default: false },
    activeOnStart: { type: 'boolean', default: false },
  },

  EmergencyButton3D: {
    stateSignal:   { type: 'componentRef', signal: 'PLCInputBool' },
    activeOnStart: { type: 'boolean', default: false },
    // plan-538 F4 — normally-closed output (intentional schema change).
    NormallyClosed: { type: 'boolean', default: false },
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
    BendRadius:  { type: 'number', default: 0, unit: 'mm' },
    ChainLength: { type: 'number', default: 0, unit: 'mm' },
    Axis:        { type: 'enum', enumMap: { Auto: 'Auto', X: 'X', Y: 'Y', Z: 'Z' }, default: 'Auto' },
    BendUp:      { type: 'boolean', default: true },
    Bones:       { type: 'number', default: 24 },
    Enabled:     { type: 'boolean', default: true },
  },

  // plan-733 — Unity `Chain` / `ChainElement`. Added AFTER the rv-ODT
  // migration: not a pre-migration snapshot but the frozen reference for the
  // determinism test.
  Chain: {
    ConnectedDrive:          { type: 'componentRef' },
    chainOrientation:        { type: 'enum', enumMap: { Horizontal: 'Horizontal', Vertical: 'Vertical' }, default: 'Horizontal' },
    NumberOfElements:        { type: 'number', default: 0 },
    StartPosition:           { type: 'number', default: 0, unit: 'mm' },
    CalculatedDeltaPosition: { type: 'boolean', default: true },
    DeltaPosition:           { type: 'number', default: 0, unit: 'mm' },
    ScaledOnFixedLength:     { type: 'boolean', default: false },
    FixedLength:             { type: 'number', default: 1500, unit: 'mm' },
    ChainElement:            { type: 'componentRef' },
    NameChainElement:        { type: 'string', default: '' },
    Spline:                  { type: 'json' },
  },

  ChainElement: {
    AlignWithChain:        { type: 'boolean', default: true },
    AlignVector:           { type: 'vector3', unityCoords: true },
    InitialPosition:       { type: 'number', default: 0, unit: 'mm' },
    OffsetToDrivePosition: { type: 'number', default: 0, unit: 'mm' },
  },

  // plan-459 — fabric / web handling. Added AFTER the rv-ODT migration: not a
  // pre-migration snapshot but the frozen reference for the determinism test.
  // Millimetres throughout; the `Mm` suffix is part of the contract.
  // plan-460 added SpinMode + MantleMesh, plan-468 the winder's WrapDeg.
  // Intentional schema changes: spec JSON and baseline updated together, as this
  // file's header prescribes.
  RibbonRoller: {
    RadiusMm:          { type: 'number', default: 0, unit: 'mm' },
    Axis:              { type: 'enum', enumMap: { X: 'X', Y: 'Y', Z: 'Z' }, default: 'X' },
    RibbonSide:           { type: 'enum', enumMap: { Auto: 'Auto', Left: 'Left', Right: 'Right' }, default: 'Auto' },
    RotationDirection: { type: 'number', default: 1, deprecated: true, scope: 'none' },
    SpinMode:          { type: 'enum', enumMap: { Transform: 'Transform', Texture: 'Texture' }, default: 'Transform' },
    MantleMesh:        { type: 'componentRef' },
    // plan-496 — material names resolved from the loaded document. Intentional
    // schema change: spec JSON, spec tables and this baseline updated together.
    OverrideMaterials:  { type: 'boolean', default: false },
    MantleMaterialName: { type: 'string', default: '' },
    FaceMaterialName:   { type: 'string', default: '' },
  },

  RibbonWinder: {
    SpeedControl: { type: 'enum', enumMap: { None: 'None', LineSpeed: 'LineSpeed', Dancer: 'Dancer' }, default: 'None' },
    DancerGainPerMm: { type: 'number', default: 2, unit: '(mm/s)/mm' },
    MaxTrimPercent: { type: 'number', default: 20, unit: '%' },
    RadiusMm:             { type: 'number', default: 0, unit: 'mm' },
    Axis:                 { type: 'enum', enumMap: { X: 'X', Y: 'Y', Z: 'Z' }, default: 'X' },
    RibbonSide:              { type: 'enum', enumMap: { Auto: 'Auto', Left: 'Left', Right: 'Right' }, default: 'Left' },
    WrapDeg:              { type: 'number', default: 0, unit: 'deg' },
    RotationDirection:    { type: 'number', default: 1, deprecated: true, scope: 'none' },
    SpinMode:             { type: 'enum', enumMap: { Transform: 'Transform', Texture: 'Texture' }, default: 'Transform' },
    MantleMesh:           { type: 'componentRef' },
    // plan-496 fields, inherited from RibbonRoller (Unity exports them on winders and dancers too).
    OverrideMaterials:    { type: 'boolean', default: false },
    MantleMaterialName:   { type: 'string', default: '' },
    FaceMaterialName:     { type: 'string', default: '' },
    CoreRadiusMm:         { type: 'number', default: 76.2, unit: 'mm' },
    RibbonThicknessMm:       { type: 'number', default: 0.1, unit: 'mm' },
    InitialWoundLengthMm: { type: 'number', default: -1, unit: 'mm' },
    MaxDiameterMm:        { type: 'number', default: 0, unit: 'mm' },
    RollMesh:             { type: 'componentRef' },
    DiameterMm:           { type: 'componentRef', signal: 'PLCInputFloat' },
    WoundLengthMm:        { type: 'componentRef', signal: 'PLCInputFloat' },
    Empty:                { type: 'componentRef', signal: 'PLCInputBool' },
    Full:                 { type: 'componentRef', signal: 'PLCInputBool' },
  },

  RibbonPath: {
    Rollers:         { type: 'componentRefArray' },
    // plan-460 follow-up: both fields are IGNORED and now carry the `deprecated`
    // keyword so the inspector hides an empty one. Intentional schema change:
    // spec JSON and baseline updated together, as this file's header prescribes.
    ConnectedDrive:  { type: 'componentRef', deprecated: true },
    SpeedSource:     { type: 'enum', enumMap: { Drive: 'Drive', RibbonWinder: 'RibbonWinder' }, default: 'Drive', deprecated: true },
    RibbonWidthMm:      { type: 'number', default: 500, unit: 'mm' },
    RibbonThicknessMm:  { type: 'number', default: 0.1, unit: 'mm' },
    TextureLengthMm: { type: 'number', default: 1000, unit: 'mm' },
    SamplesPerMeter: { type: 'number', default: 64 },
    Material:        { type: 'componentRef' },
    MaterialName:    { type: 'string', default: '' }, // plan-496
    SlitAtRoller:   { type: 'componentRef' },
    FullWidthMm:     { type: 'number', default: 0, unit: 'mm' },
    // plan-471 — web tension. Intentional schema change: spec JSON, spec tables
    // and this baseline updated together, as the file header prescribes.
    BasisWeightGsm:              { type: 'number', default: 20, unit: 'g/m^2' },
    TensileStiffnessNPerMmWidth: { type: 'number', default: 0, unit: 'N/mm' },
    MinStrainPercent:            { type: 'number', default: 0, unit: '%' },
    MaxStrainPercent:            { type: 'number', default: 2, unit: '%' },
    BreakForceNPer50mm:          { type: 'number', default: 35, unit: 'N' },
    TargetTensionNPerM:          { type: 'number', default: 100, unit: 'N/m' },
    ToleranceBandPercent:        { type: 'number', default: 10, unit: '%' },
    EnableSag:                   { type: 'boolean', default: true },
    TensionColoring:             { type: 'boolean', default: true },
    TintStrength:                { type: 'number', default: 0.7 },
    DeformationScale:            { type: 'number', default: 1 },
    ShowTensionLabels:           { type: 'boolean', default: false },
    TensionN:                    { type: 'componentRef', signal: 'PLCInputFloat' },
    SpecificTensionNPerM:        { type: 'componentRef', signal: 'PLCInputFloat' },
    StrainPercent:               { type: 'componentRef', signal: 'PLCInputFloat' },
    IsSlack:                     { type: 'componentRef', signal: 'PLCInputBool' },
    IsOverstretched:             { type: 'componentRef', signal: 'PLCInputBool' },
    IsBroken:                    { type: 'componentRef', signal: 'PLCInputBool' },
  },

  // plan-460 — the dancer roller. It IS a RibbonRoller (same first six fields,
  // same defaults) plus the travel axis, the store geometry and three feedback
  // signals.
  RibbonDancer: {
    ShowTravel: { type: 'boolean', default: false },
    ShowValues: { type: 'boolean', default: false },
    RadiusMm:          { type: 'number', default: 0, unit: 'mm' },
    Axis:              { type: 'enum', enumMap: { X: 'X', Y: 'Y', Z: 'Z' }, default: 'X' },
    RibbonSide:        { type: 'enum', enumMap: { Auto: 'Auto', Left: 'Left', Right: 'Right' }, default: 'Auto' },
    RotationDirection: { type: 'number', default: 1, deprecated: true, scope: 'none' },
    SpinMode:          { type: 'enum', enumMap: { Transform: 'Transform', Texture: 'Texture' }, default: 'Transform' },
    MantleMesh:        { type: 'componentRef' },
    // plan-496 fields, inherited from RibbonRoller (Unity exports them on winders and dancers too).
    OverrideMaterials: { type: 'boolean', default: false },
    MantleMaterialName:{ type: 'string', default: '' },
    FaceMaterialName:  { type: 'string', default: '' },
    TravelAxis:        { type: 'enum', enumMap: { X: 'X', Y: 'Y', Z: 'Z' }, default: 'Y' },
    TravelMinMm:       { type: 'number', default: -200, unit: 'mm' },
    TravelMaxMm:       { type: 'number', default: 200, unit: 'mm' },
    HomeMm:            { type: 'number', default: 0, unit: 'mm' },
    Strands:           { type: 'number', default: 2 },
    PositionMm:        { type: 'componentRef', signal: 'PLCInputFloat' },
    AtMin:             { type: 'componentRef', signal: 'PLCInputBool' },
    AtMax:             { type: 'componentRef', signal: 'PLCInputBool' },
    // plan-471 — the dancer as a tension SETTER (force in, position out).
    LoadN:             { type: 'number', default: 0, unit: 'N' },
    TensionN:          { type: 'componentRef', signal: 'PLCInputFloat' },
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
  // plan-2022 — unsupported-part detection. Scene-wide switch with parameters;
  // the bounds are the ones the inspector clamps at the input.
  DropDetection: {
    Enabled: { type: 'boolean', default: true },
    GraceTime: { type: 'number', default: 0.5, unit: 's', min: 0, max: 60 },
    SupportProbeDistance: { type: 'number', default: 50, unit: 'mm', min: 1, max: 5000 },
    SupportMode: {
      type: 'enum',
      // Appended, never inserted (see SUPPORT_MODES).
      enumMap: { GeometryBelow: 'GeometryBelow', StateOnly: 'StateOnly' },
      default: 'GeometryBelow',
    },
    SupportRecheckInterval: { type: 'number', default: 0.5, unit: 's', min: 0.05, max: 10 },
    DeleteUnsupported: { type: 'boolean', default: false },
    DeleteDelay: { type: 'number', default: 1, unit: 's', min: 0, max: 60 },
    SignalDropActive: { type: 'componentRef', signal: 'PLCInputBool' },
    SignalDropCount: { type: 'componentRef', signal: 'PLCInputInt' },
    SignalResetDrops: { type: 'componentRef', signal: 'PLCOutputBool' },
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
    CreaseAngle: { type: 'number', default: 35, unit: 'deg' },
    GenerateUVs: { type: 'boolean', default: true },
    StatisticsInterval: { type: 'number', default: 0.25, unit: 's' },
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
    ToolDiameter: { type: 'number', default: 10, unit: 'mm' },
    ToolLength: { type: 'number', default: 50, unit: 'mm' },
    CornerRadius: { type: 'number', default: 2, unit: 'mm' },
    TaperAngleDeg: { type: 'number', default: 15, unit: 'deg' },
  },

  // plan-539 F15 — web-authored scene-level component.
  ConnectionMode: {
    StartMode: { type: 'enum', enumMap: { Simulation: 'Simulation', PLC: 'PLC' }, default: 'Simulation' },
  },

  // plan-543 — web-authored operator panel (JSON string config).
  WebOperatorPanel: {
    Title:          { type: 'string', default: '' },
    Config:         { type: 'string', default: '' },
    Dock:           { type: 'enum', enumMap: {
      'top-left': 'top-left', 'top-right': 'top-right', 'bottom-left': 'bottom-left', 'bottom-right': 'bottom-right',
    }, default: 'top-left' },
    StartCollapsed: { type: 'boolean', default: false },
  },

  // plan-559 Phase 2a — signal scope marker of an embedded copy.
  InstanceScope: {
    PrefixNode: { type: 'componentRef' },
  },

  WebSensor: {
    SignalBool:  { type: 'componentRef' },
    SignalInt:   { type: 'componentRef' },
    IntStateMap: { type: 'string', default: '' },
    Label:       { type: 'string', default: '' },
  },

  // plan-498 — added AFTER the rv-ODT migration (web-authored FMU component):
  // the frozen reference for the spec-loading determinism test.
  Fmu: {
    StepSize:         { type: 'number', default: 0.01 },
    Tolerance:        { type: 'number', default: 0.000001 },
    AllowViewerToFmu: { type: 'boolean', default: true },
    FmuEmbed:         { type: 'json', default: {} },
    FmuVariables:     { type: 'json', default: [] },
    // plan-502
    FmuStartOverrides: { type: 'json', default: {} },
    RestartOnReset:    { type: 'boolean', default: true },
    // plan-512 F11
    FmuUnits:          { type: 'json', default: {} },
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
    HazardZoneRadius: { type: 'number', default: 1500, unit: 'mm' },
    LabelHeight:      { type: 'number', default: 200, unit: 'mm' },
  },

  // plan-525: BoxCollider became an authorable factory component. `center` is
  // Unity-convention (X negated on read), `size` unsigned; NO defaults in the
  // $def — the editor persists explicit authoring defaults.
  BoxCollider: {
    center: { type: 'vector3', unityCoords: true },
    size:   { type: 'vector3' },
  },

  // plan-276: physics zone (StaticColliders is a rawFields string array,
  // captured raw in rv-physics-zone.ts — deliberately NOT a schema field).
  WebPhysicsZone: {
    ZoneEnabled:  { type: 'boolean', default: true },
    WholeScene:   { type: 'boolean', default: false },
    Friction:     { type: 'number',  default: 0.8 },
    Restitution:  { type: 'number',  default: 0 },
    // plan-2219 (intentional schema change, updated together with rv-odt.json):
    SoftCcdPrediction: { type: 'number', default: 0.03, unit: 'm', min: 0, max: 0.2, step: 0.005 },
    RemoveBelowY: { type: 'number',  default: -10, unit: 'm' },
    ShowGizmo:    { type: 'boolean', default: true },
    // plan-2016 S7 (intentional schema change, updated together with rv-odt.json):
    LimitToLayers: { type: 'json', default: [] },
  },

  // plan-661: 2D interaction zone (Guides is a rawFields ComponentReference
  // array, read raw in rv-physics-zone2d.ts). New type — intentional addition.
  WebPhysicsZone2D: {
    Kind: { type: 'enum', enumMap: { Jam: 'Jam', BufferTable: 'BufferTable', Diverter: 'Diverter', Merge: 'Merge' }, default: 'Jam' },
    Surface:          { type: 'componentRef' },
    KinematicDrives:  { type: 'componentRefArray', default: [] },
    Damping:          { type: 'number',  default: 0, unit: '1/s' },
    SleepThreshold:   { type: 'number',  default: 0.05, unit: 'm/s' },
    ForceReturnAfter: { type: 'number',  default: 0, unit: 's' },
    ShowGizmo:        { type: 'boolean', default: true },
  },

  // plan-673 — detail-physics layer (MuJoCo). New types; intentional addition.
  WebMuJoCoRegion: {
    RegionEnabled:  { type: 'boolean', default: true },
    TimestepS:      { type: 'number',  default: 0.002, unit: 's', min: 0.0001, max: 0.1 },
    ExitBandM:      { type: 'number',  default: 0.5, unit: 'm', min: 0 },
    LoadTreeMode:   { type: 'enum',    enumMap: { composite: 'composite', separate: 'separate' }, default: 'composite' },
    MjcfSource:     { type: 'string',  default: '' },
    MeshBase:       { type: 'string',  default: '' },
    Contract:       { type: 'string',  default: '' },
    TrunkBody:      { type: 'string',  default: '' },
    TrunkFreeJoint: { type: 'string',  default: '' },
    GyroSensor:     { type: 'string',  default: '' },
    ShowGizmo:      { type: 'boolean', default: true },
  },

  DynamicAxis: {
    SetpointSource: {
      type: 'enum',
      enumMap: { planner: 'planner', signal: 'signal', operator: 'operator', policy: 'policy' },
      default: 'planner',
    },
    ActuatorKind: {
      type: 'enum',
      enumMap: { position: 'position', velocity: 'velocity', motor: 'motor' },
      default: 'position',
    },
    Kp:                 { type: 'number', default: 80000, min: 0 },
    Kv:                 { type: 'number', default: 0, min: 0 },
    ForceRangeMin:      { type: 'number', default: 0, unit: 'Nm' },
    ForceRangeMax:      { type: 'number', default: 0, unit: 'Nm' },
    Gear:               { type: 'number', default: 1 },
    Armature:           { type: 'number', default: 0.1, unit: 'kgm2', min: 0 },
    Damping:            { type: 'number', default: 0, min: 0 },
    FrictionLoss:       { type: 'number', default: 0, unit: 'Nm', min: 0 },
    BaseFollowingError: { type: 'number', default: 0, unit: 'mm', min: 0 },
    // plan-673 Phase 4 — the overload window and the arrival tolerance.
    FollowingErrorLimit:  { type: 'number', default: 0, unit: 'mm', min: 0 },
    FollowingErrorTimeMs: { type: 'number', default: 200, unit: 'ms', min: 0 },
    ArrivalTolerance:     { type: 'number', default: 0, unit: 'mm', min: 0 },
  },

  // plan-673 Phase 4 (F7) — how the Grip holds, and whether it still does.
  GripLoad: {
    Mode:       { type: 'enum', enumMap: { formfit: 'formfit', forcefit: 'forcefit' }, default: 'formfit' },
    GripForce:  { type: 'number', default: 0, unit: 'N', min: 0 },
    SlipLimit:  { type: 'number', default: 0, unit: 'mm', min: 0 },
    SlipTimeMs: { type: 'number', default: 200, unit: 'ms', min: 0 },
  },

  ContactProfile: {
    Profile: {
      type: 'enum',
      enumMap: {
        Pallet: 'Pallet', Workpiece: 'Workpiece', BeltSurface: 'BeltSurface', StopperFace: 'StopperFace',
        GripperJaw: 'GripperJaw', MachineFrame: 'MachineFrame', FixtureBore: 'FixtureBore', Custom: 'Custom',
      },
      default: 'Workpiece',
    },
    Priority:      { type: 'number', default: 0, min: 0, step: 1 },
    Solmix:        { type: 'number', default: 1, min: 0 },
    FrictionSlide: { type: 'number', default: 1, min: 0 },
    FrictionSpin:  { type: 'number', default: 0.005, min: 0 },
    FrictionRoll:  { type: 'number', default: 0.0001, min: 0 },
    // The default is the MuJoCo condim 4, NOT its own default 3: without spin
    // friction a gripped part rotates out of the jaws and nothing is reported.
    CondDim: {
      type: 'enum',
      enumMap: {
        Frictionless: 'Frictionless', Sliding: 'Sliding',
        SlidingTorsional: 'SlidingTorsional', Full: 'Full',
      },
      default: 'SlidingTorsional',
    },
    SolrefTimeConst: { type: 'number', default: 0.02, unit: 's', min: 0 },
    SolrefDampRatio: { type: 'number', default: 1, min: 0 },
  },

  CollisionShapeSet: {
    Shapes:       { type: 'json',    default: [] },
    ReplacesMesh: { type: 'boolean', default: false },
  },

  FreeBody: {
    Enabled: { type: 'boolean', default: true },
    MassKg:  { type: 'number',  default: 0, unit: 'kg', min: 0 },
    CondDim: {
      type: 'enum',
      enumMap: {
        Frictionless: 'Frictionless', Sliding: 'Sliding',
        SlidingTorsional: 'SlidingTorsional', Full: 'Full',
      },
      default: 'SlidingTorsional',
    },
    FrictionSlide:  { type: 'number', default: 1, min: 0 },
    LinearDamping:  { type: 'number', default: 0, unit: '1/s', min: 0 },
    AngularDamping: { type: 'number', default: 0, unit: '1/s', min: 0 },
    Restitution:    { type: 'number', default: 0, min: 0, max: 1 },
  },

  Movable: {
    Enabled:     { type: 'boolean', default: true },
    Axes:        { type: 'enum', enumMap: { XZ: 'XZ', XYZ: 'XYZ', X: 'X', Y: 'Y', Z: 'Z' }, default: 'XZ' },
    SnapMm:      { type: 'number',  default: 0, unit: 'mm', min: 0 },
    ResetOnStop: { type: 'boolean', default: false },
  },

  LocomotionPolicy: {
    Enabled:        { type: 'boolean', default: true },
    Policy:         { type: 'string',  default: '' },
    FallbackPolicy: { type: 'string',  default: '' },
    Observation:    { type: 'string',  default: '' },
    Contract:       { type: 'string',  default: '' },
    Decimation:     { type: 'number',  default: 4, min: 1, step: 1 },
    ActionScale:    { type: 'number',  default: 1 },
    Axes:           { type: 'componentRefArray', default: [] },
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
    BlinkSpeed: { type: 'number', default: 2, unit: 'Hz' },
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
    BlinkSpeed: { type: 'number', default: 2, unit: 'Hz' },
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
    LinearAcceleration:   { type: 'number',  default: 100, unit: 'mm/s2' },
    InterpolationToTarget: { type: 'enum', enumMap: {
      PointToPoint: 'PointToPoint',
      PointToPointUnsynced: 'PointToPointUnsynced',
      Linear: 'Linear',
    }, default: 'PointToPoint' },
    LinearSpeedToTarget:  { type: 'number',  default: 500, unit: 'mm/s' },
    TurnCorrection:       { type: 'boolean', default: false },
    SetSignalDuration:    { type: 'number',  default: 0.5, unit: 's' },
    WaitForSeconds:       { type: 'number',  default: 0, unit: 's' },
    PickAndPlace:         { type: 'boolean', default: false },
    Pick:                 { type: 'boolean', default: false },
    Place:                { type: 'boolean', default: false },
    EnableBlending:       { type: 'boolean', default: false },
    BlendRadius:          { type: 'number',  default: 25, unit: 'mm' },
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
    // plan-621: optional, no defaults (absent Converter = 'browser'; SolidCraft only on live-synced nodes).
    Converter:         { type: 'enum', enumMap: { connect: 'connect', browser: 'browser', solidcraft: 'solidcraft' }, readonly: true },
    SolidCraft:        { type: 'json', readonly: true },
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
    pressure: { type: 'number', default: 0, unit: 'bar' },
    temperatureC: { type: 'number', default: 0, unit: 'Cel' },
    velocityMs: { type: 'number', default: 0, unit: 'm/s' },
    dnSize: { type: 'number', default: 0 },
  },

  Pump: {
    flowRate: { type: 'number', default: 0 },
    pipe: { type: 'componentRef' },
    circuitId: { type: 'number', default: -1 },
    resourceName: { type: 'string', default: '' },
    state: { type: 'string', default: 'ok' },
    suctionPressure: { type: 'number', default: 0, unit: 'bar' },
    dischargePressure: { type: 'number', default: 0, unit: 'bar' },
    speedRpm: { type: 'number', default: 0, unit: '/min' },
    speedPercent: { type: 'number', default: 0, unit: '%' },
    powerKw: { type: 'number', default: 0, unit: 'kW' },
    currentA: { type: 'number', default: 0, unit: 'A' },
    bearingTempC: { type: 'number', default: 0, unit: 'Cel' },
    motorTempC: { type: 'number', default: 0, unit: 'Cel' },
    vibrationMmS: { type: 'number', default: 0, unit: 'mm/s' },
    npshAvailable: { type: 'number', default: 0, unit: 'm' },
    npshRequired: { type: 'number', default: 0, unit: 'm' },
    runHours: { type: 'number', default: 0, unit: 'h' },
  },

  ResourceTank: {
    resourceName: { type: 'string', default: '' },
    capacity: { type: 'number', default: 0 },
    amount: { type: 'number', default: 0 },
    pressure: { type: 'number', default: 0, unit: 'bar' },
    temperature: { type: 'number', default: 0, unit: 'Cel' },
    density: { type: 'number', default: 0, unit: 'kg/m3' },
    ph: { type: 'number', default: 0, unit: '[pH]' },
    agitatorOn: { type: 'boolean', default: false },
    heatingOn: { type: 'boolean', default: false },
    tempHighLimit: { type: 'number', default: 0, unit: 'Cel' },
    tempLowLimit: { type: 'number', default: 0, unit: 'Cel' },
    pressureHighLimit: { type: 'number', default: 0, unit: 'bar' },
  },

  ProcessingUnit: {
    connections: { type: 'componentRefArray' },
    state: { type: 'string', default: 'idle' },
    availability: { type: 'number', default: 0 },
    performance: { type: 'number', default: 0 },
    quality: { type: 'number', default: 0 },
    cycleTimeS: { type: 'number', default: 0, unit: 's' },
    cycleTargetS: { type: 'number', default: 0, unit: 's' },
    throughputPerHour: { type: 'number', default: 0, unit: '/h' },
    goodCount: { type: 'number', default: 0 },
    scrapCount: { type: 'number', default: 0 },
    mtbfHours: { type: 'number', default: 0, unit: 'h' },
    mttrMinutes: { type: 'number', default: 0, unit: 'min' },
    runHours: { type: 'number', default: 0, unit: 'h' },
    downHours: { type: 'number', default: 0, unit: 'h' },
    lastFault: { type: 'string', default: '' },
  },
  Group: {
    GroupName: { type: 'string', default: 'Group' },
    GroupNamePrefix: { type: 'string', readonly: true },
  },

  // BlockageBudget (plan-2038) — declaration only; numeric fields are nullable in rv-odt.json
  // (null/absent = inherit from the ancestor or the document default), loaded as plain numbers.
  BlockageBudget: {
    Exempt:              { type: 'boolean' },
    Scope:               { type: 'enum', enumMap: { node: 'node', subtree: 'subtree' }, default: 'subtree' },
    ExpectFlow:          { type: 'boolean' },
    MaxWaitSec:          { type: 'number', unit: 's' },
    MaxIdleSec:          { type: 'number', unit: 's' },
    WarmupSec:           { type: 'number', unit: 's', min: 0 },
    ExpectedWaits:       { type: 'json' },
    Severity:            { type: 'enum', enumMap: { error: 'error', warning: 'warning', info: 'info' } },
    SignalSuppress:      { type: 'componentRef', signal: 'PLCOutputBool' },
    SignalBlockageFound: { type: 'componentRef', signal: 'PLCInputBool' },
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
    connectCheck: { type: 'boolean', default: true },
  },

  // plan-628 Phase 2 — path-network building block (WEB-only, no factory).
  // params/pose are structured 'json' fields; parsePathBlockExtras() in
  // rv-path-block.ts is the executable SSOT of their inner shape.
  PathBlock: {
    version: { type: 'number', default: 1 },
    kind: {
      type: 'enum',
      enumMap: { straight: 'straight', curve: 'curve', diverge: 'diverge', merge: 'merge', stub: 'stub' },
      default: 'straight',
    },
    params: { type: 'json', default: {} },
    pose: { type: 'json', default: [0, 0, 0] },
    y: { type: 'number', default: 0, unit: 'm' },
    host: { type: 'string' },
    hostPathId: { type: 'string' },
    frontPathId: { type: 'string' },
  },

  // plan-650 Phase 1 — parametric part family (WEB-only). Added after the rv-ODT
  // migration: the frozen reference for the determinism test. Params/Values are
  // structured 'json' fields; parseParametricComponent() in
  // rv-parametric-component.ts is the executable SSOT of their inner shape.
  ParametricComponent: {
    ApiVersion: { type: 'number', default: 1 },
    Params: { type: 'json', default: [] },
    Values: { type: 'json', default: {} },
    Code: { type: 'string', default: '' },
    CodeHash: { type: 'string', default: '' },
    PartsRoot: { type: 'string', default: '_Parts' },
    GeneratedRoot: { type: 'string', default: '_Generated' },
    BakedInputHash: { type: 'string' },
    DesignResource: { type: 'string' },
  },

  // plan-404 — rigid-body mechanisms. Added AFTER the rv-ODT migration: not a
  // pre-migration snapshot but the frozen reference for the determinism test.
  // NOTE these are the RIGID-BODY types (joint graph + constraint solve), not
  // the older axis-group `Kinematic` component under `structure`.
  KinematicMechanism: {
    SolverIterations: { type: 'number', default: 4 },
    Damping:          { type: 'number', default: 0.01 },
    Tolerance:        { type: 'number', default: 0.001, unit: 'mm' },
    SignalConverged:  { type: 'componentRef', signal: 'PLCOutputBool' },
    Converged:        { type: 'boolean', default: true, readonly: true },
    ResidualError:    { type: 'number', default: 0, readonly: true, unit: 'mm' },
    SolveTimeMs:      { type: 'number', default: 0, readonly: true, unit: 'ms' },
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
    DensityKgM3:        { type: 'number', default: 7850, unit: 'kg/m^3' },
    MassOverrideKg:     { type: 'number', unit: 'kg' },
    ComOverrideLocalMm: { type: 'vector3', unityCoords: true },
    // plan-501 F1 — structured JSON field: six numbers about the COM, kg·mm².
    InertiaOverrideLocalKgMm2: { type: 'json' },
    MassSource:         { type: 'string', default: 'mesh', readonly: true },
  },

  // plan-729 — Cartesian paths for mechanisms. `SpeedToTarget` has no default:
  // ABSENT means "inherit the path's speed", which is a different statement
  // from any number.
  MechanismTarget: {
    Mechanism: { type: 'componentRef' },
    InterpolationToTarget: {
      type: 'enum',
      enumMap: { Linear: 'Linear', PointToPoint: 'PointToPoint' },
      default: 'Linear',
    },
    SpeedToTarget:  { type: 'number' },
    WaitForSeconds: { type: 'number', default: 0, unit: 's' },
    SetSignal:      { type: 'componentRef' },
    WaitForSignal:  { type: 'componentRef' },
  },

  MechanismPath: {
    Mechanism:           { type: 'componentRef' },
    TargetLink:          { type: 'componentRef' },
    Path:                { type: 'componentRefArray' },
    SignalStart:         { type: 'componentRef' },
    SignalIsStarted:     { type: 'componentRef' },
    SignalEnded:         { type: 'componentRef' },
    LoopPath:            { type: 'boolean', default: false },
    SpeedOverride:       { type: 'number', default: 1 },
    LinearSpeedToTarget: { type: 'number', default: 500, unit: 'mm/s' },
    LinearAcceleration:  { type: 'number', default: 1000, unit: 'mm/s2' },
    // plan-501 F10 — optional trajectory playback.
    Trajectory:          { type: 'componentRef' },
    // plan-511 — always draw the path in the viewer.
    ShowPath:            { type: 'boolean', default: false },
  },

  // plan-501 — one drive-sizing case: sampled TCP path + payload.
  MechanismTrajectory: {
    Mechanism:        { type: 'componentRef' },
    TargetLink:       { type: 'componentRef' },
    Name:             { type: 'string', default: 'trajectory' },
    Samples:          { type: 'json' },
    SampleIntervalMs: { type: 'number', default: 2, unit: 'ms' },
    Frame:            { type: 'enum', enumMap: { 'z-up': 'z-up', 'y-up': 'y-up' }, default: 'z-up' },
    TcpOffsetMm:      { type: 'vector3' },
    PayloadMassKg:    { type: 'number', default: 0, unit: 'kg' },
    PayloadOffsetMm:  { type: 'vector3' },
    OutputIntervalMs: { type: 'number', default: 4, unit: 'ms' },
    // plan-511 — always draw the path in the viewer.
    ShowPath:         { type: 'boolean', default: false },
  },
};

/** All in-scope rv-ODT v1 component registry keys. */
export const ODT_V1_COMPONENT_KEYS = Object.keys(INLINE_SCHEMA_BASELINE);
