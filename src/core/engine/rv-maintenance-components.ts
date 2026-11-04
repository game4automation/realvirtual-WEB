// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-maintenance-components.ts — web-only component schemas of a guided
 * maintenance procedure (plan-522 Phase 1).
 *
 * A procedure is authored in the web editor as components on nodes: one node
 * carries `LogicStep_MaintenanceProcedure`, each of its direct children is one
 * step (`LogicStep_MaintenanceStep`) plus the action components of that step
 * (`LogicStep_AnimateTransform`, `LogicStep_SetTransparency`, `LogicStep_Effect`,
 * and the existing `LogicStep_DriveTo` / `LogicStep_SetSignalBool`). A child
 * node of a step carrying `LogicStep_Arrow` is an arrow shown with that step;
 * the node's pose is the arrow's pose. Nothing
 * here runs anything: the logic engine skips every node under a procedure
 * (`RVLogicEngine.addSubtree`), the maintenance parser reads the data, and a
 * runtime registered elsewhere animates it.
 *
 * Schema-only, no factory (pattern of `rv-group-component.ts`). Every value is
 * authored in viewer coordinates — no Unity conversion. Reference fields store
 * the `ComponentReference` object form (`{ type, path, componentType }`, a
 * target of kind `node` with `componentType: ''`); their `bakeTarget` makes the
 * bake keep the target (`merge`) or make it a chunk boundary of its own
 * (`chunk`) — read by the survival walker through `referenceBakeTargetOf()`.
 *
 * `LogicStep_DriveTo` / `LogicStep_SetSignalBool` get NO schema on purpose
 * (plan-522 decision 2026-10-21): a registered schema would make every node
 * carrying them a behavioural node with a bake role of its own and change the
 * bake of existing GLBs. They only become `authorable`, with field defaults
 * from a small table (`registerAuthoringDefaults`).
 */

import {
  registerAuthoringDefaults,
  registerCapabilities,
  registerComponentSchema,
  type ComponentCapabilities,
  type ComponentSchema,
} from './rv-component-registry';

// ─── Type keys ───────────────────────────────────────────────────────

export const MAINTENANCE_PROCEDURE_TYPE = 'LogicStep_MaintenanceProcedure';
export const MAINTENANCE_STEP_TYPE = 'LogicStep_MaintenanceStep';
export const MAINTENANCE_ANIMATE_TRANSFORM_TYPE = 'LogicStep_AnimateTransform';
export const MAINTENANCE_SET_TRANSPARENCY_TYPE = 'LogicStep_SetTransparency';
export const MAINTENANCE_EFFECT_TYPE = 'LogicStep_Effect';
export const MAINTENANCE_ARROW_TYPE = 'LogicStep_Arrow';
export const MAINTENANCE_TRIGGER_TYPE = 'LogicStep_MaintenanceTrigger';

/** The seven schemas this module registers. */
export const MAINTENANCE_COMPONENT_TYPES: readonly string[] = Object.freeze([
  MAINTENANCE_PROCEDURE_TYPE,
  MAINTENANCE_STEP_TYPE,
  MAINTENANCE_ANIMATE_TRANSFORM_TYPE,
  MAINTENANCE_SET_TRANSPARENCY_TYPE,
  MAINTENANCE_EFFECT_TYPE,
  MAINTENANCE_ARROW_TYPE,
  MAINTENANCE_TRIGGER_TYPE,
]);

/** Every PLC signal type — a trigger's `Signal` reads inputs and outputs alike (plan-522 G1). */
export const MAINTENANCE_TRIGGER_SIGNAL_TYPES: readonly string[] = Object.freeze([
  'PLCInputBool', 'PLCOutputBool', 'PLCInputInt', 'PLCOutputInt', 'PLCInputFloat', 'PLCOutputFloat',
]);

/** Existing LogicStep types that become addable at step nodes (capability only). */
export const MAINTENANCE_REUSED_STEP_TYPES: readonly string[] = Object.freeze([
  'LogicStep_DriveTo',
  'LogicStep_SetSignalBool',
]);

