// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-668 §9.7 — the CONNECT channel vs the AI switch, end to end: a REAL browser
 * on a page a REAL CONNECT serves, and a LOCAL MCP client talking JSON-RPC to the
 * same CONNECT's `/mcp` (loopback — "AI off" must hold for local clients too,
 * without touching `McpClientRemoteAllowed`).
 *
 * Needs a running CONNECT that serves this viewer (dev or embedded mode) and has
 * no other viewer tab connected:
 *
 *   RV_E2E_CONNECT_URL=http://localhost:5668 npx playwright test e2e/connect-ai-switch.spec.ts
 *
 * Without RV_E2E_CONNECT_URL the spec is skipped (a normal `npm run e2e` has no
 * CONNECT of its own).
 */

import { expect, test, type APIRequestContext, type Page } from 'playwright/test';

const CONNECT = process.env.RV_E2E_CONNECT_URL?.replace(/\/$/, '');

test.skip(!CONNECT, 'needs a running CONNECT serving this viewer (RV_E2E_CONNECT_URL)');
test.describe.configure({ mode: 'serial' });
// Dev-mode CONNECT transforms the lazy Settings chunks on first use — slow on a loaded machine.
test.setTimeout(600_000);

// ── A minimal MCP Streamable-HTTP client (JSON-RPC over POST /mcp) ──

interface McpTool { name: string }
interface CallResult { isError?: boolean; content?: { type: string; text?: string }[] }

class McpHttpClient {
  private session: string | null = null;
  private nextId = 1;
  constructor(private readonly request: APIRequestContext, private readonly base: string) {}

  private async rpc<T>(method: string, params: unknown, notify = false): Promise<T> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = this.nextId++;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const res = await this.request.post(`${this.base}/mcp`, { data: body, headers });
    expect(res.status(), `${method} → HTTP ${res.status()}`).toBeLessThan(300);
    const sid = res.headers()['mcp-session-id'];
    if (sid) this.session = sid;
    if (notify) return undefined as T;
    const text = await res.text();
    // Streamable HTTP may answer as SSE: take the `data:` line that carries our id.
    const payloads = res.headers()['content-type']?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    const reply = payloads.find((p) => p.id === body.id) ?? payloads[payloads.length - 1];
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result as T;
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'plan-668-e2e', version: '1.0.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
  }

  async toolNames(): Promise<string[]> {
    const r = await this.rpc<{ tools: McpTool[] }>('tools/list', {});
    return r.tools.map((t) => t.name).sort();
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    return this.rpc<CallResult>('tools/call', { name, arguments: args });
  }
}

function textOf(r: CallResult): string {
  return (r.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function bridgeClients(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${CONNECT}/bridge/status`);
  expect(res.ok()).toBe(true);
  const body = await res.json() as { clients?: number; connections?: { clients?: number } };
  return body.clients ?? body.connections?.clients ?? 0;
}

async function openViewer(page: Page): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('rv-welcome-dismissed', '1'); } catch { /* */ } });
  await page.goto(`${CONNECT}/`);
}

/** The auto-quality notice of a fresh profile is modal; acknowledge it when it shows up. */
async function dismissAutoQuality(page: Page): Promise<void> {
  const ok = page.getByTestId('auto-quality-ok');
  await ok.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await ok.isVisible()) {
    await ok.click();
    await expect(ok).toHaveCount(0);
  }
}

async function openAiSettings(page: Page): Promise<void> {
  await dismissAutoQuality(page);
  await page.getByRole('button', { name: /^AI control/ }).click();
  await expect(page.getByTestId('connect-channel-row')).toBeVisible({ timeout: 180_000 });
}

// ── The journey ──

test('AI off on a fresh origin: channel connected, tools hidden and refused; consent gates the switch', async ({ page, request }) => {
  const mcp = new McpHttpClient(request, CONNECT!);
  await mcp.initialize();
  const baseline = await mcp.toolNames();
  expect(baseline).toContain('web_status');
  expect(baseline).toContain('web_call_pending');
  expect(baseline.filter((n) => n.startsWith('web_'))).toEqual(['web_call_pending', 'web_status']);

  // A fresh origin = AI off. The channel comes up anyway (CONNECT serves the page).
  await openViewer(page);
  await expect.poll(() => bridgeClients(request), { timeout: 60_000 }).toBeGreaterThan(0);

  // Local MCP client: exactly the gateway tools + CONNECT's own two — no viewer tool leaks.
  await expect.poll(() => mcp.toolNames(), { timeout: 30_000 }).toEqual(baseline);
  for (const tool of ['web_drive_list', 'web_ping', 'web_editor_to_ground']) {
    const r = await mcp.call(tool);
    expect(r.isError, tool).toBe(true);
    expect(textOf(r), tool).toContain('AI_DISABLED:');
  }
  const status = JSON.parse(textOf(await mcp.call('web_status')));
  expect(status).toMatchObject({ connected: true, aiEnabled: false });

  // Settings ▸ AI without consent: the channel row is visible, the AI part waits for consent.
  await openAiSettings(page);
  await expect(page.getByTestId('connect-channel-row')).toContainText('Connected');
  await expect(page.getByTestId('ai-consent-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByTestId('connect-channel-row')).toContainText('Connected');
  expect(await mcp.toolNames()).toEqual(baseline);

  // Consent, then switch AI on → the viewer's tools appear for the MCP client, no reload.
  await page.getByRole('button', { name: 'Review access…' }).click();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByTestId('ai-control-switch').locator('input').check({ timeout: 180_000 });
  await expect.poll(async () => (await mcp.toolNames()).includes('web_drive_list'), { timeout: 30_000 }).toBe(true);
  const on = await mcp.call('web_status');
  expect(on.isError ?? false).toBe(false);
  expect(textOf(on)).not.toContain('AI_DISABLED');

  // Switch off → back to exactly the baseline, calls refused again.
  await page.getByTestId('ai-control-switch').locator('input').uncheck();
  await expect.poll(() => mcp.toolNames(), { timeout: 30_000 }).toEqual(baseline);
  expect(textOf(await mcp.call('web_drive_list'))).toContain('AI_DISABLED:');

  // Reload: the switch state persists (off), the channel comes back on its own.
  await page.reload();
  await expect.poll(() => bridgeClients(request), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => mcp.toolNames(), { timeout: 30_000 }).toEqual(baseline);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rv-ai-bridge') ?? '{}').enabled)).toBe(false);
});
