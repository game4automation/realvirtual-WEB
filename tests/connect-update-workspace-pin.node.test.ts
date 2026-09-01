// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-update-workspace-pin.node.test.ts — plan-343 Phase 4.
 *
 * A developer workspace has two authorities over which CONNECT build runs, and they can disagree.
 * `get-connect.mjs` restores the pinned build on every start; a CONNECT self-update replaces the
 * program file behind its back. If the update does not carry `connect.lock.json` along, the next
 * start silently reinstalls the previous version and the update appears to un-happen — which is
 * the whole reason F6 exists.
 *
 * These tests drive the REAL `get-connect.mjs` against a real workspace layout and assert both
 * directions of the transaction:
 *
 *  - after a committed update, the workspace keeps the new build (and does not re-download it),
 *  - after a rollback, pin and executable are consistent on the previous build again,
 *  - and, as the control that keeps the first assertion honest, a pin that was NOT carried along
 *    really does drag the old version back.
 *
 * Everything runs offline: the pin URLs are served by a fetch double, never by a network. The pin
 * content is the four-field projection `UpdatePin.Project` writes (channel, version, url, sha256,
 * foreign fields preserved); that the C# side really produces something this script accepts is
 * asserted from the other end in `UpdatePinContractTests`.
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GET_CONNECT = resolve(__dirname, '../../realvirtual-WebViewer-Private~/scripts/get-connect.mjs');

const OLD_VERSION = '0.3.0';
const NEW_VERSION = '0.4.0';
const OLD_BYTES = 'CONNECT-0.3.0-program-bytes';
const NEW_BYTES = 'CONNECT-0.4.0-program-bytes';
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
const urlFor = (version: string, build: number) =>
  `https://web.realvirtual.io/download/versions/realvirtual-Connect-${version}+${build}.exe`;

/** The exact shape `UpdatePin.Project` writes: four owned fields, everything else preserved. */
function pinContent(version: string, build: number, bytes: string, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    channel: 'stable',
    version,
    url: urlFor(version, build),
    sha256: sha256(bytes),
    ...extra,
  }, null, 2)}\n`;
}

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

/**
 * A workspace as `generate-customer-workspace.mjs` leaves it: a pin at the root and, under
 * `tools/connect/`, both the versioned download and the fixed name the start scripts launch.
 */
function workspace(pinVersion: string, pinBuild: number, pinBytes: string) {
  const root = mkdtempSync(join(tmpdir(), 'rv-connect-workspace-pin-'));
  temporary.push(root);
  const connectDir = join(root, 'tools', 'connect');
  mkdirSync(connectDir, { recursive: true });
  writeFileSync(join(root, 'connect.lock.json'), pinContent(pinVersion, pinBuild, pinBytes, { note: 'hand-added' }));
  writeFileSync(join(connectDir, `realvirtual-Connect-${OLD_VERSION}+10.exe`), OLD_BYTES);
  writeFileSync(join(connectDir, 'realvirtual-Connect.exe'), OLD_BYTES);
  return {
    root,
    connectDir,
    pinPath: join(root, 'connect.lock.json'),
    target: join(connectDir, 'realvirtual-Connect.exe'),
    versioned: (version: string, build: number) => join(connectDir, `realvirtual-Connect-${version}+${build}.exe`),
  };
}

/** Serves the immutable /versions/ artifacts and records every URL anyone asked for. */
function downloadDouble() {
  const requested: string[] = [];
  const bodies = new Map([[urlFor(OLD_VERSION, 10), OLD_BYTES], [urlFor(NEW_VERSION, 12), NEW_BYTES]]);
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    const body = bodies.get(url);
    if (!body) return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) } as unknown as Response;
  }) as typeof fetch;
  return { requested, fetchImpl };
}

async function loadGetConnect() {
  const module = (await import(new URL(`file://${GET_CONNECT}`).href)) as {
    getConnect: (options: Record<string, unknown>) => Promise<{ target: string; cached: boolean }>;
  };
  return module.getConnect;
}

const describeWithPrivate = existsSync(GET_CONNECT) ? describe : describe.skip;

