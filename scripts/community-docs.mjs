// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const START = '<!-- BEGIN GENERATED VIEWER EVENTS -->';
const END = '<!-- END GENERATED VIEWER EVENTS -->';

export function membersOf(source, interfaceName) {
  const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName);
  if (!declaration) throw new Error(`Interface ${interfaceName} not found`);
  return declaration.members;
}

export function eventTable(source) {
  const printer = ts.createPrinter({ removeComments: true });
  const rows = membersOf(source, 'ViewerEvents').map(member => {
    const payload = printer.printNode(ts.EmitHint.Unspecified, member.type, member.getSourceFile())
      .replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
    return `| \`${member.name.text}\` | \`${payload}\` |`;
  });
  return `${START}\n| Event | Payload |\n|---|---|\n${rows.join('\n')}\n${END}`;
}

export function withoutFences(text) {
  return text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
}

// GitHub-style heading anchors for these guides: preserve Unicode letters, hyphens
// and underscores, strip inline formatting/punctuation, and suffix duplicates.
export function headingIds(text) {
  const ids = new Set();
  const counts = new Map();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const plain = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/<[^>]*>/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(plain) ?? 0;
    let id = count ? `${plain}-${count}` : plain;
    let suffix = count;
    while (ids.has(id)) id = `${plain}-${++suffix}`;
    counts.set(plain, suffix + 1);
    ids.add(id);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\s+[^>]*(?:id|name)=["']([^"']+)["']/gi)) ids.add(match[1]);
  return ids;
}

export function checkLinks(root, file, text, read = path => existsSync(path) ? readFileSync(path, 'utf8') : null) {
  const errors = [];
  const prose = withoutFences(text);
  // Retain code formatting inside link labels; stripping it loses source links.
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    const [pathPart, fragment] = raw.split('#');
    const target = resolve(dirname(resolve(root, file)), decodeURIComponent(pathPart || file.split('/').at(-1)));
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || raw.startsWith('/')) {
      errors.push(`${file}: link leaves the Community repository: ${raw}`);
      continue;
    }
    // Directory links are handled by the publication gate.
    if (pathPart.endsWith('/')) continue;
    if (extname(target).toLowerCase() !== '.md') continue;
    const content = read(target);
    if (content === null) errors.push(`${file}: missing Markdown target: ${raw}`);
    else if (fragment && !headingIds(content).has(decodeURIComponent(fragment))) {
      errors.push(`${file}: missing heading: ${raw}`);
    }
  }
  return errors;
}

export function checkApi(eventsSource, pluginsSource, guide) {
  const errors = [];
  const expected = eventTable(eventsSource);
  if (!guide.includes(expected)) errors.push('doc-events-and-hooks.md: generated event catalog differs from ViewerEvents; run npm run docs:generate');
  for (const member of membersOf(pluginsSource, 'RVViewerPlugin').filter(ts.isMethodSignature)) {
    if (!guide.includes(`\`${member.name.text}(`)) errors.push(`doc-events-and-hooks.md: missing plugin callback ${member.name.text}`);
  }
  return errors;
}

export function checkDocs(root = ROOT) {
  const read = file => readFileSync(resolve(root, file), 'utf8');
  const docs = readdirSync(root).filter(file => /^doc-.*\.md$/.test(file)).sort();
  const readme = read('README.md');
  const errors = [];
  for (const file of docs) {
    if (!readme.includes(`](${file})`)) errors.push(`README.md: missing guide ${file}`);
  }
  for (const file of ['README.md', ...docs]) errors.push(...checkLinks(root, file, read(file)));

  // Direct inline references to root guides must resolve too. Qualified references
  // to separate CONNECT/appliance products are intentionally outside this rule.
  for (const file of docs) {
    for (const match of withoutFences(read(file)).matchAll(/`(doc-[\w-]+\.md)`/g)) {
      if (!existsSync(resolve(root, match[1]))) errors.push(`${file}: unavailable inline guide ${match[1]}`);
    }
  }
  errors.push(...checkApi(read('src/core/rv-viewer-events.ts'), read('src/core/rv-plugin.ts'), read('doc-events-and-hooks.md')));

  // These entry guides contain copy/paste commands at the public repository root.
  // Maintainer guides and examples with another cwd are not interpreted as shell.
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const file of ['doc-getting-started.md', 'doc-embedding.md', 'doc-project-plugin-example.md']) {
    for (const match of read(file).matchAll(/^npm run ([\w:-]+)/gm)) {
      if (!scripts[match[1]]) errors.push(`${file}: unknown public npm script ${match[1]}`);
    }
  }
  return { errors: [...new Set(errors)], count: docs.length };
}

function main() {
  if (process.argv.includes('--write')) {
    const path = resolve(ROOT, 'doc-events-and-hooks.md');
    const text = readFileSync(path, 'utf8');
    const start = text.indexOf(START);
    const end = text.indexOf(END, start);
    if (start < 0 || end < 0) throw new Error('Missing generated event table markers');
    writeFileSync(path, text.slice(0, start) + eventTable(readFileSync(resolve(ROOT, 'src/core/rv-viewer-events.ts'), 'utf8')) + text.slice(end + END.length));
    console.log('Updated ViewerEvents reference.');
    return;
  }
  const { errors, count } = checkDocs();
  errors.forEach(error => console.error(error));
  console.log(`Community documentation: ${count} guides, ${errors.length} findings.`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
