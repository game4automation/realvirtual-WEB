// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Operator devices (plan-542) — flat drawings of IEC control-box devices and
 * the generic operator panel built from them.
 *
 * A station panel is DATA: an {@link OperatorPanelConfig} (pure JSON — colour
 * names, row/col, conditions as objects), normally carried by the model as the
 * `Config` of a `WebOperatorPanel` component (plan-543, rendered by
 * `WebOperatorPanelHost`), or given to an {@link OperatorPanelPlugin} in code.
 * The devices can also be used one by one inside any {@link ControlWindow}.
 * The IEC colour literals live in `shared-sx.ts` (`IEC_CAP` / `IEC_LAMP`) and
 * only these devices import them — the "Operator Device exception" of the
 * private DESIGN.md.
 */

export { OperatorPanel, OperatorPanelPlugin, type OperatorPanelProps } from './OperatorPanel';
export {
  validateOperatorPanelConfig, validateOperatorPanelConfigIssues, operatorPanelSignals,
  operatorPanelAnalogSignals, resolveStatus, evaluateCondition,
  OperatorPanelController, OFFLINE_SNAPSHOT, STATUS_ICONS, STATUS_TONES,
  type OperatorPanelSnapshot, type OperatorPanelSource, type OperatorPanelHostViewer,
  type OperatorPanelConfig, type OperatorPanelValidation, type OperatorPanelIssue, type Condition, type SignalReader,
  type PanelButtonConfig, type PanelSelectorConfig, type PanelEstopConfig, type PanelLampConfig,
  type PanelTowerSegmentConfig, type PanelChipConfig, type PanelStatusRule, type PanelPositionConfig,
  type PanelSliderConfig, type PanelReadoutConfig,
  type PanelKeyLegendConfig, type PanelKeyLegendRowConfig,
  type StatusIcon, type StatusTone,
} from './operator-panel-model';
export { IlluminatedPushButton, type IlluminatedPushButtonProps } from './IlluminatedPushButton';
export { SelectorSwitch, type SelectorSwitchProps, type SelectorPosition } from './SelectorSwitch';
export { EmergencyStop, type EmergencyStopProps, RELEASE_HOLD_MS, ESTOP_PRESSED_WORD } from './EmergencyStop';
export { StackLight, stackLightWords, type StackLightProps, type StackLightSegment } from './StackLight';
export { SetpointSlider, type SetpointSliderProps } from './SetpointSlider';
export { DigitalReadout, type DigitalReadoutProps } from './DigitalReadout';
export { KeyLegend, type KeyLegendProps, type KeyLegendRow } from './KeyLegend';
export {
  PilotLamp, type PilotLampProps, type LampState, type LampLook, lampLook, lampWords, lampGlow, NOT_DRIVEN_HINT,
  usePrefersReducedMotion,
} from './PilotLamp';
export type { IecCapColor, IecLampColor } from '../shared-sx';
