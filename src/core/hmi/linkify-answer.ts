// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { DiagnoseSource } from '../../plugins/diagnose/diagnose-provider';

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'part'; text: string; path: string }
  | { kind: 'doc'; text: string; source: DiagnoseSource };

export interface AnswerLinkResolvers {
  resolvePart(token: string): string | null;
  resolveDoc(token: string): DiagnoseSource | null;
}

interface Atom {
  start: number;
  end: number;
}

const ATOM_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_./:\\-]*[\p{L}\p{N}_])?/gu;
const MAX_CANDIDATE_ATOMS = 8;

function appendText(segments: AnswerSegment[], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === 'text') previous.text += text;
  else segments.push({ kind: 'text', text });
}

/**
 * Conservatively turns exact resolver matches into answer links. Every
 * unmatched character is preserved verbatim and adjacent text is coalesced.
 */
export function linkifyAnswer(text: string, resolvers: AnswerLinkResolvers): AnswerSegment[] {
  if (!text) return [];

  const atoms = Array.from(text.matchAll(ATOM_RE), (match): Atom => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (atoms.length === 0) return [{ kind: 'text', text }];

  const segments: AnswerSegment[] = [];
  let cursor = 0;
  let atomIndex = 0;

  while (atomIndex < atoms.length) {
    const startAtom = atoms[atomIndex];
    let matchedEnd = -1;
    let matched: AnswerSegment | null = null;
    const maxEnd = Math.min(atoms.length - 1, atomIndex + MAX_CANDIDATE_ATOMS - 1);

    for (let endIndex = maxEnd; endIndex >= atomIndex; endIndex--) {
      let joinsAreWhitespace = true;
      for (let join = atomIndex; join < endIndex; join++) {
        if (!/^\s+$/.test(text.slice(atoms[join].end, atoms[join + 1].start))) {
          joinsAreWhitespace = false;
          break;
        }
      }
      if (!joinsAreWhitespace) continue;

      const candidate = text.slice(startAtom.start, atoms[endIndex].end);
      const partPath = resolvers.resolvePart(candidate);
      if (partPath) {
        matched = { kind: 'part', text: candidate, path: partPath };
        matchedEnd = endIndex;
        break;
      }
      const source = resolvers.resolveDoc(candidate);
      if (source) {
        matched = { kind: 'doc', text: candidate, source };
        matchedEnd = endIndex;
        break;
      }
    }

    if (!matched) {
      atomIndex++;
      continue;
    }

    appendText(segments, text.slice(cursor, startAtom.start));
    segments.push(matched);
    cursor = atoms[matchedEnd].end;
    atomIndex = matchedEnd + 1;
  }

  appendText(segments, text.slice(cursor));
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}