/**
 * Field defaults of the reused steps for "Add component" — the values of the
 * private Quick Edit LogicStep palette (`LOGIC_STEP_DEFAULTS`). The reference
 * fields (`drive`, `Signal`) stay unset until the author picks a target.
 */
export const MAINTENANCE_REUSED_STEP_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  LogicStep_DriveTo: Object.freeze({ Destination: 0, Relative: false }),
  LogicStep_SetSignalBool: Object.freeze({ SetToTrue: true }),
});

// ─── Schemas ─────────────────────────────────────────────────────────

/**
 * The step symbols of a maintenance instruction (plan-522 Phase 6, Thomas
 * 2026-10-24): one per step (panel) and per marker (3D). Material icons —
 * the HMI's own icon set. `None` = no symbol.
 *   MoveByHand  PanTool + SwapHoriz     Lubricate  OilBarrel
 *   TurnScrew   Build + RotateRight     Inspect    Visibility
 *   Measure     Straighten              Clean      CleaningServices
 *   Safety      Lock + Warning          Done       CheckCircle
 */
export const MAINTENANCE_SYMBOLS: readonly string[] = Object.freeze([
  'MoveByHand', 'Lubricate', 'TurnScrew', 'Inspect', 'Measure', 'Clean', 'Safety', 'Done',
]);


const ZERO = { x: 0, y: 0, z: 0 };

const enumOf = (...values: string[]): Record<string, string> =>
  Object.fromEntries(values.map((v) => [v, v]));

export const MAINTENANCE_PROCEDURE_SCHEMA: ComponentSchema = {
  /** Empty = the node name. */
  ProcedureName: { type: 'string', default: '' },
  /** 0 = sum of the step estimates. */
  EstimatedMinutes: { type: 'number', default: 0, unit: 'min' },
  /**
   * Message-panel tile (plan-522 Phase 6): `WhenDue` = only once the trigger
   * below fires, `Always` = always listed (info), turning into a warning when due.
   */
  Message: { type: 'enum', enumMap: enumOf('WhenDue', 'Always'), default: 'WhenDue' },
  /** Message tile subtitle; empty = a generated text. */
  MessageText: { type: 'string', default: '' },
  /**
   * Phase-6 single trigger (kept for existing files): the drive whose travel /
   * running time makes the procedure due. Read as an implicit Travel / RunTime
   * trigger next to the `LogicStep_MaintenanceTrigger` child nodes. Unset = none.
   */
  TriggerDrive: { type: 'componentRef', refTarget: 'node' },
  /** `km` = accumulated travel of the drive, `h` = time the drive moves. */
  TriggerUnit: { type: 'enum', enumMap: enumOf('km', 'h'), default: 'km' },
  /** Due when the counter reaches this value (in `TriggerUnit`); 0 = no trigger. */
  TriggerInterval: { type: 'number', default: 0 },
  /** Simulation speed-up of the counter (1 = real travel / time). */
  TriggerAcceleration: { type: 'number', default: 1 },
  /**
   * How the triggers (child nodes with `LogicStep_MaintenanceTrigger`) combine
   * (plan-522 Phase 7): `Any` = due as soon as one is due ("3000 km or 3 years
   * at the latest"), `All` = due only when all active triggers are.
   */
  TriggerCombine: { type: 'enum', enumMap: enumOf('Any', 'All'), default: 'Any' },
  /** Written true while the procedure is due or overdue. */
  DueSignal: { type: 'componentRef', signal: 'PLCInputBool' },
  /** Written true while the procedure is overdue. */
  OverdueSignal: { type: 'componentRef', signal: 'PLCInputBool' },
  /** Written 0 ok, 1 upcoming, 2 due, 3 overdue (drives a WebSensor lamp through IntStateMap). */
  StateSignal: { type: 'componentRef', signal: 'PLCInputInt' },
  /** Written: what is left of the deciding trigger until due, in its unit; 0 when due, -1 without counter. */
  RemainingSignal: { type: 'componentRef', signal: 'PLCInputFloat' },
};

