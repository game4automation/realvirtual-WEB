// SPDX-License-Identifier: AGPL-3.0-only
/**
 * T14 (plan-739 §9.3, F5) — the demo-folder contract, stated identically in all FOUR places.
 *
 * ## What the contract is
 *
 * Since plan-738 there is ONE rule for everything under `projects/`, and the demo has no
 * exception: `projects/demo-realvirtual/` is seeded on the customer's FIRST delivery and is
 * never overwritten afterwards. `applySnapshot()` is the authority — it writes a project folder
 * only when it is seeding one or when the operator named it in `--projects` — and an ordinary
 * update replaces everything OUTSIDE `projects/` and writes nothing inside it.
 *
 * Before plan-739 three of the four places still carried the plan-737 wording ("overwritten on
 * every delivery", "replaces the whole folder"), which was not merely stale: a customer who reads
 * that their edits are doomed does not make any, and the sandbox stops being a sandbox. The
 * README generator was already correct, so the drift was invisible to anyone who only read the
 * delivered README.
 *
 * ## Why this file has no private dependency
 *
 * All four sources are in the public core, and this test must run on a machine without a private
 * sibling checkout — the same reason tests/doc-link-curation.node.test.ts exists separately.
 * `scripts/gen-private-test-excludes.mjs` classifies a test as private-dependent when a sibling
 * repo name appears anywhere in its source, so none is spelled out here.
 *
 * ## Why two of the four are asserted against source text
 *
 * `generateReadme()` and the `copyDemoRealvirtualFolder` docstring are not exported (the docstring
 * is a comment; it cannot be). Asserting against the real generator source is the closest thing to
 * asserting the generator itself, and it is still the REAL file — not a copy of the wording.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = join(__dirname, '..');
const LIB_PATH = join(CORE_ROOT, 'scripts', '_workspace-lib.mjs');
const LIB_SOURCE = readFileSync(LIB_PATH, 'utf8');

/** The seed-once rule, in the words all four places share. */
const SEED_ONCE = /never overwritten|arrives once/i;
/** The retired plan-737 wording. Either spelling contradicts the rule outright. */
const OVERWRITE_EVERY_TIME = /overwritten on every delivery|replaces the whole folder/i;

/**
 * The `//!` docstring immediately above a function, as one string.
 *
 * Walking backwards from the declaration rather than matching a fixed block keeps the test
 * working when the docstring grows, which it will.
 */
function docstringAbove(source: string, declaration: string): string {
  const lines = source.split('\n');
  const index = lines.findIndex(line => line.startsWith(declaration));
  if (index < 0) throw new Error(`Declaration not found in _workspace-lib.mjs: ${declaration}`);
  const collected: string[] = [];
  for (let cursor = index - 1; cursor >= 0 && lines[cursor].startsWith('//!'); cursor--) {
    collected.unshift(lines[cursor]);
  }
  if (collected.length === 0) throw new Error(`No //! docstring above ${declaration}`);
  return collected.join('\n');
}

/**
 * The body of `generateReadme()`, from its declaration to the next top-level declaration.
 *
 * The customer-facing README text is a template literal inside it, so the demo paragraph is
 * asserted where it is actually written rather than in a rendered copy. Rendering it here would
 * need a staged workspace, which needs the private sibling — exactly what this file avoids.
 */
function generateReadmeSource(source: string): string {
  const start = source.indexOf('\nfunction generateReadme(');
  if (start < 0) throw new Error('generateReadme() not found in _workspace-lib.mjs');
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export )?function [A-Za-z]/);
  return end < 0 ? rest : rest.slice(0, end);
}

const SOURCES: Array<[string, () => string]> = [
  ['demo.knowledge.md (what the customer reads inside the folder)',
    () => readFileSync(join(CORE_ROOT, 'public', 'demo-realvirtual', 'demo.knowledge.md'), 'utf8')],
  ['copyDemoRealvirtualFolder() docstring (what the next maintainer reads)',
    () => docstringAbove(LIB_SOURCE, 'export function copyDemoRealvirtualFolder(')],
  ['CLAUDE.md (what an agent working in this repo reads)',
    () => readFileSync(join(CORE_ROOT, 'CLAUDE.md'), 'utf8')],
  ['generateReadme() (what the delivered README says)',
    () => generateReadmeSource(LIB_SOURCE)],
];

describe('T14: the demo-folder contract says the same thing in all four places', () => {
  it('found all four sources', () => {
    // A source that silently stopped resolving would turn this whole file green while
    // checking three files, or none.
    expect(SOURCES).toHaveLength(4);
    for (const [, read] of SOURCES) expect(read().length).toBeGreaterThan(200);
  });

  it.each(SOURCES.map(([label]) => label))('%s states the seed-once rule', (label) => {
    const text = SOURCES.find(([name]) => name === label)![1]();
    expect(text).toMatch(SEED_ONCE);
  });

  it.each(SOURCES.map(([label]) => label))('%s does not claim the folder is replaced every time', (label) => {
    const text = SOURCES.find(([name]) => name === label)![1]();
    expect(text).not.toMatch(OVERWRITE_EVERY_TIME);
  });

  // The docstring is the one place that also has to keep the two apart: the delete-then-copy it
  // documents is real, and dropping the word "staging" from it would leave a maintainer thinking
  // the function deletes something in the customer's repository.
  it('the docstring says the delete-then-copy is the staging step', () => {
    const docstring = docstringAbove(LIB_SOURCE, 'export function copyDemoRealvirtualFolder(');
    expect(docstring).toMatch(/staging/i);
    expect(docstring).toMatch(/applySnapshot/);
  });

  // The demo paragraph used to sit in the projectless branch only, so a development customer
  // received the folder with no delivered document explaining it. It is unconditional now.
  it('the README states the rule for every customer, not only the projectless one', () => {
    const readme = generateReadmeSource(LIB_SOURCE);
    const paragraph = readme.split('\n').filter(line => line.includes('projects/demo-realvirtual/'));
    expect(paragraph.length).toBeGreaterThan(0);
    for (const line of paragraph) expect(line).not.toMatch(/^\s*[?:]/);
  });
});
