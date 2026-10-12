// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-486 §9.2 — the queue.
 *
 * Four properties this file exists for, each of which a plausible-looking
 * implementation gets wrong:
 *
 *  - `claim` MARKS, it does not delete — an aborted agent run loses nothing;
 *  - the claim is persisted BEFORE it is delivered, so a failed write delivers
 *    NOTHING and leaves the stored queue byte-identical;
 *  - the 51st task displaces the oldest CLAIMED task, and with nothing claimed
 *    it is refused VISIBLY rather than dropping open work;
 *  - a DUPLICATED tab inherits the same `sessionStorage` tab id and must still
 *    not share the queue. The test therefore uses the INHERITED id; two
 *    different ids would prove nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { buildPromptTask, MAX_QUEUE_TASKS } from '../src/core/hmi/prompt-task-envelope';
import { PromptTaskStore, type PromptStorageLike } from '../src/core/hmi/prompt-task-store';

// ─── Fakes ──────────────────────────────────────────────────────────────

class MemoryStorage implements PromptStorageLike {
  readonly map = new Map<string, string>();
  /** When set, every setItem for a matching key throws (quota simulation). */
  failWrites: ((key: string) => boolean) | null = null;
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites?.(key)) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void { this.map.delete(key); }
}

class ThrowingStorage implements PromptStorageLike {
  getItem(): string | null { throw new Error('blocked'); }
  setItem(): void { throw new Error('blocked'); }
  removeItem(): void { throw new Error('blocked'); }
}

let clock = 1_000_000;
const now = (): number => clock;

function makeStore(opts: Partial<ConstructorParameters<typeof PromptTaskStore>[0]> = {}): PromptTaskStore {
  return new PromptTaskStore({ autoHeartbeat: false, now, ...opts });
}

let seq = 0;
function makeTask(prompt = 'Sensor triggert zu frueh', target = 'Line1/Belt02/Drive') {
  seq++;
  return buildPromptTask({
    prompt,
    targetPath: target,
    now: () => new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    randomHex: (bytes) => `${seq}`.padStart(bytes * 2, '0'),
  });
}

// ─── Core ───────────────────────────────────────────────────────────────

describe('plan-486 §9.2 — claim marks, it never deletes', () => {
  it('enqueue → list → claim → still there, as claimed; reopen puts it back', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    const t = makeTask();
    expect(store.enqueue(t).ok).toBe(true);
    expect(store.list()).toHaveLength(1);

    const claimed = store.claim();
    expect(claimed.task?.id).toBe(t.id);
    expect(claimed.task?.status).toBe('claimed');
    expect(claimed.task?.claimedAt).toBeTruthy();

    expect(store.list()).toHaveLength(0);
    expect(store.list({ includeClaimed: true })).toHaveLength(1);
    expect(store.counts()).toEqual({ open: 0, claimed: 1 });

    expect(store.reopen(t.id)).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].claimedAt).toBeUndefined();
  });

  it('at-most-once: two claims yield two DIFFERENT tasks, the third is empty', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    const a = makeTask('first');
    const b = makeTask('second');
    store.enqueue(a);
    store.enqueue(b);

    const first = store.claim().task;
    const second = store.claim().task;
    expect(first?.id).toBe(a.id);
    expect(second?.id).toBe(b.id);
    expect(first!.id).not.toBe(second!.id);
    expect(store.claim().task).toBeNull();
    expect(JSON.parse(store.claimSerialized())).toEqual({ task: null, open: 0, claimed: 2 });
  });

  it('remove drops a task and reopen on an unknown id fails visibly', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    const t = makeTask();
    store.enqueue(t);
    expect(store.remove(t.id)).toBe(true);
    expect(store.list({ includeClaimed: true })).toHaveLength(0);
    expect(store.reopen(t.id)).toBe(false);
  });

  it('lastClaimAt starts empty and is set by a successful claim', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    expect(store.lastClaimAt).toBeNull();
    store.enqueue(makeTask());
    store.claim();
    expect(store.lastClaimAt).toBeTruthy();
  });
});

// ─── Displacement ───────────────────────────────────────────────────────

describe('plan-486 §9.2 — displacement never drops undelivered work', () => {
  it('the 51st task displaces the OLDEST CLAIMED task and reports it', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    for (let i = 0; i < MAX_QUEUE_TASKS; i++) store.enqueue(makeTask(`task ${i}`));
    const oldestClaimed = store.claim().task!;
    store.claim();

    const extra = makeTask('the 51st');
    const result = store.enqueue(extra);
    expect(result.ok).toBe(true);
    expect(result.evicted?.id).toBe(oldestClaimed.id);
    expect(store.getSnapshot().notice).toContain(oldestClaimed.id);
    expect(store.list({ includeClaimed: true }).some((t) => t.id === oldestClaimed.id)).toBe(false);
    expect(store.list({ includeClaimed: true }).some((t) => t.id === extra.id)).toBe(true);
    expect(store.list({ includeClaimed: true })).toHaveLength(MAX_QUEUE_TASKS);
  });

  it('with nothing claimed the new task is REFUSED and no open task is lost', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    for (let i = 0; i < MAX_QUEUE_TASKS; i++) store.enqueue(makeTask(`task ${i}`));
    const before = store.list().map((t) => t.id);

    const refused = store.enqueue(makeTask('refused'));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/full/i);
    expect(store.getSnapshot().notice).toMatch(/full/i);
    expect(store.list().map((t) => t.id)).toEqual(before);
  });

  it('a displaced claimed task can no longer be reopened — the documented limit', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    for (let i = 0; i < MAX_QUEUE_TASKS; i++) store.enqueue(makeTask(`task ${i}`));
    const lost = store.claim().task!;       // the agent's answer never came back
    store.enqueue(makeTask('newest'));      // fills up → displaces `lost`
    expect(store.reopen(lost.id)).toBe(false);
  });
});

