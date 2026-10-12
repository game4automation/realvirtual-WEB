// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * operator-panel-snippets.ts — insertable devices for the operator panel JSON
 * editor (plan-555 F7). Each snippet is ONE array element (Monaco snippet
 * syntax) offered at an element position of its `arrayKey`; with its
 * placeholders expanded it is a valid element — only its signal names still
 * have to exist in the model.
 */

import type { JsonSnippet } from '../json-editor/rv-json-field-context';

export const OPERATOR_PANEL_SNIPPETS: readonly JsonSnippet[] = [
  {
    arrayKey: 'buttons',
    label: 'Button',
    detail: 'Illuminated push button',
    body: '{ "label": "${1:Start}", "signal": "${2:S_Start}", "capColor": "${3|green,red,yellow,blue,white,black|}", "row": ${4:1}, "col": ${5:1} }',
  },
  {
    arrayKey: 'selectors',
    label: 'Selector',
    detail: 'Two-position selector switch',
    body: '{ "label": "${1:Mode}", "variant": "${2|knob,key|}", "signal": "${3:S_Auto}", "positions": [{ "legend": "${4:Hand}", "value": false }, { "legend": "${5:Auto}", "value": true }], "row": ${6:1}, "col": ${7:1} }',
  },
  {
    arrayKey: 'estops',
    label: 'E-stop',
    detail: 'Emergency stop (normally closed)',
    body: '{ "label": "${1:E-stop}", "signal": "${2:S_EStop}", "row": ${3:1}, "col": ${4:1} }',
  },
  {
    arrayKey: 'stackLight',
    label: 'Stack-light segment',
    detail: 'One segment of the stack light',
    body: '{ "name": "${1:Red}", "signal": "${2:L_Fault}", "color": "${3|red,yellow,green,blue,white|}" }',
  },
  {
    arrayKey: 'status',
    label: 'Status rule',
    detail: 'Status strip rule (first match wins)',
    body: '{ "kind": "${1:fault}", "tone": "${2|fault,ok,neutral,action|}", "text": "${3:FAULT}", "when": { "signal": "${4:S_EStop}", "is": ${5|false,true|} } }',
  },
  {
    arrayKey: 'chips',
    label: 'Chip',
    detail: 'Title-bar chip shown while its condition holds',
    body: '{ "label": "${1:Operating mode: Hand}", "text": "${2:HAND}", "when": { "signal": "${3:S_Auto}", "is": ${4|false,true|} }, "tone": "${5|warn,neutral|}" }',
  },
];