/**
 * One reason a procedure becomes due (plan-522 Phase 7), on its own child node
 * of the procedure node — bake- and identity-safe like `LogicStep_Arrow`.
 *   Count      edges of a Bool signal (Int signal: its increase)  → Interval in counts
 *   Signal     a matching edge of a Bool signal makes it due
 *   RunTime    time the Bool signal is true (or the drive moves)  → Interval in h
 *   Travel     travel of the drive                                → Interval in km
 *   Threshold  an Int/Float signal compared with Threshold
 *   Interval   operating time of the scene                        → Interval in h
 */
export const MAINTENANCE_TRIGGER_SCHEMA: ComponentSchema = {
  Kind: { type: 'enum', enumMap: enumOf('Count', 'Signal', 'RunTime', 'Travel', 'Threshold', 'Interval'), default: 'Count' },
  Enabled: { type: 'boolean', default: true },
  /** Source of Count / Signal / RunTime / Threshold: any PLC signal, input or output (read only). */
  Signal: { type: 'componentRef', refSignalTypes: MAINTENANCE_TRIGGER_SIGNAL_TYPES },
  /** Travel: the drive whose travel counts; RunTime without Signal: the drive whose moving time counts. */
  Drive: { type: 'componentRef', refTarget: 'node' },
  /** Signal / Count: which change of the Bool signal counts. */
  Edge: { type: 'enum', enumMap: enumOf('Rising', 'Falling', 'Both'), default: 'Rising' },
  /** Stays due until the maintenance is done (off: due only while the condition holds). */
  Latch: { type: 'boolean', default: true },
  /** Threshold: comparison of the signal value with Threshold. */
  Compare: { type: 'enum', enumMap: enumOf('GreaterThan', 'GreaterOrEqual', 'LessThan', 'LessOrEqual', 'Equals'), default: 'GreaterOrEqual' },
  /** Threshold: limit in the signal's unit. */
  Threshold: { type: 'number', default: 0 },
  /** Threshold: how far the value must fall back before the trigger can fire again (signal unit). */
  Hysteresis: { type: 'number', default: 0, min: 0 },
  /** Signal / Threshold: the condition must hold this long before the trigger fires. */
  DebounceSeconds: { type: 'number', default: 0, unit: 's', min: 0 },
  /** Due limit of Count (counts) / RunTime + Interval (h) / Travel (km); 0 = inactive. */
  Interval: { type: 'number', default: 0, min: 0 },
  /** Share of Interval (Threshold: of Threshold) from which the procedure is "upcoming"; 0 = never. */
  WarnAt: { type: 'number', default: 0.9, min: 0, max: 1, step: 0.05 },
  /** Excess over Interval (same unit; Signal / Threshold: seconds due) after which it is "overdue"; 0 = never. */
  OverdueAfter: { type: 'number', default: 0, min: 0 },
  /** Standalone speed-up of Travel / RunTime / Interval (demo time lapse); ignored live. */
  Acceleration: { type: 'number', default: 1, min: 0 },
};

