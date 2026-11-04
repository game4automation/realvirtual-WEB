// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * operator-panel-json-schema.ts — JSON Schema (draft-07) of an
 * {@link OperatorPanelConfig} for the JSON field editor (plan-555).
 *
 * Used for COMPLETION and HOVER only (property names, enum values,
 * descriptions) — never for validation: the rules stay in
 * `validateOperatorPanelConfig`, the one source of operator panel errors.
 * Enums are derived from the same constants the validator uses, so the two
 * cannot drift apart. Loaded lazily with the editor — never in the entry chunk.
 */

import { IEC_CAP, IEC_LAMP } from '../shared-sx';
import { STATUS_ICONS, STATUS_TONES, type OperatorPanelConfig } from './operator-panel-model';

/** Schema group id of `WebOperatorPanel.Config` (one schema for every panel field). */
export const OPERATOR_PANEL_SCHEMA_ID = 'web-operator-panel-config';

export const CAP_COLORS = Object.keys(IEC_CAP);
export const LAMP_COLORS = Object.keys(IEC_LAMP);
export const SELECTOR_VARIANTS = ['knob', 'key'] as const;
export const CHIP_TONES = ['warn', 'neutral'] as const;

const cellProps = {
  row: { type: 'integer', minimum: 1, description: 'Grid row, 1-based. Devices sharing a cell stack in it.' },
  col: { type: 'integer', minimum: 1, description: 'Grid column, 1-based (at most `columns`).' },
};

const signal = (description: string) => ({ type: 'string', description });

