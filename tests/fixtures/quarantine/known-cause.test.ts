// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Quarantine fixture (plan-602 § 9.5) — run ONLY as a vitest child by
 * tests/quarantine.node.test.ts. Each test states the status the parent expects.
 * `RV_QFIX_IMPORT_ERROR=1` makes the file fail at import (a module that does not exist).
 */
import { describe, onTestFinished } from 'vitest';
import { createQuarantinedIt, type QuarantineEntry } from '../../helpers/quarantine';

if (process.env.RV_QFIX_IMPORT_ERROR === '1') {
  const missing = './does-not-exist.fixture';
  await import(/* @vite-ignore */ missing);
}

const FILE = 'tests/fixtures/quarantine/known-cause.test.ts';
const SUITE = 'quarantine fixture';
const id = (title: string): string => `${FILE} :: ${SUITE} > ${title}`;
const CAUSE = 'webgpu fell back (fixture)';
const LIST: QuarantineEntry[] = [
  'known cause in the body',
  'body passes',
  'unknown error in the body',
  'runner timeout',
  'unknown body error plus failing cleanup',
  'known cause plus failing cleanup',
].map((title) => ({ id: id(title), cause: title === 'runner timeout' ? 'Test timed out' : CAUSE }));
const quarantinedIt = createQuarantinedIt(LIST);

describe(SUITE, () => {
  // expected: passed, "[quarantine] known failure" logged
  quarantinedIt(id('known cause in the body'), /webgpu fell back/, () => {
    throw new Error('webgpu fell back (fixture)');
  });

  // expected: failed — "quarantined test now passes"
  quarantinedIt(id('body passes'), /webgpu fell back/, () => {});

  // expected: failed — the unknown error is rethrown
  quarantinedIt(id('unknown error in the body'), /webgpu fell back/, () => {
    throw new Error('something else broke');
  });

  // expected: failed — even with a cause matching the timeout message, the runner's timeout stays red
  quarantinedIt(id('runner timeout'), /timed out/, () => new Promise((r) => setTimeout(r, 5_000)), 200);

  // expected: failed
  quarantinedIt(id('unknown body error plus failing cleanup'), /webgpu fell back/, () => {
    onTestFinished(() => { throw new Error('cleanup failed'); });
    throw new Error('something else broke');
  });

  // expected: failed — a failing cleanup is not the body
  quarantinedIt(id('known cause plus failing cleanup'), /webgpu fell back/, () => {
    onTestFinished(() => { throw new Error('cleanup failed'); });
    throw new Error('webgpu fell back (fixture)');
  });
});
