// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fake-fs-handles — an in-memory File System Access implementation.
 *
 * Extracted from `rv-cad-glb-cache.test.ts` so every project test shares one
 * mock style, and extended with the two things that test had no need for and
 * plan-370 cannot do without:
 *
 *  - **`queryPermission`/`requestPermission` with a configurable state.**
 *    These are exactly what `requestWriteAccess()` and `getFolderHandle()`
 *    call. Without them the readwrite-upgrade and re-grant paths — the core
 *    of Phase 1 — would have no test at all.
 *  - **Error injection.** Disk full, a file locked by a virus scanner, a
 *    handle invalidated by a renamed folder: all of these only surface at
 *    I/O time, and §4e's whole point is that they must not be reported to
 *    the user as "Saved".
 */

export type PermissionState = 'granted' | 'denied' | 'prompt';

/** Where in the I/O path an injected failure should fire. */
export type FailurePoint = 'write' | 'read' | 'getFile' | 'getDirectory' | 'remove';

export interface FailureRule {
  /** Fire only for this filename/dirname. Omit to match everything. */
  name?: string;
  point: FailurePoint;
  /** Error to throw. Defaults to a DOMException-shaped NotAllowedError. */
  error?: Error;
  /** Fire this many times, then stop. Omit for "always". */
  times?: number;
}

/** Shared, mutable failure state for a handle tree. */
export class FailureInjector {
  private rules: FailureRule[] = [];

  /** Queue a failure. Chainable. */
  fail(rule: FailureRule): this {
    this.rules.push({ ...rule });
    return this;
  }

  /** Remove every queued failure. */
  clear(): void {
    this.rules = [];
  }

  /** Throw if a rule matches. Called at each I/O point. */
  check(point: FailurePoint, name: string): void {
    const rule = this.rules.find(
      r => r.point === point && (r.name === undefined || r.name === name),
    );
    if (!rule) return;
    if (rule.times !== undefined) {
      rule.times -= 1;
      if (rule.times <= 0) this.rules = this.rules.filter(r => r !== rule);
    }
    throw rule.error ?? namedError('NotAllowedError', `injected ${point} failure on "${name}"`);
  }
}

/** Build an Error carrying a DOM-style `name`, which the code under test branches on. */
export function namedError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

// ─── File ───────────────────────────────────────────────────────────────

export class FakeFile {
  readonly kind = 'file';

  constructor(
    public name: string,
    private blob: Blob = new Blob(),
    private failures?: FailureInjector,
  ) {}

  async getFile(): Promise<Blob> {
    this.failures?.check('getFile', this.name);
    return this.blob;
  }

  /**
   * Open a writable stream. The failure check fires **here only**, not again
   * inside `write()`: one logical write must produce exactly one injector
   * hit, or every call-counting assertion silently doubles.
   */
  async createWritable() {
    this.failures?.check('write', this.name);
    const self = this;
    return {
      async write(data: Blob | ArrayBuffer | string) {
        self.blob =
          data instanceof Blob ? data
            : typeof data === 'string' ? new Blob([data])
              : new Blob([data]);
      },
      async close() { /* no-op */ },
    };
  }

  /** Test convenience: current contents as text. */
  async text(): Promise<string> {
    return this.blob.text();
  }
}

// ─── Directory ──────────────────────────────────────────────────────────

export class FakeDir {
  readonly kind = 'directory';
  private children = new Map<string, FakeDir | FakeFile>();

  /** Permission state per mode, honoured by query/requestPermission. */
  permissions: { read: PermissionState; readwrite: PermissionState } = {
    read: 'granted',
    readwrite: 'granted',
  };

  /** What `requestPermission` upgrades a 'prompt' to. */
  grantOnRequest: PermissionState = 'granted';

  /** Counts, so a test can assert a re-grant actually prompted. */
  requestPermissionCalls = 0;
  queryPermissionCalls = 0;

  readonly failures: FailureInjector;

  constructor(public name: string, failures?: FailureInjector) {
    this.failures = failures ?? new FailureInjector();
  }

  // ── Permission API (R7) ──

  async queryPermission(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    this.queryPermissionCalls++;
    return this.permissions[opts?.mode ?? 'read'];
  }

  async requestPermission(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    this.requestPermissionCalls++;
    const mode = opts?.mode ?? 'read';
    if (this.permissions[mode] === 'denied') return 'denied';
    this.permissions[mode] = this.grantOnRequest;
    return this.permissions[mode];
  }

  // ── Directory API ──

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    this.failures.check('getDirectory', name);
    const hit = this.children.get(name);
    if (hit instanceof FakeDir) return hit;
    if (!opts?.create) throw namedError('NotFoundError', `no directory "${name}"`);
    const dir = new FakeDir(name, this.failures);
    dir.permissions = this.permissions;
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    this.failures.check('read', name);
    const hit = this.children.get(name);
    if (hit instanceof FakeFile) return hit;
    if (!opts?.create) throw namedError('NotFoundError', `no file "${name}"`);
    const file = new FakeFile(name, new Blob(), this.failures);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    this.failures.check('remove', name);
    if (!this.children.has(name)) throw namedError('NotFoundError', `no entry "${name}"`);
    this.children.delete(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const k of this.children.keys()) yield k;
  }

  async *entries(): AsyncIterableIterator<[string, FakeDir | FakeFile]> {
    for (const e of this.children.entries()) yield e;
  }

  // ── Test conveniences ──

  /** Direct child names, sorted. */
  childNames(): string[] {
    return [...this.children.keys()].sort();
  }

  has(name: string): boolean {
    return this.children.has(name);
  }

  /** Seed a text file without going through the writable stream. */
  seedText(name: string, text: string): FakeFile {
    const file = new FakeFile(name, new Blob([text]), this.failures);
    this.children.set(name, file);
    return file;
  }

  /** Seed a subdirectory. */
  seedDir(name: string): FakeDir {
    const dir = new FakeDir(name, this.failures);
    dir.permissions = this.permissions;
    this.children.set(name, dir);
    return dir;
  }

  /** Read a direct child file as text, or null when absent. */
  async readText(name: string): Promise<string | null> {
    const hit = this.children.get(name);
    if (!(hit instanceof FakeFile)) return null;
    return hit.text();
  }

  /** Read `sub/file` as text, or null. */
  async readTextAt(sub: string, name: string): Promise<string | null> {
    const dir = this.children.get(sub);
    if (!(dir instanceof FakeDir)) return null;
    return dir.readText(name);
  }
}

/** Cast helper — the fakes are structurally compatible but not nominally. */
export function asDirHandle(dir: FakeDir): FileSystemDirectoryHandle {
  return dir as unknown as FileSystemDirectoryHandle;
}