export const MAINTENANCE_STEP_SCHEMA: ComponentSchema = {
  /** Empty = the node name. */
  Title: { type: 'string', default: '' },
  Instruction: { type: 'string', default: '' },
  WarningNote: { type: 'string', default: '' },
  Severity: { type: 'enum', enumMap: enumOf('Info', 'Warning', 'Error', 'Success'), default: 'Info' },
  CompletionType: { type: 'enum', enumMap: enumOf('Checkbox', 'ConfirmWarning', 'Observation'), default: 'Checkbox' },
  CheckboxLabel: { type: 'string', default: 'Done' },
  EstimatedMinutes: { type: 'number', default: 0, unit: 'min' },
  /** World position, viewer coordinates. (0,0,0) + (0,0,0) = no camera move. */
  CameraPosition: { type: 'vector3', default: ZERO },
  /** World orbit target, viewer coordinates. */
  CameraTarget: { type: 'vector3', default: ZERO },
  CameraDuration: { type: 'number', default: 0.8, unit: 's' },
  HighlightTargets: { type: 'componentRefArray', default: [], bakeTarget: 'merge', refTarget: 'node' },
  /** Symbol of the step in the guide panel (see MAINTENANCE_SYMBOLS); None = none. */
  Symbol: { type: 'enum', enumMap: enumOf('None', ...MAINTENANCE_SYMBOLS), default: 'None' },
  /** Button label of the step's document link, e.g. "Betriebsanleitung"; empty = no link (plan-522 Phase 6). */
  DocumentTitle: { type: 'string', default: '' },
  /** Page the link opens (`#page=`); 0 = first page. */
  DocumentPage: { type: 'number', default: 0 },
  /** Document address; `{lang}` = UI language. Used without `DocumentSource` or when the AAS lookup finds nothing. */
  DocumentUrl: { type: 'string', default: '' },
  /** Node carrying the `AASLink` whose handover documentation holds the document. */
  DocumentSource: { type: 'componentRef', refTarget: 'node' },
  /** Part of the document title or kind to pick in the AAS; `|` separates alternatives. */
  DocumentKeyword: { type: 'string', default: '' },
};

export const MAINTENANCE_ANIMATE_TRANSFORM_SCHEMA: ComponentSchema = {
  /** All targets get the same offset. */
  Targets: { type: 'componentRefArray', default: [], bakeTarget: 'chunk', refTarget: 'node' },
  /** Parent space of the target, scene units, relative to the BASELINE. */
  PositionOffset: { type: 'vector3', default: ZERO },
  /** Local axis. */
  RotationAxis: { type: 'vector3', default: { x: 0, y: 1, z: 0 } },
  /** Unbounded (720 = two turns), relative to the baseline. */
  RotationAngle: { type: 'number', default: 0, unit: 'deg' },
  Duration: { type: 'number', default: 1, unit: 's' },
  Easing: { type: 'enum', enumMap: enumOf('Linear', 'EaseIn', 'EaseOut', 'EaseInOut'), default: 'EaseInOut' },
  /** Couples rotation and travel to one progress value. */
  ScrewMotion: { type: 'boolean', default: false },
  StartDelay: { type: 'number', default: 0, unit: 's' },
};

export const MAINTENANCE_SET_TRANSPARENCY_SCHEMA: ComponentSchema = {
  /**
   * `Targets`: the targets fade. `AllExceptTargets` (focus, plan-522 Phase 6):
   * everything else of the model fades, the targets stay as they are. Each
   * target is its own chunk boundary (`bakeTarget: 'chunk'`), so it can stay
   * bright alone after the bake.
   */
  Mode: { type: 'enum', enumMap: enumOf('Targets', 'AllExceptTargets'), default: 'Targets' },
  Targets: { type: 'componentRefArray', default: [], bakeTarget: 'chunk', refTarget: 'node' },
  /** Mode Targets: opacity of the targets, 0..1; 1 = opaque, 0 = hidden. */
  Opacity: { type: 'number', default: 0.25 },
  /** Mode AllExceptTargets: opacity of everything else, 0..1 (0 = hidden). Default very strong. */
  RestOpacity: { type: 'number', default: 0.08 },
  /** Mode AllExceptTargets: how far everything else is greyed out, 0..1 (1 = fully grey). */
  RestDesaturation: { type: 'number', default: 1 },
  Duration: { type: 'number', default: 0.5, unit: 's' },
  StartDelay: { type: 'number', default: 0, unit: 's' },
};

export const MAINTENANCE_EFFECT_SCHEMA: ComponentSchema = {
  Type: { type: 'enum', enumMap: enumOf('CoolantSpray'), default: 'CoolantSpray' },
  /** Cone along the anchor's local -Y. */
  Anchors: { type: 'componentRefArray', default: [], bakeTarget: 'chunk', refTarget: 'node' },
  /** 0..1 for all anchors; 0 = off. */
  Intensity: { type: 'number', default: 1 },
  /** Subset of the anchors with reduced intensity. */
  ReducedAnchors: { type: 'componentRefArray', default: [], bakeTarget: 'chunk', refTarget: 'node' },
  ReducedIntensity: { type: 'number', default: 0.2 },
  /** Scene units. */
  Length: { type: 'number', default: 0.15 },
  Angle: { type: 'number', default: 15, unit: 'deg' },
  StartDelay: { type: 'number', default: 0, unit: 's' },
};


