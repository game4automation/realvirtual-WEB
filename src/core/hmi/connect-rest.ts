// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Shared authenticated REST transport for calls to realvirtual CONNECT. */

import { loadInterfaceSettings } from '../../interfaces/interface-settings-store';

/** Add the configured CONNECT API key without replacing caller headers. */
export function connectRestHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const apiKey = loadInterfaceSettings().wsAuthToken.trim();
  if (apiKey && !headers.has('X-API-Key')) headers.set('X-API-Key', apiKey);
  return headers;
}

/** Execute an authenticated CONNECT request against an absolute URL. */
export async function connectRestFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: connectRestHeaders(init),
  });
}

/** Execute an authenticated CONNECT request and decode its JSON response. */
export async function connectRestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await connectRestFetch(url, init);
  if (!response.ok) throw new Error(await connectRestErrorMessage(response));
  return response.json() as Promise<T>;
}

async function connectRestErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}: ${response.statusText}`;
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    // Non-JSON responses use the HTTP status fallback.
  }
  return fallback;
}
