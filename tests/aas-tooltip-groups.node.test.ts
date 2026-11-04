// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-682 §9.3 — grouping of AAS documents for the pinned tooltip and the
 * detail panel. Fixtures are SYNTHETIC, modelled on the IDTA 02004 shape
 * (one document per language, KeyWords as the kind, addresses that differ only
 * in their language segment) — no customer AASX.
 */
import { describe, expect, it } from 'vitest';
import type { AasDocument } from '../src/plugins/aas-link-parser';
import { displayTitle, documentKind, groupDocuments, normKind, summarizeDocuments } from '../src/plugins/aas-tooltip-groups';

function doc(p: Partial<AasDocument> & { kind?: string; language?: string }): AasDocument {
  return { title: p.title ?? 'composed', mimeType: 'application/pdf', zipPath: '', documentIdShort: '', baseTitle: '', ...p };
}

/** A DE/EN pair as IDTA 02004 files list them (two documents, same attachment id). */
function pair(n: number, de: Partial<AasDocument>, en: Partial<AasDocument>): AasDocument[] {
  return [
    doc({ language: 'DE', url: `https://vendor.example/assets/attachment/de/${n}`, ...de }),
    doc({ language: 'EN', url: `https://vendor.example/assets/attachment/en/${n}`, ...en }),
  ];
}

const SAMPLE: AasDocument[] = [
  ...pair(100, { kind: 'Konformitätserklärung', baseTitle: 'Zertifikate ATEX' }, { kind: 'Declaration of conformity', baseTitle: 'Certificates ATEX' }),
  ...pair(101, { kind: 'Anwendungsbeschreibung', baseTitle: 'Zahnrad' }, { kind: 'Application description', baseTitle: 'Identification' }),
  ...pair(102, { kind: 'Anwendungsbeschreibung', baseTitle: 'Münzen' }, { kind: 'Application description', baseTitle: 'Identification' }),
  ...pair(103, { kind: 'Betriebsanleitung', baseTitle: 'Bedienung X-DE', subtitle: 'Linearantrieb', version: '2024-07' }, { kind: 'Operating instructions', baseTitle: 'Operation X-EN', subtitle: 'Linear drive', version: '2024-07' }),
  ...pair(104, { kind: 'Application Note', baseTitle: 'Reparatur' }, { kind: 'Application Note', baseTitle: 'Repair' }),
  ...pair(105, { kind: 'Katalog', baseTitle: 'Technische Spezifikation' }, { kind: 'Catalogue', baseTitle: 'Technical specification' }),
  ...pair(106, { kind: 'Software', baseTitle: 'Montage' }, { kind: 'Software', baseTitle: 'Commissioning' }),
  doc({ language: 'DE', kind: 'Volldokumentation', baseTitle: 'Spezifikation X_DE.PDF', url: 'https://media.example/201_documentation.pdf' }),
  doc({ language: 'EN', kind: 'FullDocumentation', baseTitle: 'Specification X_EN.PDF', url: 'https://media.example/202_documentation.pdf' }),
  doc({ language: 'EN', kind: 'Wiring diagram', baseTitle: 'Wiring' }),
  doc({ language: 'EN', baseTitle: 'Loose sheet' }),
];

