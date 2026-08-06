import { existsSync, readFileSync } from 'node:fs';
import { isObject, parseJsonObject } from './common.js';

export function readModelCatalog(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return parseJsonObject(raw, { source: String(filePath), throwOnInvalid: true });
}

export function modelCatalogEntries(catalog) {
  const entries = [];
  const seen = new Set();
  for (const model of Array.isArray(catalog?.models) ? catalog.models : []) {
    if (!isObject(model)) continue;
    const slug = String(model.slug || '').trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ ...model, slug });
  }
  return entries;
}

export function modelCatalogModelIds(catalog) {
  return modelCatalogEntries(catalog).map((model) => model.slug);
}

export function modelAliasesFromCatalog(catalog) {
  return Object.fromEntries(modelCatalogModelIds(catalog).map((model) => [model, { model, thinking: 'auto' }]));
}
