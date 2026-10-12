// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * make-dist.ts — a `dist/` just complete enough for the hosted stager
 * (`stageHostedProject`). One helper instead of the six local copies the
 * deploy tests used to carry (plan-759 R24).
 *
 * Mirrors what a real build emits and what the stager must DROP: the public
 * demo's `models/`, `scenes/`, `library/` folders and the hashed `assets/*.glb`
 * duplicates. Everything else (`index.html`, `assets/app.js`) must survive.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MakeDistOptions {
  /** Also emit the public demo content the stager must not ship. Default true. */
  demoContent?: boolean;
  /** Emit the third-party notices every real build carries (plan-544). Default true. */
  notices?: boolean;
}

/** Plaintext of the notices a fixture dist carries — tests assert it survives byte-identical. */
export const FIXTURE_NOTICES_TXT = 'realvirtual WEB — Third-party software notices (fixture)\n';
export const FIXTURE_NOTICES_JSON = '{"schema":1,"mode":"warn","violations":[],"components":[]}\n';

export function makeDist(root: string, opts: MakeDistOptions = {}): string {
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(root, 'assets', 'app.js'), '//');
  if (opts.notices !== false) {
    writeFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), FIXTURE_NOTICES_TXT);
    writeFileSync(join(root, 'third-party-notices.json'), FIXTURE_NOTICES_JSON);
  }
  if (opts.demoContent !== false) {
    writeFileSync(join(root, 'assets', 'demo-abc123.glb'), 'PUBLIC');
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'DemoRealvirtualWeb.glb'), 'PUBLIC');
    mkdirSync(join(root, 'scenes'), { recursive: true });
    writeFileSync(join(root, 'scenes', 'index.json'), '[]');
    mkdirSync(join(root, 'library'), { recursive: true });
    writeFileSync(join(root, 'library', 'catalog.json'), '{"entries":[]}');
  }
  return root;
}