// ─── Persistence ────────────────────────────────────────────────────────

describe('plan-486 §9.2 — persistence, tabs and the failed claim', () => {
  it('a reload of the SAME tab rehydrates the queue', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const first = makeStore({ local, session });
    first.enqueue(makeTask('survives the reload'));
    const tabId = first.tabId;
    // A reload: the outgoing page released its heartbeat.
    local.removeItem(`rv-prompt-owner-${tabId}`);

    const reloaded = makeStore({ local, session });
    expect(reloaded.tabId).toBe(tabId);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].prompt).toBe('survives the reload');
  });

  it('a DUPLICATED tab inherits the tab id and still does not share the queue', () => {
    const local = new MemoryStorage();
    const sessionA = new MemoryStorage();
    const original = makeStore({ local, session: sessionA });
    original.enqueue(makeTask('belongs to the original'));

    // Tab duplication copies sessionStorage verbatim — same tab id, live original.
    const sessionB = new MemoryStorage();
    for (const [k, v] of sessionA.map) sessionB.map.set(k, v);
    expect(sessionB.getItem('rv-prompt-tab-id')).toBe(original.tabId);

    const duplicate = makeStore({ local, session: sessionB });
    expect(duplicate.tabId).not.toBe(original.tabId);
    expect(duplicate.list({ includeClaimed: true })).toHaveLength(0);
    expect(duplicate.getSnapshot().notice).toMatch(/duplicate/i);
    // And the original's queue is untouched by the duplicate's arrival.
    expect(original.list()).toHaveLength(1);
  });

  it('a failed claim write delivers NOTHING and leaves the stored queue unchanged', () => {
    const local = new MemoryStorage();
    const store = makeStore({ local, session: new MemoryStorage() });
    const t = makeTask('must not be delivered twice');
    store.enqueue(t);
    const storedBefore = local.getItem(store.storageKey);

    local.failWrites = (key) => key === store.storageKey;
    const result = store.claim();
    expect(result.task).toBeNull();
    expect(result.error).toMatch(/Could not save/);
    expect(local.getItem(store.storageKey)).toBe(storedBefore);
    expect(store.getSnapshot().persistError).toMatch(/Could not save/);
    // The in-memory task is still OPEN — nothing was consumed.
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].status).toBe('open');

    expect(JSON.parse(store.claimSerialized())).toMatchObject({ task: null });
    expect(JSON.parse(store.claimSerialized()).error).toBeTruthy();

    // A reload after the failure hands the SAME task out once, not twice.
    local.failWrites = null;
    local.removeItem(`rv-prompt-owner-${store.tabId}`);
    const reloaded = makeStore({ local, session: new MemoryStorage() });
    expect(reloaded.list({ includeClaimed: true }).every((x) => x.status === 'open')).toBe(true);
  });

  it('a throwing localStorage leaves the queue working (volatile mode)', () => {
    const store = makeStore({ local: new ThrowingStorage(), session: new ThrowingStorage() });
    const t = makeTask('volatile');
    expect(store.enqueue(t).ok).toBe(true);
    expect(store.claim().task?.id).toBe(t.id);
    expect(store.list({ includeClaimed: true })).toHaveLength(1);
  });

  it('no storage at all is volatile mode, and says so', () => {
    const store = makeStore({ local: null, session: null });
    expect(store.isVolatile).toBe(true);
    expect(store.getSnapshot().volatile).toBe(true);
    store.enqueue(makeTask());
    expect(store.claim().task).toBeTruthy();
  });

  it('a project switch leaves the old key\'s queue exactly where it was', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const store = makeStore({ local, session, projectKey: 'alpha' });
    store.enqueue(makeTask('about alpha'));

    store.setProjectKey('beta');
    expect(store.list({ includeClaimed: true })).toHaveLength(0);
    store.enqueue(makeTask('about beta'));

    store.setProjectKey('alpha');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].prompt).toBe('about alpha');
    expect(store.storageKey).toContain('-alpha');
  });
});

// ─── React seam ─────────────────────────────────────────────────────────

describe('plan-486 — subscribe/getSnapshot', () => {
  it('notifies on every mutation and hands out a stable snapshot', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    let calls = 0;
    const unsub = store.subscribe(() => { calls++; });
    const before = store.getSnapshot();
    store.enqueue(makeTask());
    expect(calls).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.claim();
    expect(calls).toBe(2);
    unsub();
    store.clear();
    expect(calls).toBe(2);
  });

  it('serialises the list without changing anything', () => {
    const store = makeStore({ local: new MemoryStorage(), session: new MemoryStorage() });
    store.enqueue(makeTask());
    store.enqueue(makeTask());
    store.claim();
    const open = JSON.parse(store.listSerialized(false)) as { tasks: unknown[]; open: number; claimed: number };
    const all = JSON.parse(store.listSerialized(true)) as { tasks: unknown[] };
    expect(open.tasks).toHaveLength(1);
    expect(open.open).toBe(1);
    expect(open.claimed).toBe(1);
    expect(all.tasks).toHaveLength(2);
    expect(store.counts()).toEqual({ open: 1, claimed: 1 });
  });
});
