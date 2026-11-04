// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { ShareDialog } from '../src/core/share/ShareDialog';
import { configureShareApi, fetchShareLimits, setShareSession, getShareSession, clearShareDraft, saveShareDraft } from '../src/core/share/rv-share-session';
import { ShareBackendStub } from './helpers/rv-share-backend-stub';

let restore: (() => void) | undefined;
afterEach(() => { cleanup(); setShareSession(null); clearShareDraft(); restore?.(); });
function setup(options?: ConstructorParameters<typeof ShareBackendStub>[0]) {
  const stub = new ShareBackendStub(options);
  restore = configureShareApi({ baseUrl: stub.apiBase, fetchImpl: stub.fetch });
  setShareSession(null);
  return stub;
}
function dialog(open = true) {
  return createElement(ShareDialog, { open, onClose: () => {}, getBytes: () => new ArrayBuffer(2048) });
}
it('reports public limits without usage and account usage before upload', async () => {
  const stub = setup({ maxFileBytes: 2048, quotaBytes: 8192 });
  expect(await fetchShareLimits()).toEqual({ maxFileBytes: 2048, quotaBytes: 8192, expiries: ['never','7d','30d','90d'] });
  setShareSession(stub.signIn('a@test.io'));
  render(dialog());
  await waitFor(() => expect(screen.getByTestId('share-limits').textContent).toContain('Used: 0 KB'));
  expect(screen.getByTestId('share-limits').textContent).toContain('Maximum file size: 2 KB');
  expect(screen.getByTestId('share-limits').textContent).toContain('Storage quota: 8 KB');
});
it.each([{ expiries: [] as string[] }, { expiries: ['future'] }])('disables upload with unsupported expiries $expiries', async ({ expiries }) => {
  setup({ expiries }); render(dialog());
  fireEvent.click(screen.getByTestId('share-terms'));
  await screen.findByText('Sharing is currently not available for your account.');
  expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByTestId('share-expiry-never')).toBeNull();
});
it('validates restored draft and defaults against ordered allowed expiries', async () => {
  setup({ expiries: ['30d', '7d', 'unknown'] });
  saveShareDraft({ target: 'upload', expiry: '90d', allowDownload: true });
  render(dialog());
  await waitFor(() => expect((screen.getByTestId('share-expiry-30d') as HTMLInputElement).checked).toBe(true));
  expect(screen.queryByTestId('share-expiry-never')).toBeNull();
  expect(screen.queryByTestId('share-expiry-90d')).toBeNull();
});
it('blocks upload while /limits is loading, then applies the restricted expiries', async () => {
  const stub = setup({ expiries: ['7d'] }); setShareSession(stub.signIn('a@test.io'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  restore?.(); restore = configureShareApi({ baseUrl: stub.apiBase, fetchImpl: async (input, init) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/limits')) await gate;
    return stub.fetch(input, init);
  } });
  render(dialog());
  fireEvent.click(screen.getByTestId('share-terms'));
  const submit = screen.getByTestId('share-submit') as HTMLButtonElement;
  expect(screen.getByTestId('share-limits').textContent).toContain('Loading upload limits');
  expect(submit.disabled).toBe(true);
  for (const expiry of ['never', '7d', '30d', '90d']) expect(screen.queryByTestId(`share-expiry-${expiry}`)).toBeNull();
  fireEvent.click(submit);                                   // a click on the disabled button starts nothing
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(stub.requests.filter(r => !r.url.endsWith('/limits'))).toEqual([]);   // no upload request left the client
  expect(screen.queryByTestId('share-done')).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect((screen.getByTestId('share-expiry-7d') as HTMLInputElement).checked).toBe(true));
  expect(screen.queryByTestId('share-expiry-never')).toBeNull();
  expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByTestId('share-submit'));
  await screen.findByTestId('share-done');
  const create = stub.requests.find(r => r.method === 'POST' && r.url.endsWith('/uploads'));
  expect(JSON.parse(create!.body!).expiry).toBe('7d');
});
it.each(['404', 'network'])('falls back to four options on %s', async failure => {
  const stub = setup({ limitsEnabled: false });
  if (failure === 'network') { restore?.(); restore = configureShareApi({ baseUrl: stub.apiBase, fetchImpl: async () => { throw new Error('offline'); } }); }
  expect(await fetchShareLimits()).toBeNull(); render(dialog());
  await screen.findByText('Upload size and storage are limited per account; exceeding a limit is reported before anything is stored.');
  for (const expiry of ['never','7d','30d','90d']) expect(screen.getByTestId(`share-expiry-${expiry}`)).toBeTruthy();
});
it('keeps B signed in after a delayed 401 for A; current 401 clears B', async () => {
  const stub = setup(); const a = stub.signIn('a@test.io'); const b = stub.signIn('b@test.io');
  let finish!: (r: Response) => void;
  restore?.(); restore = configureShareApi({ baseUrl: stub.apiBase, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  setShareSession(a); const pending = fetchShareLimits(); setShareSession(b);
  finish(new Response(null, { status: 401 })); expect(await pending).toBeNull(); expect(getShareSession()?.token).toBe(b.token);
  const current = fetchShareLimits(); finish(new Response(null, { status: 401 })); await current; expect(getShareSession()).toBeNull();
});
it('discards late account replies and reloads on logout and reopen', async () => {
  const stub = setup(); const a = stub.signIn('a@test.io'); const b = stub.signIn('b@test.io');
  let finish!: (r: Response) => void;
  restore?.(); restore = configureShareApi({ baseUrl: stub.apiBase, fetchImpl: (input, init) => {
    if (new Headers(init?.headers).get('Authorization') === `Bearer ${a.token}`) return new Promise(resolve => { finish = resolve; });
    return stub.fetch(input, init);
  } });
  setShareSession(a); const ui = render(dialog());
  act(() => setShareSession(b));
  await waitFor(() => expect(screen.getByTestId('share-limits').textContent).toContain('Used: 0 KB'));
  await act(async () => { finish(Response.json({ maxFileBytes: 1, quotaBytes: 1, expiries: [] })); });
  expect(screen.queryByText('Sharing is currently not available for your account.')).toBeNull();
  act(() => setShareSession(null));
  await waitFor(() => expect(screen.getByTestId('share-limits').textContent).not.toContain('Used:'));
  ui.rerender(dialog(false)); ui.rerender(dialog());
  await waitFor(() => expect(stub.requests.filter(r => r.url.endsWith('/limits')).length).toBeGreaterThanOrEqual(3));
});

it('refreshes usage after upload and deletion', async () => {
  const stub = setup(); setShareSession(stub.signIn('a@test.io'));
  render(dialog());
  await waitFor(() => expect(screen.getByTestId('share-limits').textContent).toContain('Used: 0 KB'));
  fireEvent.click(screen.getByTestId('share-terms'));
  fireEvent.click(screen.getByTestId('share-submit'));
  await screen.findByTestId('share-done');
  await waitFor(() => expect(stub.requests.filter(r => r.url.endsWith('/limits')).length).toBe(2));
  fireEvent.click(screen.getByTestId('share-open-myshares'));
  const deletion = await screen.findByTestId(`my-share-delete-${stub.lastCreatedId()}`);
  fireEvent.click(deletion);
  await waitFor(() => expect(stub.requests.filter(r => r.url.endsWith('/limits')).length).toBe(3));
  expect((await fetchShareLimits())?.usedBytes).toBe(0);
});
