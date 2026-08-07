// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error — plain JavaScript deploy module has no declaration file.
import * as embedDeploy from '../scripts/embed-deploy.mjs';

const {
  EmbedDeliveryClient,
  assertEmbedPublicUrl,
  assertEmbedRemotePath,
  deployEmbedArtifacts,
  embedPublicUrl,
  embedPrefixes,
  isContentHashedArtifact,
  loadEmbedDeployConfig,
  majorMinorVersion,
  sha256,
} = embedDeploy;

interface TestArtifact {
  rel: string;
  bytes: Buffer;
  size: number;
  hash: string;
}

function artifact(rel: string, value: string): TestArtifact {
  const bytes = Buffer.from(value);
  return { rel, bytes, size: bytes.length, hash: sha256(bytes) };
}

class MockEmbedClient {
  readonly stored = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly gets: string[] = [];
  readonly deleteFile = vi.fn(() => {
    throw new Error('DELETE must never be called by the rv-embed publisher');
  });

  async putFile(bytes: Buffer, remotePath: string): Promise<void> {
    this.puts.push(remotePath);
    this.stored.set(remotePath, Buffer.from(bytes));
  }

  async getFile(remotePath: string): Promise<Buffer> {
    this.gets.push(remotePath);
    const bytes = this.stored.get(remotePath);
    if (!bytes) throw new Error(`Missing mock upload: ${remotePath}`);
    return Buffer.from(bytes);
  }
}

class MockDeliveryClient {
  readonly purges: string[] = [];
  readonly publicGets: string[] = [];

  constructor(private readonly storage: MockEmbedClient) {}

  async purgeUrl(publicUrl: string): Promise<void> {
    this.purges.push(publicUrl);
  }

  async getPublicFile(publicUrl: string): Promise<Buffer> {
    this.publicGets.push(publicUrl);
    const remotePath = new URL(publicUrl).pathname.replace(/^\/+/, '');
    const bytes = this.storage.stored.get(remotePath);
    if (!bytes) throw new Error(`Missing mock public artifact: ${publicUrl}`);
    return Buffer.from(bytes);
  }
}

