import { isObject } from './common.js';

const MAX_EVIDENCE_RECORDS = 200;
const MAX_EVIDENCE_CHARS = 1600;
const MAX_SOURCE_COUNT = 5;
const MAX_SOURCE_TEXT_CHARS = 220;

const evidenceByItemId = new Map();

function compactText(value, maxChars = MAX_SOURCE_TEXT_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return '';
}

function pageMatchesText(page) {
  if (!Array.isArray(page?.matches)) return '';
  return page.matches.slice(0, 2).map((match) => compactText(match, 260)).filter(Boolean).join(' ');
}

function sourceEvidenceLine(source, index) {
  if (!isObject(source)) return '';
  const opened = isObject(source.page);
  const title = compactText(opened ? source.page.title || source.title || source.url : source.title || source.url, 160);
  const url = compactText(opened ? source.page.url || source.url : source.url, 700);
  const date = compactText(source.publishedDate || source.published_date, 80);
  const detail = opened
    ? firstText(source.page.summary, pageMatchesText(source.page), source.snippet, source.content, source.page.markdown)
    : firstText(source.snippet, source.content, source.summary);
  const head = [`${index}.`, opened ? '[opened page]' : '[search snippet]', title, url ? `<${url}>` : ''].filter(Boolean).join(' ');
  const meta = date ? ` Date: ${date}.` : '';
  return compactText(`${head}.${meta}${detail ? ` ${detail}` : ''}`, 900);
}

function pageEvidenceLine(page, action) {
  const title = compactText(page?.title || page?.url, 140);
  const url = compactText(page?.url, 700);
  const detail = firstText(page?.summary, pageMatchesText(page), page?.markdown);
  const error = compactText(page?.error, 240);
  const provenance = action === 'find_in_page' ? '[find in opened page]' : '[opened page]';
  return compactText([provenance, title && url ? `${title} <${url}>.` : title || url, error ? `Error: ${error}.` : '', detail].filter(Boolean).join(' '), 900);
}

function evidenceText(record = {}) {
  const lines = [];
  const action = record.action === 'open_page' || record.action === 'find_in_page' ? record.action : 'search';
  if (action === 'search') {
    const results = Array.isArray(record.results) ? record.results : [];
    const answer = compactText(record.answer, 360);
    if (answer) lines.push(`Answer summary: ${answer}`);
    for (const [index, result] of results.slice(0, MAX_SOURCE_COUNT).entries()) {
      const line = sourceEvidenceLine(result, index + 1);
      if (line) lines.push(line);
    }
  } else {
    const line = pageEvidenceLine(record, action);
    if (line) lines.push(line);
  }
  if (record.error && !lines.some((line) => /Error:/i.test(line))) {
    lines.unshift(`Error: ${compactText(record.error, 240)}.`);
  }
  return compactText(lines.join(' '), MAX_EVIDENCE_CHARS);
}

export function rememberWebSearchEvidence(itemId, record) {
  const id = String(itemId || '').trim();
  if (!id) return;
  const text = evidenceText(record);
  if (!text) return;
  if (evidenceByItemId.has(id)) evidenceByItemId.delete(id);
  evidenceByItemId.set(id, text);
  while (evidenceByItemId.size > MAX_EVIDENCE_RECORDS) {
    evidenceByItemId.delete(evidenceByItemId.keys().next().value);
  }
}

export function webSearchEvidenceNote(itemId) {
  const id = String(itemId || '').trim();
  if (!id || !evidenceByItemId.has(id)) return '';
  const text = evidenceByItemId.get(id);
  evidenceByItemId.delete(id);
  evidenceByItemId.set(id, text);
  return `Earlier web evidence: ${text}`;
}

export function clearWebSearchEvidenceForTests() {
  evidenceByItemId.clear();
}