describe('plan-682 aas-tooltip-groups', () => {
  it('should order groups: operating instructions, full documentation, declaration of conformity, catalogue, application description, application note, software, rest, other', () => {
    const keys = groupDocuments(SAMPLE, ['en', 'de']).map(g => g.key);
    expect(keys).toEqual([
      'operating-instructions', 'full-documentation', 'declaration-of-conformity', 'catalogue',
      'application-description', 'application-note', 'software', 'kind:wiringdiagram', 'other',
    ]);
  });

  it('should map KeyWords/ClassName synonyms DE/EN case-insensitively and keep unknown kinds as own group', () => {
    expect(normKind('Konformitätserklärung')).toBe('konformitaetserklaerung');
    expect(documentKind(doc({ kind: 'BETRIEBSANLEITUNG' })).key).toBe('operating-instructions');
    expect(documentKind(doc({ kind: 'Operating Instructions' })).key).toBe('operating-instructions');
    expect(documentKind(doc({ kind: 'Konformitaetserklaerung' })).key).toBe('declaration-of-conformity');
    expect(documentKind(doc({ kind: 'FullDocumentation' })).key).toBe('full-documentation');
    const unknown = groupDocuments([doc({ kind: 'Wiring diagram', language: 'EN' })], ['en']);
    expect(unknown[0].key).toBe('kind:wiringdiagram');
    expect(unknown[0].label).toBe('Wiring diagram');
  });

  it('should collapse translations into one row per document, UI language primary, others as alternates (no DE/EN duplicate rows)', () => {
    const groups = groupDocuments(SAMPLE, ['de', 'en']);
    const app = groups.find(g => g.key === 'application-description')!;
    expect(app.entries).toHaveLength(2);
    expect(app.docCount).toBe(4);
    for (const e of app.entries) {
      expect(e.primary.language).toBe('DE');
      expect(e.alternates.map(a => a.language)).toEqual(['EN']);
    }
    // Label speaks the preferred language.
    expect(app.label).toBe('Anwendungsbeschreibung');
    expect(groupDocuments(SAMPLE, ['en', 'de']).find(g => g.key === 'application-description')!.label).toBe('Application description');
    // Different addresses (full documentation): paired by position.
    const full = groups.find(g => g.key === 'full-documentation')!;
    expect(full.entries).toHaveLength(1);
    expect(full.entries[0].alternates).toHaveLength(1);
  });

  it('should pair the k-th document of one language with the k-th of the other when addresses do not match', () => {
    const docs = [
      doc({ language: 'DE', kind: 'Application Note', baseTitle: 'A deutsch' }),
      doc({ language: 'EN', kind: 'Application Note', baseTitle: 'A english' }),
      doc({ language: 'DE', kind: 'Application Note', baseTitle: 'B deutsch' }),
      doc({ language: 'EN', kind: 'Application Note', baseTitle: 'B english' }),
    ];
    const g = groupDocuments(docs, ['en'])[0];
    expect(g.entries.map(e => [displayTitle(e.primary), displayTitle(e.alternates[0])])).toEqual([['A english', 'A deutsch'], ['B english', 'B deutsch']]);
  });

  it('should show a translation title when the preferred-language titles repeat within a group', () => {
    const app = groupDocuments(SAMPLE, ['en', 'de']).find(g => g.key === 'application-description')!;
    expect(app.entries.map(e => e.title).sort()).toEqual(['Münzen', 'Zahnrad']);
    expect(app.entries.every(e => e.primary.language === 'EN')).toBe(true);
  });

  it('should sort preferred language first within a group', () => {
    const docs = [
      doc({ language: 'FR', kind: 'Datasheet', baseTitle: 'Zeta', url: 'https://x/fr/1' }),
      doc({ language: 'EN', kind: 'Datasheet', baseTitle: 'Beta', url: 'https://x/en/2' }),
    ];
    const g = groupDocuments(docs, ['en', 'de'])[0];
    expect(g.entries[0].primary.language).toBe('EN');
  });

  it('should compose display title baseTitle – subtitle, fall back to documentIdShort then file name; version as separate tag', () => {
    expect(displayTitle(doc({ language: 'DE', baseTitle: 'Bedienung EHPS-DE', subtitle: 'Parallelgreifer', version: '2021-05b' })))
      .toBe('Bedienung EHPS – Parallelgreifer');
    expect(displayTitle(doc({ baseTitle: '', documentIdShort: 'Document07_ApplicationNoteDE', language: 'DE' }))).toBe('Application Note');
    expect(displayTitle(doc({ baseTitle: '', documentIdShort: '', zipPath: 'aasx/files/manual_x.pdf' }))).toBe('manual_x');
    expect(displayTitle(doc({ baseTitle: 'Spec', version: '1.2' }))).not.toContain('1.2');
    expect(displayTitle(doc({ baseTitle: 'M&#252;nzen &amp; Co', subtitle: 'W&#xE4;rme' }))).toBe('Münzen & Co – Wärme');
  });

  it('should keep title unchanged for consumers of AasDocument.title', () => {
    const legacy: AasDocument = { title: 'Operation EHPS (EN) · Operating instructions', mimeType: 'application/pdf', zipPath: 'a.pdf' };
    expect(displayTitle(legacy)).toBe('Operation EHPS (EN) · Operating instructions');
    const groups = groupDocuments([legacy], ['en']);
    expect(groups[0].entries[0].primary.title).toBe('Operation EHPS (EN) · Operating instructions');
  });

  it('should summarize for the hover tooltip in one line', () => {
    const s = summarizeDocuments(groupDocuments(SAMPLE, ['en']));
    expect(s).toBe('10 documents · Operating instructions, Full Documentation +7');
    expect(summarizeDocuments([])).toBe('');
  });
});