describe('rv-embed Bunny publish', () => {
  it('derives the pinned /embed/vX.Y/ and latest prefixes from package semver', () => {
    expect(majorMinorVersion('6.3.5')).toBe('6.3');
    expect(majorMinorVersion('7.0.0-beta.2')).toBe('7.0');
    expect(embedPrefixes('6.3.5')).toEqual({
      version: 'embed/v6.3',
      latest: 'embed/latest',
    });
  });

  it('uploads and SHA-256 verifies every artifact under both prefixes', async () => {
    const client = new MockEmbedClient();
    const deliveryClient = new MockDeliveryClient(client);
    const artifacts = [
      artifact('chunks/engine-AbCd1234.js', 'chunk'),
      artifact('rv-embed.js', 'entry'),
      artifact('test/index.html', '<html>test</html>'),
    ];

    const result = await deployEmbedArtifacts({
      client,
      deliveryClient,
      artifacts,
      version: '6.3.5',
      publicVerifyBackoffMs: [],
      log: vi.fn(),
    });

    expect(client.puts).toEqual([
      'embed/v6.3/chunks/engine-AbCd1234.js',
      'embed/v6.3/rv-embed.js',
      'embed/v6.3/test/index.html',
      'embed/latest/chunks/engine-AbCd1234.js',
      'embed/latest/rv-embed.js',
      'embed/latest/test/index.html',
    ]);
    expect(client.gets).toEqual(client.puts);
    expect(deliveryClient.purges).toEqual([
      'https://realvirtual.io/embed/v6.3/rv-embed.js',
      'https://realvirtual.io/embed/v6.3/test/index.html',
      'https://realvirtual.io/embed/latest/rv-embed.js',
      'https://realvirtual.io/embed/latest/test/index.html',
    ]);
    expect(deliveryClient.publicGets).toEqual(deliveryClient.purges);
    expect(result.results).toHaveLength(artifacts.length * 2);
    expect(result.results.every((entry: { verified: boolean }) => entry.verified)).toBe(true);
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it('switches latest only after the complete pinned prefix verified', async () => {
    const client = new MockEmbedClient();
    const deliveryClient = new MockDeliveryClient(client);
    const artifacts = [
      artifact('chunks/engine-AbCd1234.js', 'chunk'),
      artifact('rv-embed.js', 'entry'),
    ];

    await deployEmbedArtifacts({
      client,
      deliveryClient,
      artifacts,
      version: '6.3.5',
      publicVerifyBackoffMs: [],
      log: vi.fn(),
    });

    const firstLatest = client.puts.findIndex((path) => path.startsWith('embed/latest/'));
    expect(firstLatest).toBe(artifacts.length);
    expect(client.gets.slice(0, artifacts.length).every((path) => path.startsWith('embed/v6.3/')))
      .toBe(true);
  });

  it('fails hard when the re-downloaded bytes were corrupted', async () => {
    const client = new MockEmbedClient();
    client.getFile = async (remotePath: string) => {
      client.gets.push(remotePath);
      return Buffer.from('edge-corruption');
    };

    await expect(deployEmbedArtifacts({
      client,
      deliveryClient: new MockDeliveryClient(client),
      artifacts: [artifact('rv-embed.js', 'expected')],
      version: '6.3.5',
      publicVerifyBackoffMs: [],
      log: vi.fn(),
    })).rejects.toThrow(/Hash verification failed.*embed\/v6\.3\/rv-embed\.js/);
    expect(client.puts).toEqual(['embed/v6.3/rv-embed.js']);
    expect(client.puts.some((path) => path.startsWith('embed/latest/'))).toBe(false);
  });

  it('refuses writes outside /embed/ and never invokes delete cleanup', async () => {
    expect(() => assertEmbedRemotePath('website/index.html')).toThrow(/outside \/embed\//);
    expect(() => assertEmbedRemotePath('embed/v6.3/../index.html')).toThrow(/Unsafe/);

    const client = new MockEmbedClient();
    await expect(deployEmbedArtifacts({
      client,
      deliveryClient: new MockDeliveryClient(client),
      artifacts: [artifact('../website-index.html', 'escape')],
      version: '6.3.5',
      publicVerifyBackoffMs: [],
      log: vi.fn(),
    })).rejects.toThrow(/Unsafe embed remote path/);
    expect(client.puts).toHaveLength(0);
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it('purges only non-hashed manifest artifacts, including entry, test and vignette URLs', async () => {
    const client = new MockEmbedClient();
    const deliveryClient = new MockDeliveryClient(client);
    const artifacts = [
      artifact('chunks/index-C4Hjr2zV.js', 'chunk'),
      artifact('assets/rv-sig-worker-DXTf_OHr.js', 'worker'),
      artifact('rv-embed.js', 'entry'),
      artifact('test/index.html', '<html>test</html>'),
      artifact('vignettes/conveyor-sensor.glb', 'glb'),
    ];

    await deployEmbedArtifacts({
      client,
      deliveryClient,
      artifacts,
      version: '6.3.5',
      publicVerifyBackoffMs: [],
      log: vi.fn(),
    });

    expect(isContentHashedArtifact('chunks/index-C4Hjr2zV.js')).toBe(true);
    expect(isContentHashedArtifact('assets/rv-sig-worker-DXTf_OHr.js')).toBe(true);
    expect(isContentHashedArtifact('rv-embed.js')).toBe(false);
    expect(deliveryClient.purges).toHaveLength(6);
    expect(deliveryClient.purges).toEqual(expect.arrayContaining([
      'https://realvirtual.io/embed/v6.3/rv-embed.js',
      'https://realvirtual.io/embed/v6.3/test/index.html',
      'https://realvirtual.io/embed/v6.3/vignettes/conveyor-sensor.glb',
      'https://realvirtual.io/embed/latest/rv-embed.js',
      'https://realvirtual.io/embed/latest/test/index.html',
      'https://realvirtual.io/embed/latest/vignettes/conveyor-sensor.glb',
    ]));
    expect(deliveryClient.purges.every((url) => !url.includes('C4Hjr2zV'))).toBe(true);
    expect(deliveryClient.purges.every((url) => !url.includes('DXTf_OHr'))).toBe(true);
  });

  it('never constructs or accepts a purge URL outside /embed/', () => {
    expect(embedPublicUrl('embed/latest/rv-embed.js'))
      .toBe('https://realvirtual.io/embed/latest/rv-embed.js');
    expect(() => embedPublicUrl('website/index.html')).toThrow(/outside \/embed\//);
    expect(() => assertEmbedPublicUrl('https://realvirtual.io/website/index.html'))
      .toThrow(/outside \/embed\//);
    expect(() => assertEmbedPublicUrl('https://example.com/embed/latest/rv-embed.js'))
      .toThrow(/outside https:\/\/realvirtual\.io\/embed\//);
  });

  it('calls only the exact Bunny path-purge endpoint with the account API key', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const deliveryClient = new EmbedDeliveryClient({
      apiKey: 'account-secret',
      fetchImpl: fetchMock,
    });

    await deliveryClient.purgeUrl('https://realvirtual.io/embed/latest/rv-embed.js');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [string | URL | Request, RequestInit | undefined]
    >;
    const [requestUrl, init] = fetchCalls[0];
    const endpoint = new URL(String(requestUrl));
    expect(endpoint.origin + endpoint.pathname).toBe('https://api.bunny.net/purge');
    expect(endpoint.searchParams.get('url'))
      .toBe('https://realvirtual.io/embed/latest/rv-embed.js');
    expect(endpoint.searchParams.get('async')).toBe('false');
    expect(init).toEqual({
      method: 'POST',
      headers: { AccessKey: 'account-secret' },
    });

    await expect(deliveryClient.purgeUrl('https://realvirtual.io/index.html'))
      .rejects.toThrow(/outside \/embed\//);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails when public delivery remains stale despite successful storage verification', async () => {
    const client = new MockEmbedClient();
    const deliveryClient = new MockDeliveryClient(client);
    deliveryClient.getPublicFile = async (publicUrl: string) => {
      deliveryClient.publicGets.push(publicUrl);
      return Buffer.from('stale-edge-content');
    };

    await expect(deployEmbedArtifacts({
      client,
      deliveryClient,
      artifacts: [artifact('rv-embed.js', 'current-content')],
      version: '6.3.5',
      publicVerifyBackoffMs: [0, 0],
      sleep: vi.fn(async () => undefined),
      log: vi.fn(),
    })).rejects.toThrow(
      /Public hash verification failed.*realvirtual\.io\/embed\/v6\.3\/rv-embed\.js/,
    );
    expect(client.gets).toEqual(['embed/v6.3/rv-embed.js']);
    expect(deliveryClient.purges).toEqual([
      'https://realvirtual.io/embed/v6.3/rv-embed.js',
    ]);
    expect(deliveryClient.publicGets).toHaveLength(3);
    expect(client.puts.some((path) => path.startsWith('embed/latest/'))).toBe(false);
  });

  it('requires the website pull-zone guard and all dedicated credentials for live mode', () => {
    expect(() => loadEmbedDeployConfig({}, { dryRun: false }))
      .toThrow(/RV_EMBED_BUNNY_PULL_ZONE_ID/);
    expect(() => loadEmbedDeployConfig({
      RV_EMBED_BUNNY_PULL_ZONE_ID: '5489019',
      RV_EMBED_BUNNY_STORAGE_ZONE: 'wrong-zone',
      RV_EMBED_BUNNY_STORAGE_KEY: 'secret',
    }, { dryRun: false })).toThrow(/5668163/);
    expect(() => loadEmbedDeployConfig({
      RV_EMBED_BUNNY_PULL_ZONE_ID: '5668163',
      RV_EMBED_BUNNY_STORAGE_ZONE: 'website-zone',
      RV_EMBED_BUNNY_STORAGE_KEY: 'storage-secret',
    }, { dryRun: false })).toThrow(/WARNING.*RV_EMBED_BUNNY_API_KEY.*30 days/);
    expect(() => loadEmbedDeployConfig({}, { dryRun: true })).not.toThrow();
  });
});
