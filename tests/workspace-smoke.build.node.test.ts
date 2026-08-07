// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadDirectory } from '../scripts/bunny-deploy.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('filtered delivery smoke infrastructure', () => {
  it('remote reconcile deletes stale files after snapshot upload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-reconcile-test-'));
    temporary.push(root);
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), 'ok');
    writeFileSync(join(root, 'assets', 'new.js'), 'new');
    const deleted: string[] = [];
    const client = {
      listRecursive: async () => [
        { rel: 'index.html', size: 2, isDirectory: false },
        { rel: 'assets/foreign-sentinel.js', size: 99, isDirectory: false },
      ],
      putFile: async () => {},
      deleteFile: async (path: string) => { deleted.push(path); },
    };
    const result = await uploadDirectory(client, root, 'demo', { force: false, dryRun: true, alwaysUploadGlbs: false });
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual(['demo/assets/foreign-sentinel.js']);
  });
});
