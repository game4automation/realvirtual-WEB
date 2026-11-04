// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 fix — a card with a saved thumbnail keeps its square shape.
 * The img carries width/height={512} attributes; without `height: auto` the
 * attribute became the CSS height and the ~120 px card grew to 512 px with a
 * cropped strip of the picture.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { AssetCard } from '../../src/core/library/AssetCard';

afterEach(() => cleanup());

async function pngDataUrl(): Promise<string> {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c33';
  ctx.fillRect(0, 0, 8, 8);
  return c.toDataURL('image/png');
}

describe('AssetCard thumbnail layout', () => {
  it('renders a square image in a narrow container, not a 512 px strip', async () => {
    const url = await pngDataUrl();
    const { container, getByAltText } = render(
      <ThemeProvider theme={rvDarkTheme}>
        <div data-testid="host" style={{ width: 120 }}>
          <AssetCard entry={{ id: 'a1', name: 'Belt 1000', category: 'conveyor', thumbnailUrl: url }} />
        </div>
      </ThemeProvider>,
    );
    const img = getByAltText('Belt 1000') as HTMLImageElement;
    await waitFor(() => expect(img.complete && img.naturalWidth > 0).toBe(true));
    const r = img.getBoundingClientRect();
    expect(r.width).toBeGreaterThan(40);
    expect(Math.abs(r.height - r.width)).toBeLessThanOrEqual(2);
    const host = container.querySelector('[data-testid="host"]') as HTMLElement;
    expect(host.getBoundingClientRect().height).toBeLessThan(300);
    expect(getComputedStyle(img).objectFit).toBe('contain');
  });
});
