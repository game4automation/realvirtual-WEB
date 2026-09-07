// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 follow-up — the `deprecated` FieldDescriptor flag.
 *
 * A deprecated field is kept in the schema so an older document still validates,
 * but nothing reads it. Offering an editor for it is a lie; dropping it silently
 * when a document DOES carry a value is worse, because the user then has no way
 * of seeing why the file's value is ignored. Hence the rule this file pins down:
 *
 *   empty  → no inspector row at all,
 *   value  → a row, read-only, tagged "(deprecated)".
 *
 * `RibbonPath.ConnectedDrive` / `SpeedSource` are the first two fields carrying
 * the keyword, so the rv-ODT spec is checked here too — the skip rule is only
 * worth anything if the flag actually survives the schema load.
 */

import { describe, it, expect } from 'vitest';
import { loadSchemaFromSpec, type FieldDescriptor } from '../src/core/engine/rv-component-registry';
import { hasDeprecatedValue, isDeprecatedFieldHidden } from '../src/core/hmi/rv-inspector-helpers';
import { isFieldEditable } from '../src/core/hmi/rv-field-row';

const REF: FieldDescriptor = { type: 'componentRef', deprecated: true };
const ENUM: FieldDescriptor = {
  type: 'enum',
  enumMap: { Drive: 'Drive', RibbonWinder: 'RibbonWinder' },
  default: 'Drive',
  deprecated: true,
};
const LIVE: FieldDescriptor = { type: 'number', default: 0 };

describe('isDeprecatedFieldHidden', () => {
  it('hides a deprecated field that is empty', () => {
    for (const empty of [undefined, null, '', []]) {
      expect(isDeprecatedFieldHidden(REF, empty)).toBe(true);
    }
  });

  it('hides a deprecated field whose value is still the schema default', () => {
    // A document stamped with the default never set anything — nothing to explain.
    expect(isDeprecatedFieldHidden(ENUM, 'Drive')).toBe(true);
  });

  it('SHOWS a deprecated field a document actually set', () => {
    expect(isDeprecatedFieldHidden(ENUM, 'RibbonWinder')).toBe(false);
    expect(isDeprecatedFieldHidden(REF, { type: 'ComponentReference', path: 'Root/Nip' })).toBe(false);
    expect(hasDeprecatedValue(REF, { type: 'ComponentReference', path: 'Root/Nip' })).toBe(true);
  });

  it('never hides a live field, whatever its value', () => {
    for (const value of [undefined, null, '', [], 0, 5]) {
      expect(isDeprecatedFieldHidden(LIVE, value)).toBe(false);
    }
    expect(isDeprecatedFieldHidden(undefined, undefined)).toBe(false);
  });
});

describe('a deprecated field is never editable', () => {
  it('even when it is a consumed, non-reference, non-readonly field', () => {
    expect(isFieldEditable('consumed', false, ENUM)).toBe(false);
    // The control: the same descriptor without the flag IS editable.
    expect(isFieldEditable('consumed', false, { ...ENUM, deprecated: undefined })).toBe(true);
  });
});

describe('rv-ODT carries the flag for the two dead RibbonPath fields', () => {
  it('ConnectedDrive and SpeedSource load as deprecated, the live fields do not', () => {
    const schema = loadSchemaFromSpec('RibbonPath');
    expect(schema.ConnectedDrive.deprecated).toBe(true);
    expect(schema.SpeedSource.deprecated).toBe(true);
    expect(schema.Rollers.deprecated).toBeUndefined();
    expect(schema.RibbonWidthMm.deprecated).toBeUndefined();
  });
});
