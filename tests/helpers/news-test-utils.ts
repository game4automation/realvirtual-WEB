// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Shared deterministic fixtures for news store and dialog tests. */

import { createElement } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { NewsDialog } from '../../src/core/hmi/NewsDialog';
import {
  resetNewsStoreForTest as resetProductNewsStore,
  type NewsItem,
} from '../../src/core/news-store';
import { setAppConfig, type RVAppConfig } from '../../src/core/rv-app-config';
import { initializeConnectEmbedStore } from '../../src/plugins/connect-embed/connect-embed-store';

export type NewsStubItem = Pick<NewsItem, 'id' | 'title' | 'body'> & Partial<NewsItem>;

export function newsItem(item: NewsStubItem): NewsItem {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    link: item.link ?? null,
    validFrom: item.validFrom ?? '2026-07-25T09:00:00.000Z',
    validTo: item.validTo ?? null,
    updatedAt: item.updatedAt ?? '2026-07-25T09:30:00.000Z',
  };
}

export function setAppConfigForTest(config: RVAppConfig): void {
  setAppConfig(config);
}

export function stubNewsResponse(items: NewsStubItem[], status = 200) {
  return stubNewsRaw({ contract: 1, items: items.map(newsItem) }, status);
}

export function stubNewsRaw(raw: unknown, status = 200) {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

export function setConnectEmbedContextForTest(enabled: boolean): void {
  initializeConnectEmbedStore(enabled
    ? { ui: { initialContexts: ['connect-embed'] } }
    : {});
}

export function renderNews(itemOrItems: NewsStubItem | NewsStubItem[]) {
  const items = (Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]).map(newsItem);
  const onSeen = vi.fn();
  return { ...render(createElement(NewsDialog, { items, onSeen })), onSeen };
}

export function resetNewsStoreForTest(): void {
  resetProductNewsStore();
}