// The private sibling carries get-connect.mjs; a public-only checkout has nothing to integrate with.
describeWithPrivate('CONNECT self-update and the workspace pin (plan-343 Phase 4)', () => {
  it('keeps the updated build after a committed update, without downloading it again', async () => {
    const getConnect = await loadGetConnect();
    const space = workspace(OLD_VERSION, 10, OLD_BYTES);
    const { requested, fetchImpl } = downloadDouble();

    // What a committed update leaves behind: the helper replaced the launched file and then wrote
    // the pin (commit order pin -> job -> .old), and neither step creates a versioned file name.
    writeFileSync(space.target, NEW_BYTES);
    writeFileSync(space.pinPath, pinContent(NEW_VERSION, 12, NEW_BYTES, { note: 'hand-added' }));

    const result = await getConnect({
      workspaceRoot: space.root, platform: 'win-x64', fetchImpl,
    });

    // The next start must neither pull 0.3.0 back nor spend ~225 MB re-fetching bytes it has.
    expect(requested).toEqual([]);
    expect(result.cached).toBe(true);
    expect(readFileSync(space.target, 'utf8')).toBe(NEW_BYTES);
    expect(existsSync(space.versioned(OLD_VERSION, 10))).toBe(true); // the old download is not deleted, only unused
    expect(readFileSync(space.versioned(NEW_VERSION, 12), 'utf8')).toBe(NEW_BYTES);
    // The update owns four fields and nothing else.
    const pin = JSON.parse(readFileSync(space.pinPath, 'utf8'));
    expect(pin).toMatchObject({ channel: 'stable', version: NEW_VERSION, note: 'hand-added' });
    expect(pin.build).toBeUndefined();
  });

  // Control for the test above: without the pin transaction the workspace really does undo the
  // update, so the assertion "the new build survives" is not passing for some unrelated reason.
  it('drags the previous build back when the pin was not carried along', async () => {
    const getConnect = await loadGetConnect();
    const space = workspace(OLD_VERSION, 10, OLD_BYTES);
    const { requested, fetchImpl } = downloadDouble();

    // Program file swapped, pin left untouched — the failure mode F6 exists to prevent.
    writeFileSync(space.target, NEW_BYTES);
    rmSync(space.versioned(OLD_VERSION, 10));

    await getConnect({ workspaceRoot: space.root, platform: 'win-x64', fetchImpl });

    expect(requested).toEqual([urlFor(OLD_VERSION, 10)]);
    expect(readFileSync(space.target, 'utf8')).toBe(OLD_BYTES);
  });

  it('leaves pin and program file consistent after a rollback', async () => {
    const getConnect = await loadGetConnect();
    const space = workspace(OLD_VERSION, 10, OLD_BYTES);
    const before = readFileSync(space.pinPath, 'utf8');
    const { requested, fetchImpl } = downloadDouble();

    // A rollback restores the captured pin content byte for byte and puts `.old` back in place.
    writeFileSync(space.pinPath, pinContent(NEW_VERSION, 12, NEW_BYTES, { note: 'hand-added' }));
    writeFileSync(space.target, NEW_BYTES);
    writeFileSync(space.pinPath, before);
    writeFileSync(space.target, OLD_BYTES);

    const result = await getConnect({ workspaceRoot: space.root, platform: 'win-x64', fetchImpl });

    expect(requested).toEqual([]);
    expect(result.cached).toBe(true);
    expect(readFileSync(space.pinPath, 'utf8')).toBe(before);
    expect(readFileSync(space.target, 'utf8')).toBe(OLD_BYTES);
    expect(existsSync(join(space.connectDir, `realvirtual-Connect-${NEW_VERSION}+12.exe`))).toBe(false);
  });

  it('redirects a mutable artifact URL to the immutable /versions/ copy of the same build', async () => {
    // The contract changed with `withImmutableUrl` (get-connect afdbc5f): a pin
    // naming a mutable file (the stable manifest advertises exactly that) is no
    // longer refused — the URL is rebuilt from version(+build) under
    // /download/versions/ and THAT copy is fetched. The mutable URL itself must
    // never be requested: it is overwritten by every deploy, so its bytes could
    // silently disagree with the pinned sha256.
    const getConnect = await loadGetConnect();
    const space = workspace(OLD_VERSION, 10, OLD_BYTES);
    const mutableUrl = 'https://web.realvirtual.io/download/realvirtual-Connect-beta.exe';
    const immutableUrl = 'https://web.realvirtual.io/download/versions/realvirtual-Connect-0.4.0-beta2.exe';

    const requested: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url !== immutableUrl) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(NEW_BYTES) } as unknown as Response;
    }) as typeof fetch;

    writeFileSync(space.pinPath, JSON.stringify({
      channel: 'beta', version: '0.4.0-beta2',
      url: mutableUrl,
      sha256: sha256(NEW_BYTES),
    }));

    await getConnect({ workspaceRoot: space.root, platform: 'win-x64', fetchImpl });

    expect(requested).toEqual([immutableUrl]);
    expect(readFileSync(space.target, 'utf8')).toBe(NEW_BYTES);
  });
});
