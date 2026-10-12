// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-372 Phase 10 — the card side of preview generation.
 *
 * The dashboard showed icons for every model and asset because nothing asked
 * `ThumbnailService` for a picture. What is pinned here is the asking: the key
 * identifies the work, the source URL is released once decoded, and an
 * unavailable service is a quiet no-op rather than a throw.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { useAssetThumbnail } from '../src/core/thumbnails/use-asset-thumbnail';
import type { ThumbnailService } from '../src/core/thumbnails/thumbnail-service';
import { buildEmptyGlbBlob } from '../src/core/hmi/scene/empty-glb';

function fakeService(blob: Blob | null, available = true) {
  return {
    isAvailable: available,
    enqueue: vi.fn(async (_key: string, load: () => Promise<unknown>) => {
      if (blob) await load();          // the loader runs only on a cache miss
      return blob;
    }),
    cancel: vi.fn(),
  } as unknown as ThumbnailService & { enqueue: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
}

const KEY = { projectId: 'prj_a', providerId: 'project', sourceId: 'src', assetId: 'a.glb' };

function Probe(props: Parameters<typeof useAssetThumbnail>[0]) {
  const { ref, url, empty } = useAssetThumbnail<HTMLDivElement>(props);
  return <div ref={ref} data-testid="card" data-url={url ?? ''} data-empty={String(empty)} />;
}

describe('useAssetThumbnail', () => {
  it('falls back to generation when a sidecar contains HTML instead of an image', async () => {
    const url = URL.createObjectURL(new Blob(['<!doctype html><html>App</html>'], { type: 'text/html' }));
    const release = vi.fn(() => URL.revokeObjectURL(url));
    const service = fakeService(null);
    const { getByTestId, unmount } = render(
      <Probe service={service} keyParts={KEY} resolve={async () => null}
        sidecar={async () => ({ url, release })} />,
    );
    await waitFor(() => expect(service.enqueue).toHaveBeenCalledOnce());
    expect(getByTestId('card').dataset.url).toBe('');
    expect(release).toHaveBeenCalledOnce();
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses a valid sidecar without generating a preview and releases it on unmount', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    const url = URL.createObjectURL(blob);
    const release = vi.fn(() => URL.revokeObjectURL(url));
    const service = fakeService(null);
    const { getByTestId, unmount } = render(
      <Probe service={service} keyParts={KEY} resolve={async () => null}
        sidecar={async () => ({ url, release })} />,
    );
    await waitFor(() => expect(getByTestId('card').dataset.url).toBe(url));
    expect(service.enqueue).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases a sidecar that resolves after the card unmounts', async () => {
    const release = vi.fn();
    let finish!: (source: { url: string; release: () => void }) => void;
    const pending = new Promise<{ url: string; release: () => void }>(resolve => { finish = resolve; });
    const sidecar = vi.fn(() => pending);
    const service = fakeService(null);
    const { unmount } = render(
      <Probe service={service} keyParts={KEY} resolve={async () => null} sidecar={sidecar} />,
    );
    await waitFor(() => expect(sidecar).toHaveBeenCalledOnce());
    unmount();
    finish({ url: '/unused.png', release });
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(service.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing at all when the service is unavailable', async () => {
    const service = fakeService(null, false);
    render(<Probe service={service} keyParts={KEY} resolve={async () => ({ url: '/a.glb' })} />);
    await new Promise(r => setTimeout(r, 50));
    expect(service.enqueue).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not ask when the entry already has a picture', async () => {
    const service = fakeService(new Blob(['x']));
    render(
      <Probe service={service} keyParts={KEY} enabled={false}
        resolve={async () => ({ url: '/a.glb' })} />,
    );
    await new Promise(r => setTimeout(r, 50));
    expect(service.enqueue).not.toHaveBeenCalled();
    cleanup();
  });

  it('releases the source URL once the model is decoded', async () => {
    const release = vi.fn();
    // The loader throws on decode (no real GLB here); the release must still run.
    const service = fakeService(new Blob(['png']));
    render(
      <Probe service={service} keyParts={KEY}
        resolve={async () => ({ url: 'blob:fake', release })} />,
    );
    await waitFor(() => expect(release).toHaveBeenCalled());
    cleanup();
  });

  it('reports an asset with nothing renderable as empty instead of rendering it', async () => {
    // The exact bytes "New asset" writes: a valid GLB with no meshes. The card
    // must learn the fact rather than receive a picture of nothing.
    const url = URL.createObjectURL(buildEmptyGlbBlob());
    const service = fakeService(new Blob(['png']));
    const { getByTestId } = render(
      <Probe service={service} keyParts={KEY} resolve={async () => ({ url })} />,
    );
    await waitFor(() => expect(getByTestId('card').dataset.empty).toBe('true'));
    expect(getByTestId('card').dataset.url).toBe('');
    URL.revokeObjectURL(url);
    cleanup();
  });

  it('keys the request by identity, not by URL', async () => {
    const service = fakeService(new Blob(['png']));
    render(<Probe service={service} keyParts={KEY} resolve={async () => ({ url: 'blob:one' })} />);
    await waitFor(() => expect(service.enqueue).toHaveBeenCalled());
    const key = service.enqueue.mock.calls[0]![0] as string;
    expect(key).toContain('prj_a');
    expect(key).toContain('a.glb');
    expect(key).not.toContain('blob:one');
    cleanup();
  });
});
