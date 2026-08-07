// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Fail-silent WEB and CONNECT news queues with strict contract validation. */

import { getAppConfig, setAppConfig } from './rv-app-config';
import { connectRestFetch } from './hmi/connect-rest';
import {
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
} from '../plugins/connect-embed/connect-embed-store';
import { isSafeHttpUrl } from './hmi/safe-markdown';

export const NEWS_CONTRACT_VERSION = 1;
export const NEWS_SEEN_STORAGE_KEY = 'rv-news-seen';
export const NEWS_FETCH_TIMEOUT_MS = 5_000;
const MAX_NEWS_ITEMS = 20;

export interface NewsItem {
  id: string;
  title: string;
  body: string;
  link: string | null;
  validFrom: string;
  validTo: string | null;
  updatedAt: string;
}

export interface NewsSnapshot {
  webItems: readonly NewsItem[];
  connectItems: readonly NewsItem[];
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: NewsSnapshot = { webItems: [], connectItems: [] };
let hasFetchedWebThisSession = false;
let connectServerUrl = '';

function notify(): void {
  for (const listener of listeners) listener();
}

function setSnapshot(next: NewsSnapshot): void {
  if (snapshot.webItems === next.webItems && snapshot.connectItems === next.connectItems) return;
  snapshot = next;
  notify();
}

export function subscribeNewsStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNewsSnapshot(): NewsSnapshot {
  return snapshot;
}

/** Parses contract v1 and returns an empty list for every structural error. */
export function parseNewsResponse(raw: unknown): NewsItem[] {
  return parseNewsEnvelope(raw) ?? [];
}

/**
 * Fetches the public WEB queue once per session. Every gate is evaluated
 * before fetch is referenced so private/customer deployments issue 0 requests.
 */
export async function fetchUnseenNews(target: 'web' = 'web'): Promise<NewsItem[]> {
  if (target !== 'web' || hasFetchedWebThisSession) return [];
  if (getConnectEmbedSnapshot().enabled) return [];

  const apiUrl = resolveConfiguredNewsUrl();
  if (!apiUrl) return [];
  hasFetchedWebThisSession = true;

  const controller = new AbortController();
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  try {
    apiUrl.searchParams.set('target', target);
    const request = fetch(apiUrl, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return null;
      return parseNewsEnvelope(await response.json());
    });
    const deadline = new Promise<null>((resolve) => {
      deadlineId = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, NEWS_FETCH_TIMEOUT_MS);
    });
    const parsed = await Promise.race([request, deadline]);
    const unseen = parsed?.filter((item) => !isNewsSeen(item.id)) ?? [];
    setSnapshot({ ...snapshot, webItems: unseen });
    return unseen;
  } catch {
    setSnapshot({ ...snapshot, webItems: [] });
    return [];
  } finally {
    if (deadlineId !== undefined) clearTimeout(deadlineId);
  }
}

/** Fetches the CONNECT-proxied queue. Returns true only for a valid 2xx contract response. */
export async function fetchConnectNews(serverUrl: string): Promise<boolean> {
  try {
    const url = `${serverUrl.replace(/\/+$/, '')}/news`;
    const response = await connectRestFetch(url);
    if (!response.ok) return false;
    const parsed = parseNewsEnvelope(await response.json());
    if (!parsed) return false;
    connectServerUrl = serverUrl.replace(/\/+$/, '');
    setSnapshot({ ...snapshot, connectItems: parsed });
    return true;
  } catch {
    return false;
  }
}

/** Marks a public WEB item seen and removes it from the current queue. */
export function markNewsSeen(id: string): void {
  const seen = readSeenIds();
  if (!seen.includes(id)) seen.push(id);
  try {
    localStorage.setItem(NEWS_SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Disabled/private storage is intentionally a no-op.
  }
  setSnapshot({
    ...snapshot,
    webItems: snapshot.webItems.filter((item) => item.id !== id),
  });
}

export function isNewsSeen(id: string): boolean {
  return readSeenIds().includes(id);
}

/** Removes a CONNECT item immediately and acknowledges it server-side, fail-silently. */
export async function markConnectNewsSeen(id: string): Promise<void> {
  setSnapshot({
    ...snapshot,
    connectItems: snapshot.connectItems.filter((item) => item.id !== id),
  });
  if (!connectServerUrl) return;
  try {
    await connectRestFetch(`${connectServerUrl}/news/seen`, {
      method: 'POST',
      body: JSON.stringify({ ids: [id] }),
    });
  } catch {
    // The gateway is the source of truth and may show the item again later.
  }
}

/** @internal Resets queues, guards, app config, and embed context for isolated tests. */
export function resetNewsStoreForTest(): void {
  if (import.meta.env.PROD) {
    throw new Error('resetNewsStoreForTest() must not be called in production');
  }
  hasFetchedWebThisSession = false;
  connectServerUrl = '';
  snapshot = { webItems: [], connectItems: [] };
  setAppConfig({});
  initializeConnectEmbedStore({});
  notify();
}

function resolveConfiguredNewsUrl(): URL | null {
  const config = getAppConfig().news;
  if (config?.enabled !== true || typeof config.apiUrl !== 'string' || !config.apiUrl.trim()) {
    return null;
  }
  try {
    const url = new URL(config.apiUrl);
    if (!isSafeHttpUrl(url.href) || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function readSeenIds(): string[] {
  try {
    const raw = localStorage.getItem(NEWS_SEEN_STORAGE_KEY);
    if (raw == null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      localStorage.setItem(NEWS_SEEN_STORAGE_KEY, '[]');
      return [];
    }
    return [...new Set(parsed)];
  } catch {
    try {
      localStorage.setItem(NEWS_SEEN_STORAGE_KEY, '[]');
    } catch {
      // Storage may be entirely unavailable (for example Safari private mode).
    }
    return [];
  }
}

function parseNewsEnvelope(raw: unknown): NewsItem[] | null {
  if (!isRecord(raw) || raw.contract !== NEWS_CONTRACT_VERSION || !Array.isArray(raw.items)) {
    return null;
  }

  const validated: NewsItem[] = [];
  for (const candidate of raw.items) {
    const item = parseNewsItem(candidate);
    if (!item) return null;
    validated.push(item);
  }

  const deduplicated: NewsItem[] = [];
  const ids = new Set<string>();
  for (const item of validated.slice(0, MAX_NEWS_ITEMS)) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    deduplicated.push(item);
  }
  return deduplicated;
}

function parseNewsItem(raw: unknown): NewsItem | null {
  if (!isRecord(raw)) return null;
  if (!boundedString(raw.id, 1, 64) || !boundedString(raw.title, 1, 200)) return null;
  if (!boundedString(raw.body, 0, 8_192)) return null;
  if (raw.link !== null && (!boundedString(raw.link, 1, 500) || !isSafeHttpUrl(raw.link))) return null;
  if (!isUtcTimestamp(raw.validFrom) || !isUtcTimestamp(raw.updatedAt)) return null;
  if (raw.validTo !== null && !isUtcTimestamp(raw.validTo)) return null;
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    link: raw.link,
    validFrom: raw.validFrom,
    validTo: raw.validTo,
    updatedAt: raw.updatedAt,
  };
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.endsWith('Z')
    && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
