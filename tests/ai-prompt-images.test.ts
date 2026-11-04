// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import {
  createAiPromptImageResources,
  MAX_AI_PROMPT_IMAGE_BYTES,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-images';

const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('ai-prompt-images', () => {
  it('creates one URL per image and globally retains at most eight', () => {
    const createObjectURL = vi.fn((_blob: Blob) => `blob:test-${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    const resources = createAiPromptImageResources({ createObjectURL, revokeObjectURL });

    const first = resources.add([{ id: 'image-0', mediaType: 'image/png', base64: ONE_PIXEL }]);
    resources.add([{ id: 'image-0', mediaType: 'image/png', base64: ONE_PIXEL }]);
    const rest = resources.add(Array.from({ length: 8 }, (_, index) => ({
      id: `image-${index + 1}`, mediaType: 'image/png', base64: ONE_PIXEL,
    })));

    expect(first.accepted[0]?.url).toBe('blob:test-1');
    expect(createObjectURL).toHaveBeenCalledTimes(9);
    expect(resources.list()).toHaveLength(8);
    expect(resources.get('image-0')).toBeUndefined();
    expect(rest.evictedIds).toEqual(['image-0']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');

    resources.clear();
    expect(revokeObjectURL).toHaveBeenCalledTimes(9);
    expect(resources.list()).toHaveLength(0);
  });

  it('rejects decoded payloads above five MB without creating a URL', () => {
    const createObjectURL = vi.fn(() => 'blob:never');
    const resources = createAiPromptImageResources({ createObjectURL, revokeObjectURL: vi.fn() });
    const tooLarge = 'A'.repeat(Math.ceil((MAX_AI_PROMPT_IMAGE_BYTES + 1) * 4 / 3));

    expect(resources.add([{ id: 'large', mediaType: 'image/png', base64: tooLarge }]).rejected)
      .toEqual([{ id: 'large', reason: 'image too large' }]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('revokes every live URL on dispose', () => {
    const revokeObjectURL = vi.fn();
    const resources = createAiPromptImageResources({
      createObjectURL: (_blob) => 'blob:one', revokeObjectURL,
    });
    resources.add([{ id: 'one', mediaType: 'image/png', base64: ONE_PIXEL }]);

    resources.dispose();

    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});