/** The schema; `$ref`s point into `definitions`. */
export const OPERATOR_PANEL_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Operator panel',
  description: 'A station operator panel as data: buttons, selectors, E-stops, setpoint sliders, numeric readouts, a stack light, chips and a status strip.',
  type: 'object',
  definitions: {
    condition: {
      description: 'A condition on boolean signals: {signal,is}, {all:[…]}, {any:[…]} or {not:{…}}.',
      type: 'object',
      properties: {
        signal: signal('The boolean signal to compare.'),
        is: { type: 'boolean', description: 'The value the signal must have.' },
        all: { type: 'array', description: 'Holds when every condition holds.', items: { $ref: '#/definitions/condition' } },
        any: { type: 'array', description: 'Holds when at least one condition holds.', items: { $ref: '#/definitions/condition' } },
        not: { $ref: '#/definitions/condition', description: 'Holds when the condition does not hold.' },
      },
    },
    lamp: {
      description: 'A lamp as wired: its output signal and colour.',
      type: 'object',
      properties: {
        signal: signal('The output signal that lights the lamp.'),
        color: { enum: LAMP_COLORS, description: 'Lamp colour (IEC 60204-1).' },
        simDriven: { type: 'boolean', description: 'False when the simulation never writes this lamp — drawn "not driven" there. Default true.' },
        flashWhen: { $ref: '#/definitions/condition', description: 'Flash (2 Hz) while this holds, e.g. a fault that can be acknowledged.' },
      },
    },
    button: {
      description: 'An illuminated push button.',
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Accessible name, e.g. "Acknowledge".' },
        legend: { type: 'string', description: 'Legend plate text; defaults to `label`.' },
        signal: signal('The input it writes: true while held, false on release.'),
        capColor: { enum: CAP_COLORS, description: 'Cap colour by function (IEC 60204-1 §10.2).' },
        lamp: { $ref: '#/definitions/lamp' },
        separated: { type: 'boolean', description: "Draws a separator on the cell's left edge (e.g. an immediate stop)." },
        ...cellProps,
      },
    },
    position: {
      type: 'object',
      description: 'A selector position and the value it writes.',
      properties: {
        legend: { type: 'string', description: 'Legend of the position.' },
        value: { type: 'boolean', description: 'The value written in this position.' },
      },
    },
    selector: {
      description: 'A two-position selector switch (knob or key).',
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Accessible name.' },
        caption: { type: 'string', description: 'Caption below the switch; defaults to `label`.' },
        variant: { enum: [...SELECTOR_VARIANTS], description: 'Knob or key switch.' },
        signal: signal('The input it writes (latched).'),
        positions: {
          type: 'array', minItems: 2, maxItems: 2,
          description: 'Left, then right position, each with the value it writes.',
          items: { $ref: '#/definitions/position' },
        },
        lamp: { $ref: '#/definitions/lamp' },
        ...cellProps,
      },
    },
    estop: {
      description: 'An emergency stop.',
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Accessible name.' },
        signal: signal('The input it writes.'),
        normallyClosed: { type: 'boolean', description: 'Normally closed: pressed writes false. Default true.' },
        lamp: { $ref: '#/definitions/lamp' },
        ...cellProps,
      },
    },
    slider: {
      description: 'A setpoint slider: the panel\'s analog INPUT. Writes a number to its signal, live while dragged.',
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Accessible name, e.g. "Walk speed".' },
        caption: { type: 'string', description: 'Caption below the slider; defaults to `label`.' },
        signal: signal('The input it writes (a float signal).'),
        min: { type: 'number', description: 'Lower end of the range.' },
        max: { type: 'number', description: 'Upper end of the range; must be greater than min.' },
        step: { type: 'number', exclusiveMinimum: 0, description: 'Step of the dial. Default 1.' },
        unit: { type: 'string', description: 'Unit shown with the live value, e.g. "m/s".' },
        decimals: { type: 'integer', minimum: 0, description: 'Decimals of the live value. Default 0.' },
        span: { type: 'integer', minimum: 1, description: 'Columns the device spans. Default 1.' },
        ...cellProps,
      },
    },
    readout: {
      description: 'A numeric readout (digital panel meter): the panel\'s analog OUTPUT. Reads a signal and shows its value.',
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Accessible name and legend, e.g. "Distance".' },
        signal: signal('The output it reads (a single value). Use either this or `signals`.'),
        signals: {
          type: 'array', minItems: 2, maxItems: 4,
          description: 'A vector of outputs shown as one instrument (2 to 4). Use either this or `signal`.',
          items: signal('One component of the vector.'),
        },
        componentLabels: {
          type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' },
          description: 'Component captions for `signals`, e.g. ["X","Y","Z"]. One per signal.',
        },
        unit: { type: 'string', description: 'Unit shown after the value, e.g. "m".' },
        decimals: { type: 'integer', minimum: 0, description: 'Decimals. Default 0.' },
        scale: { type: 'number', description: 'The raw value is multiplied by this before display (m to mm: 1000). Default 1.' },
        span: { type: 'integer', minimum: 1, description: 'Columns the device spans. Default 1.' },
        ...cellProps,
      },
    },
    towerSegment: {
      description: 'A stack-light segment, top to bottom.',
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the segment, e.g. "Red".' },
        signal: signal('The output signal that lights the segment.'),
        color: { enum: LAMP_COLORS, description: 'Segment colour (IEC 60204-1).' },
        simDriven: { type: 'boolean', description: 'False when the simulation never writes this segment. Default true.' },
      },
    },
    chip: {
      description: 'A title-bar chip shown while its condition holds (e.g. HAND).',
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Accessible name, e.g. "Operating mode: Hand".' },
        text: { type: 'string', description: 'Chip text.' },
        when: { $ref: '#/definitions/condition', description: 'The chip shows while this holds.' },
        tone: { enum: [...CHIP_TONES], description: 'Chip tone.' },
      },
    },
    keyLegendRow: {
      description: 'One row of the keyboard legend: the keys, and what they do.',
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The keys, e.g. "W / S". A "/" draws each key as its own cap.' },
        text: { type: 'string', description: 'What they do, e.g. "Away from / toward the camera".' },
      },
    },
    status: {
      description: 'One rule of the status strip; the first whose `when` holds wins, a rule without `when` always holds.',
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Stable id of the state (`data-state`), e.g. "fault-estop".' },
        tone: { enum: [...STATUS_TONES], description: 'Tone of the state.' },
        icon: { enum: [...STATUS_ICONS], description: 'Defaults by tone: ok check · neutral hourglass · action play · fault error.' },
        text: { type: 'string', description: 'Status text.' },
        step: { type: 'integer', minimum: 1, description: 'The restart step (1-based) this state is at; omit when no restart is due.' },
        when: { $ref: '#/definitions/condition', description: 'The rule holds while this holds.' },
      },
    },
  },
  properties: {
    version: { const: 1, enum: [1], description: 'Format version.' },
    id: { type: 'string', description: 'Plugin id, window panelId and visibility id.' },
    title: { type: 'string', description: 'Window title.' },
    width: { type: 'number', description: 'Window width in px. Default 300.' },
    resizable: { type: 'boolean', description: 'Let the operator resize the window. Default false (a control box is as big as its plate).' },
    height: { type: 'number', exclusiveMinimum: 0, description: 'Window height in px when resizable; ignored otherwise. Default 420.' },
    position: {
      type: 'object', description: 'Initial window position in px.',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
    density: {
      type: 'string', enum: ['comfortable', 'compact'],
      description: 'How tightly the plate is packed. Default comfortable. compact tightens gaps, the status strip and the readout windows for a plate that sits next to the machine it operates; controls keep their size.',
    },
    columns: { type: 'integer', minimum: 1, description: 'Grid columns (equal widths). Default 3.' },
    buttons: { type: 'array', description: 'Push buttons.', items: { $ref: '#/definitions/button' } },
    selectors: { type: 'array', description: 'Selector switches.', items: { $ref: '#/definitions/selector' } },
    estops: { type: 'array', description: 'Emergency stops.', items: { $ref: '#/definitions/estop' } },
    sliders: { type: 'array', description: 'Setpoint sliders (analog inputs).', items: { $ref: '#/definitions/slider' } },
    readouts: { type: 'array', description: 'Numeric readouts (analog outputs).', items: { $ref: '#/definitions/readout' } },
    stackLight: { type: 'array', description: 'Top to bottom, as the tower shows them.', items: { $ref: '#/definitions/towerSegment' } },
    chips: { type: 'array', description: 'Title-bar chips.', items: { $ref: '#/definitions/chip' } },
    keyLegend: {
      type: 'object',
      description: 'The keyboard legend, drawn under the devices: which keys operate the machine and what each one does. Omit it on a panel operated by pointer alone.',
      properties: {
        title: { type: 'string', description: 'Heading of the card, e.g. "Keyboard — hold".' },
        keys: { type: 'array', minItems: 1, description: 'The rows, in reading order.', items: { $ref: '#/definitions/keyLegendRow' } },
        note: { type: 'string', description: 'One line of prose under the rows, for what a key/effect table cannot say.' },
      },
    },
    status: { type: 'array', description: 'Status strip rules, first match wins.', items: { $ref: '#/definitions/status' } },
    restart: {
      type: 'object', description: 'The restart sequence the status steps refer to.',
      properties: {
        hint: { type: 'string', description: 'Hint shown with the restart steps.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The restart steps in order.' },
      },
    },
    headerEstop: { type: 'integer', minimum: 0, description: 'Which E-stop stays in the title bar when the window is collapsed. Default 0.' },
  },
} as const;

/** Compile-time check: every top-level config key has a schema entry. */
type MissingTopLevel = Exclude<keyof OperatorPanelConfig, keyof typeof OPERATOR_PANEL_JSON_SCHEMA.properties>;
const _noMissingTopLevel: MissingTopLevel extends never ? true : false = true;
void _noMissingTopLevel;
