// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NEWS_CONTRACT_VERSION,
  parseNewsResponse,
} from '../src/core/news-store';

const FIXTURE_SHA256 = 'd70ca04b13ca1931518007244a2ffe276419264c07882a8fbaae429f0020cfcc';
const fixturePath = resolve('tests/fixtures/news-contract-v1.sample.json');

describe('news contract v1 fixture', () => {
  it('keeps the vendored raw bytes pinned to the SSOT hash literal', () => {
    const raw = readFileSync(fixturePath);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_SHA256);
  });

  it('parses the pinned contract version through the production consumer parser', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    const envelope = JSON.parse(raw) as { contract: unknown; items: unknown[] };
    expect(envelope.contract).toBe(NEWS_CONTRACT_VERSION);
    const parsed = parseNewsResponse(envelope);
    expect(parsed).toHaveLength(envelope.items.length);
    expect(parsed.map((item) => item.id)).toEqual([
      '66a111111111111111111111',
      '66a222222222222222222222',
      '66a333333333333333333333',
      '66a444444444444444444444',
    ]);
  });
});
