// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-channel-manifest.node.test.ts — T27 of plan-343.
 *
 * The CONNECT beta channel used to be addressed two different ways:
 * `download/connect-beta.json` (connect-downloads.ts) and
 * `download/beta/connect-latest.json` (deliver.mjs, get-connect.mjs, and the
 * delivery contract test). Both answered 404, so the split was invisible —
 * and would have stayed invisible right up to the first real beta publish,
 * where half the tree would have looked in the wrong place.
 *
 * `download/connect-beta.json` is the one path. This test holds every place
 * that builds a channel manifest URL to it, so the split cannot come back.
 * The C# half of the same contract is asserted in UpdateManifestParserTests.
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECT_STABLE_MANIFEST_URL,
  CONNECT_BETA_MANIFEST_URL,
} from '@rv/core/hmi/connect-downloads';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DELIVER = resolve(__dirname, '../scripts/deliver.mjs');
const GET_CONNECT = resolve(
  __dirname,
  '../../realvirtual-WebViewer-Private~/scripts/get-connect.mjs',
);

const STABLE_MANIFEST = 'https://web.realvirtual.io/download/connect-latest.json';
const BETA_MANIFEST = 'https://web.realvirtual.io/download/connect-beta.json';
/** The retired form. Nothing may build it any more. */
const LEGACY_BETA = /\/download\/[^'"`\s]*beta\/connect-latest\.json/;

describe('CONNECT channel manifest paths (plan-343 T27)', () => {
  it('connect-downloads.ts probes the unified paths', () => {
    expect(CONNECT_STABLE_MANIFEST_URL).toBe(STABLE_MANIFEST);
    expect(CONNECT_BETA_MANIFEST_URL).toBe(BETA_MANIFEST);
  });

  it('deliver.mjs requests connect-beta.json for the beta channel', async () => {
    const deliverModule = (await import(new URL('../scripts/deliver.mjs', import.meta.url).href)) as {
      resolveConnectLock: (channel: string, tmpBase: string, fetchImpl?: typeof fetch) =>
        Promise<{ lockPath: string; channel: string }>;
    };
    const root = mkdtempSync(join(tmpdir(), 'rv-connect-manifest-path-'));
    const requested: string[] = [];
    const fetchMock = (async (input: unknown) => {
      requested.push(String(input));
      // Every channel 404s, which drives the beta lane into its stable fallback and lets one run
      // observe BOTH URLs.
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    const previousLock = process.env.RV_CONNECT_LOCK;
    delete process.env.RV_CONNECT_LOCK;
    try {
      await expect(deliverModule.resolveConnectLock('beta', root, fetchMock)).rejects.toThrow();
      expect(requested).toEqual([BETA_MANIFEST, STABLE_MANIFEST]);
    } finally {
      if (previousLock === undefined) delete process.env.RV_CONNECT_LOCK;
      else process.env.RV_CONNECT_LOCK = previousLock;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no source builds the retired download/beta/connect-latest.json path', () => {
    const sources = [DELIVER, GET_CONNECT].filter(existsSync);
    // deliver.mjs always exists; get-connect.mjs only in a checkout that has the private sibling.
    expect(sources).toContain(DELIVER);
    for (const path of sources) {
      expect(readFileSync(path, 'utf-8')).not.toMatch(LEGACY_BETA);
    }
  });

  it.skipIf(!existsSync(GET_CONNECT))(
    'get-connect.mjs resolves the same beta manifest URL',
    async () => {
      const getConnect = (await import(new URL(`file://${GET_CONNECT}`).href)) as {
        getConnect: (options: Record<string, unknown>) => Promise<unknown>;
      };
      const root = mkdtempSync(join(tmpdir(), 'rv-get-connect-path-'));
      const lockPath = join(root, 'connect.lock.json');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        lockPath,
        JSON.stringify({
          channel: 'beta',
          version: '0.0.1',
          url: 'https://web.realvirtual.io/download/versions/realvirtual-Connect-0.0.1+1.exe',
          sha256: 'ab'.repeat(32),
        }),
      );

      const requested: string[] = [];
      const fetchImpl = (async (input: unknown) => {
        requested.push(String(input));
        return { ok: false, status: 404 } as Response;
      }) as typeof fetch;

      try {
        await expect(
          getConnect.getConnect({
            workspaceRoot: root,
            lockPath,
            latest: true,
            platform: 'win-x64',
            fetchImpl,
          }),
        ).rejects.toThrow();
        expect(requested[0]).toBe(BETA_MANIFEST);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
