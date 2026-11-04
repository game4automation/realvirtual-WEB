import type { FeatureCatalog, TierManifest } from './_workspace-lib.mjs';

/** One edition row of the public `features.json` (plan-646 §2.3). */
export interface FeaturesJsonEditionRow {
  id: string;
  label: string;
  summary: string;
  edition: 'community' | 'commercial';
  status: 'stable' | 'beta';
  inDemo: true;
  docs?: string;
  demoUrl?: string;
  cells?: never;
}
/** A row with fixed column texts (the CONNECT interfaces): no edition, the cells say it all. */
export interface FeaturesJsonCellsRow {
  id: string;
  label: string;
  summary: string;
  edition?: never;
  status: 'stable';
  inDemo: true;
  docs?: string;
  demoUrl?: never;
  cells: { community: string; commercial: string; demo: string };
}
export type FeaturesJsonRow = FeaturesJsonEditionRow | FeaturesJsonCellsRow;
export interface FeaturesJson {
  version: 1;
  editions: { community: string; commercial: string; demo: string };
  groups: Array<{ id: string; label: string; note?: string; rows: FeaturesJsonRow[] }>;
}
export class FeatureCatalogError extends Error {
  problems: string[];
  constructor(problems: string[]);
}
export const EDITIONS_BEGIN: string;
export const EDITIONS_END: string;
export const DEFAULT_OUTPUT: string;
export function hiddenFeatureIds(manifest: TierManifest): Set<string>;
export function assertNoHiddenIds(text: string, hidden: Set<string>, where: string): void;
export function buildFeaturesJson(input: { catalog: FeatureCatalog; manifest: TierManifest; demoDocIds: Set<string> }): FeaturesJson;
export function serializeFeaturesJson(features: FeaturesJson): string;
export function renderEditionsBlock(features: FeaturesJson): string;
export function replaceEditionsBlock(readme: string, block: string): string;
export function extractEditionsBlock(readme: string): string | null;
export function demoDocumentIds(coreRoot?: string): Set<string>;
export type GenerateFeaturesResult =
  | { available: false; manifestPath: string }
  | { available: true; features: FeaturesJson; json: string; block: string };
export function generateFeatures(options?: {
  coreRoot?: string;
  privateRoot?: string;
  catalogPath?: string;
  demoDocIds?: Set<string>;
}): GenerateFeaturesResult;
export function main(args?: string[]): number;
