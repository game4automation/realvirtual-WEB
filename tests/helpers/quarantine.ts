// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * WebGPU quarantine (plan-602 F9/F10) — a named test whose BODY may fail for its
 * recorded cause.
 *
 * `quarantinedIt(id, cause, fn)` is a PLAIN `it` (deliberately not `test.fails`, which also
 * inverts hook, cleanup and timeout errors). Only the body's error is caught:
 *  - body fails and the message matches `cause` → the test passes and logs
 *    `[quarantine] known failure <id> — <message>`;
 *  - body passes → the test FAILS: "quarantined test now passes — remove it";
 *  - body fails for any other reason → that error is rethrown (red);
 *  - `beforeEach`/`afterEach`, `onTestFinished` cleanups and the runner timeout are untouched
 *    and stay red.
 * The id is `<file relative to the WebViewer root> :: <suite> > <title>` and must be listed
 * in `tests/webgpu-quarantine.json` → `webgpuQuarantine` with a cause the regex matches; the
 * running test's name and file are checked against it. The list may only shrink (guard:
 * `tests/webgpu-quarantine.node.test.ts`, QUARANTINE_BASELINE).
 */

import { expect, it } from 'vitest';
import quarantineList from '../webgpu-quarantine.json';

export interface QuarantineEntry {
  id: string;
  cause: string;
  ref?: string;
  /** Where the failure was classified (GPU, driver, browser, launch args, date) — mandatory in the repo list. */
  observedOn?: {
    gpu: string;
    driver: string;
    browser: string;
    launchArgs: string[];
    date: string;
  };
}

type Body = () => unknown;

/** `<file> :: <suite> > <title>` → its parts. */
export function splitQuarantineId(id: string): { file: string; name: string; title: string } {
  const sep = id.indexOf(' :: ');
  if (sep < 0) throw new Error(`[quarantine] malformed id (expected "<file> :: <suite> > <title>"): ${id}`);
  const file = id.slice(0, sep);
  const name = id.slice(sep + 4);
  const at = name.lastIndexOf(' > ');
  return { file, name, title: at < 0 ? name : name.slice(at + 3) };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** Builds a `quarantinedIt` over a quarantine list (the fixtures of the node test bring their own). */
export function createQuarantinedIt(entries: readonly QuarantineEntry[]) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return function quarantinedIt(id: string, cause: RegExp, fn: Body, timeout?: number): void {
    const { file, name, title } = splitQuarantineId(id);
    it(title, async () => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`[quarantine] ${id} is not in webgpuQuarantine (tests/webgpu-quarantine.json)`);
      if (!cause.test(entry.cause)) {
        throw new Error(`[quarantine] the recorded cause "${entry.cause}" of ${id} does not match ${cause}`);
      }
      const state = expect.getState();
      if (state.currentTestName !== undefined && state.currentTestName !== name) {
        throw new Error(`[quarantine] id names "${name}" but the running test is "${state.currentTestName}"`);
      }
      const testPath = state.testPath?.replace(/\\/g, '/');
      const fileTail = file.replace(/^(\.\.\/)+/, '');
      if (testPath && !testPath.endsWith(`/${fileTail}`)) {
        throw new Error(`[quarantine] id names file ${file} but the running file is ${testPath}`);
      }

      let failed = false;
      let error: unknown;
      try {
        await fn();
      } catch (err) {
        failed = true;
        error = err;
      }
      if (!failed) {
        throw new Error(`quarantined test now passes — remove ${id} from webgpuQuarantine (tests/webgpu-quarantine.json) and from QUARANTINE_BASELINE (tests/webgpu-quarantine.node.test.ts)`);
      }
      const message = messageOf(error);
      if (!cause.test(message)) throw error;
      console.warn(`[quarantine] known failure ${id} — ${message.split('\n')[0]}${entry.ref ? ` (${entry.ref})` : ''}`);
    }, timeout);
  };
}

/** The repository's WebGPU quarantine (`tests/webgpu-quarantine.json` → `webgpuQuarantine`). */
export const quarantinedIt = createQuarantinedIt((quarantineList as { webgpuQuarantine: QuarantineEntry[] }).webgpuQuarantine);
