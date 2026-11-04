// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Quarantine fixture (plan-602 § 9.5) — run ONLY as a vitest child by
 * tests/quarantine.node.test.ts. A failing hook around a quarantined test whose body
 * fails for its KNOWN cause must stay red: only the body is quarantined.
 */
import { afterEach, beforeEach, describe } from 'vitest';
import { createQuarantinedIt } from '../../helpers/quarantine';

const FILE = 'tests/fixtures/quarantine/hook-failure.test.ts';
const CAUSE = 'webgpu fell back (fixture)';
const BEFORE = `${FILE} :: beforeEach throws > known cause in the body`;
const AFTER = `${FILE} :: afterEach throws > known cause in the body`;
const quarantinedIt = createQuarantinedIt([{ id: BEFORE, cause: CAUSE }, { id: AFTER, cause: CAUSE }]);

describe('beforeEach throws', () => {
  beforeEach(() => { throw new Error('beforeEach failed'); });
  // expected: failed
  quarantinedIt(BEFORE, /webgpu fell back/, () => { throw new Error(CAUSE); });
});

describe('afterEach throws', () => {
  afterEach(() => { throw new Error('afterEach failed'); });
  // expected: failed
  quarantinedIt(AFTER, /webgpu fell back/, () => { throw new Error(CAUSE); });
});