/**
 * A marker on its own node below a step node, shown while the step is.
 * `Linear` / `RotateCW` / `RotateCCW`: an arrow in the node's local XY plane
 * (+X / about +Z). `Symbol`: a camera-facing step symbol (`Symbol`) with an
 * optional `Label` at the node's origin — e.g. a grease point or a hand that
 * moves a part; with `Animate` a MoveByHand symbol moves back and forth along
 * the node's +X. Move and turn the node to place it.
 */
export const MAINTENANCE_ARROW_SCHEMA: ComponentSchema = {
  Type: { type: 'enum', enumMap: enumOf('Linear', 'RotateCW', 'RotateCCW', 'Symbol'), default: 'Linear' },
  /** Edge length of the arrow / symbol. */
  Size: { type: 'number', default: 0.1, unit: 'm' },
  /** A linear arrow pushes along its direction, a turning arrow turns, a symbol pulses (MoveByHand: back and forth). */
  Animate: { type: 'boolean', default: true },
  /** Type Symbol only: which step symbol. */
  Symbol: { type: 'enum', enumMap: enumOf(...MAINTENANCE_SYMBOLS), default: 'Inspect' },
  /** Type Symbol only: short text below the symbol, e.g. "LUB-E1". */
  Label: { type: 'string', default: '' },
};

// ─── Registration ────────────────────────────────────────────────────

/** LogicStep badge colour (same as the inspector's `LogicStep_*` fallback). */
const MAINTENANCE_BADGE_COLOR = '#8d6e63';

/**
 * `ui.category` takes only the fixed `CATEGORY_ORDER`; the procedure family is
 * the fine label inside Logic (chip: Logic ▸ Maintenance).
 */
const MAINTENANCE_CAPABILITIES: ComponentCapabilities = {
  authorable: true,
  pick: 'none',
  ui: { category: 'logic', filter: 'Maintenance', badge: MAINTENANCE_BADGE_COLOR },
};

registerComponentSchema(MAINTENANCE_PROCEDURE_TYPE, MAINTENANCE_PROCEDURE_SCHEMA, MAINTENANCE_CAPABILITIES);
registerComponentSchema(MAINTENANCE_STEP_TYPE, MAINTENANCE_STEP_SCHEMA, MAINTENANCE_CAPABILITIES);
registerComponentSchema(MAINTENANCE_ANIMATE_TRANSFORM_TYPE, MAINTENANCE_ANIMATE_TRANSFORM_SCHEMA, MAINTENANCE_CAPABILITIES);
registerComponentSchema(MAINTENANCE_SET_TRANSPARENCY_TYPE, MAINTENANCE_SET_TRANSPARENCY_SCHEMA, MAINTENANCE_CAPABILITIES);
registerComponentSchema(MAINTENANCE_EFFECT_TYPE, MAINTENANCE_EFFECT_SCHEMA, MAINTENANCE_CAPABILITIES);
registerComponentSchema(MAINTENANCE_ARROW_TYPE, MAINTENANCE_ARROW_SCHEMA, MAINTENANCE_CAPABILITIES);
registerComponentSchema(MAINTENANCE_TRIGGER_TYPE, MAINTENANCE_TRIGGER_SCHEMA, MAINTENANCE_CAPABILITIES);

// Reused steps: capability + defaults only. No `ui` declaration — the built-in
// `LogicStep_` category rule keeps their chip unchanged.
for (const type of MAINTENANCE_REUSED_STEP_TYPES) {
  registerCapabilities(type, { authorable: true });
  registerAuthoringDefaults(type, MAINTENANCE_REUSED_STEP_DEFAULTS[type]);
}
