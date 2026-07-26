const COMPACT_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉']];
const MAX_STRONG_ANCHORS = 10;

function normalizedNumber(value) {
  const text = String(value || '');
  if (!/^\d+$/u.test(text)) return text;
  return text.replace(/^0+(?=\d)/u, '');
}

function normalizedTokens(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}\p{M}]+/gu)
    ?.map(normalizedNumber) || [];
}

function sourceTokens(value) {
  return String(value || '').normalize('NFKC').match(/[\p{L}\p{N}\p{M}]+/gu) || [];
}

function normalizedPhrase(value) {
  return normalizedTokens(value).join(' ');
}

function normalizedDate(value) {
  return (String(value || '').match(/\d+/gu) || []).map(normalizedNumber).join(' ');
}

function evidenceTerms(query) {
  const tokens = normalizedTokens(query);
  const terms = [];
  for (const token of tokens) {
    const characters = [...token];
    if (COMPACT_SCRIPT.test(token)) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        terms.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else if (characters.length >= (/^\d+$/u.test(token) ? 2 : /^[a-z0-9]+$/i.test(token) ? 3 : 2)) {
      terms.push(token);
    }
  }
  return [...new Set(terms)];
}

function escapedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delimitedValues(value, open, close) {
  const pattern = new RegExp(`${escapedPattern(open)}([^${escapedPattern(close)}\\r\\n]+)${escapedPattern(close)}`, 'gu');
  return [...String(value || '').matchAll(pattern)].map((match) => ({ value: match[1], index: match.index || 0 }));
}

function patternValues(value, pattern) {
  return [...String(value || '').matchAll(pattern)].map((match) => ({
    value: match[0],
    index: match.index || 0,
    end: (match.index || 0) + match[0].length,
  }));
}

function dateValues(value) {
  return patternValues(String(value || '').normalize('NFKC'), /(?<!\d)(?:19|20)\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)?(?!\d)/gu);
}

function overlaps(span, spans) {
  return spans.some((entry) => span.index < entry.end && entry.index < span.end);
}

function strongAnchor(value, kind, index = 0, partial = false) {
  const normalized = kind === 'date' ? normalizedDate(value) : normalizedPhrase(value);
  if (!normalized) return null;
  return { value: normalized, kind, index, partial };
}

function anchorMatchesTokens(tokens, anchor) {
  if (!anchor?.value) return false;
  const text = tokens.join(' ');
  if (anchor.partial) return text.replace(/\s+/g, '').includes(anchor.value.replace(/\s+/g, ''));
  return ` ${text} `.includes(` ${anchor.value} `);
}

function anchorMatchesValue(value, tokens, anchor) {
  if (anchor?.kind === 'date') {
    return dateValues(value).some((entry) => normalizedDate(entry.value) === anchor.value);
  }
  return anchorMatchesTokens(tokens, anchor);
}

function anchorDocumentHits(anchor, documents) {
  return documents.reduce((count, tokens) => count + Number(anchorMatchesTokens(tokens, anchor)), 0);
}

function uniqueAnchors(anchors, limit = MAX_STRONG_ANCHORS) {
  const seen = new Set();
  const output = [];
  for (const anchor of anchors) {
    if (!anchor || seen.has(anchor.value)) continue;
    seen.add(anchor.value);
    output.push(anchor);
    if (output.length >= limit) break;
  }
  return output;
}

function fixedStrongAnchors(query) {
  const source = String(query || '').normalize('NFKC');
  const quoted = QUOTE_PAIRS.flatMap(([open, close]) => delimitedValues(source, open, close))
    .map((entry) => strongAnchor(entry.value, 'quoted', entry.index, COMPACT_SCRIPT.test(entry.value)))
    .filter((entry) => entry && entry.value.replace(/\s+/g, '').length >= 4)
    .slice(0, 2);
  const identifiers = patternValues(source, /[A-Za-z]+(?:[-_.]?\d+)+(?:[-_.]?[A-Za-z\d]+)*/gu);
  const dates = dateValues(source);
  const occupied = [...identifiers, ...dates];
  const numbers = patternValues(source, /(?<![\p{L}\p{N}\p{M}])\d+(?:[.,]\d+)?(?![\p{L}\p{N}\p{M}])/gu)
    .filter((entry) => !overlaps(entry, occupied));
  const lexicalEntities = sourceTokens(source)
    .map((value, index) => ({ value, index }))
    .filter((entry) => [...entry.value].length >= 6
      && /[A-Z]/u.test(entry.value)
      && /[a-z]/u.test(entry.value)
      && !/^\d+$/u.test(entry.value))
    .map((entry) => strongAnchor(entry.value, 'entity', entry.index));
  return uniqueAnchors([
    ...quoted,
    ...lexicalEntities.slice(0, 3),
    ...identifiers.slice(0, 3).map((entry) => strongAnchor(entry.value, 'identifier', entry.index)),
    ...dates.slice(0, 3).map((entry) => strongAnchor(entry.value, 'date', entry.index)),
    ...numbers.slice(0, 3).map((entry) => strongAnchor(entry.value, 'number', entry.index)),
  ]);
}

function observedRareTokenAnchors(query, documents) {
  if (documents.length < 2) return [];
  const maxDocumentHits = Math.max(1, Math.floor(documents.length / 3));
  return sourceTokens(query)
    .filter((value) => [...value].length >= 6 && !/^\d+$/u.test(value) && !COMPACT_SCRIPT.test(value))
    .map((value, index) => {
      const anchor = strongAnchor(value, 'term', index);
      return { anchor, documentHits: anchorDocumentHits(anchor, documents) };
    })
    .filter((entry) => entry.documentHits > 0 && entry.documentHits <= maxDocumentHits)
    .sort((left, right) => left.documentHits - right.documentHits
      || right.anchor.value.length - left.anchor.value.length
      || left.anchor.index - right.anchor.index)
    .slice(0, 2)
    .map(({ anchor }) => anchor);
}

function documentStrongAnchors(query, documents) {
  if (!documents.length) return [];
  const tokens = normalizedTokens(query);
  const candidates = [];
  for (const [index, token] of tokens.entries()) {
    if (COMPACT_SCRIPT.test(token) && [...token].length >= 4) {
      candidates.push(strongAnchor(token, 'segment', index, true));
    }
    const next = tokens[index + 1];
    if (next && ((/[\p{L}\p{M}]/u.test(token) && /^\d+$/u.test(next)) || (/^\d+$/u.test(token) && /[\p{L}\p{M}]/u.test(next)))) {
      candidates.push(strongAnchor(`${token} ${next}`, 'segment', index));
    }
  }
  if (tokens.length >= 4) {
    for (let index = 0; index <= tokens.length - 3; index += 1) {
      candidates.push(strongAnchor(tokens.slice(index, index + 3).join(' '), 'segment', index));
    }
  }
  const ranked = uniqueAnchors(candidates, 40)
    .map((anchor) => ({ ...anchor, documentHits: anchorDocumentHits(anchor, documents) }))
    .filter((anchor) => anchor.documentHits > 0)
    .sort((left, right) => left.documentHits - right.documentHits
      || right.value.length - left.value.length
      || left.index - right.index);
  return [
    ...observedRareTokenAnchors(query, documents),
    ...ranked.slice(0, 3).map(({ documentHits, ...anchor }) => anchor),
  ].slice(0, 3);
}

function strongAnchorProfile(query, documents) {
  const anchors = uniqueAnchors([
    ...fixedStrongAnchors(query),
    ...documentStrongAnchors(query, documents),
  ]);
  const count = anchors.length;
  const requiredHits = count < 2 ? count : count < 5 ? 2 : 3;
  return {
    anchors,
    requiredHits,
    requiredCoverage: count ? requiredHits / count : 0,
  };
}

export function webEvidenceTerms(query, maxTerms = 12) {
  return evidenceTerms(query).slice(0, maxTerms);
}

export function webEvidenceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function webEvidenceHitCount(value, terms) {
  const text = webEvidenceText(value).normalize('NFKC').toLowerCase();
  return (terms || []).reduce((hits, term) => hits + (text.includes(term) ? 1 : 0), 0);
}

export function webEvidenceRequiredHits(terms) {
  const count = Array.isArray(terms) ? terms.length : 0;
  if (!count) return 0;
  if (count < 3) return 1;
  return count < 7 ? 2 : 3;
}

export function webEvidenceProfile(query, documents = [], maxTerms = 12) {
  const limit = Number.isInteger(maxTerms) && maxTerms > 0 ? maxTerms : 12;
  const texts = (Array.isArray(documents) ? documents : [])
    .map((value) => webEvidenceText(value).normalize('NFKC').toLowerCase())
    .filter(Boolean);
  const documentTokens = texts.map(normalizedTokens);
  const candidates = evidenceTerms(query).slice(0, limit * 4);
  const ranked = candidates.map((term, index) => {
    const documentHits = texts.reduce((count, text) => count + Number(text.includes(term)), 0);
    const weight = texts.length ? 1 + ((texts.length - documentHits) / texts.length) : 1;
    return { term, index, documentHits, weight };
  });
  ranked.sort((left, right) => Number(!left.documentHits) - Number(!right.documentHits)
    || left.documentHits - right.documentHits
    || left.index - right.index);
  const observed = ranked.filter((entry) => entry.documentHits > 0);
  const selected = texts.length && observed.length >= 2 ? observed : ranked;
  const terms = selected.slice(0, limit).map(({ term, weight }) => ({ term, weight }));
  return {
    terms,
    requiredHits: webEvidenceRequiredHits(terms),
    requiredCoverage: terms.length > 2 ? 0.4 : 0,
    strong: strongAnchorProfile(query, documentTokens),
  };
}

export function webEvidenceMatch(value, profile) {
  const text = webEvidenceText(value).normalize('NFKC').toLowerCase();
  const terms = Array.isArray(profile?.terms) ? profile.terms : [];
  let hits = 0;
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const entry of terms) {
    const term = String(entry?.term || '');
    const weight = Number.isFinite(Number(entry?.weight)) ? Number(entry.weight) : 1;
    totalWeight += weight;
    if (!term || !text.includes(term)) continue;
    hits += 1;
    matchedWeight += weight;
  }
  const coverage = totalWeight ? matchedWeight / totalWeight : 1;
  const lexicalAccepted = !terms.length || (hits >= Number(profile?.requiredHits || 0)
    && coverage + Number.EPSILON >= Number(profile?.requiredCoverage || 0));
  const anchors = Array.isArray(profile?.strong?.anchors) ? profile.strong.anchors : [];
  const tokens = normalizedTokens(value);
  const anchorHits = anchors.reduce((count, anchor) => count + Number(anchorMatchesValue(value, tokens, anchor)), 0);
  const anchorCoverage = anchors.length ? anchorHits / anchors.length : 1;
  const anchorsAccepted = !anchors.length || (anchorHits >= Number(profile?.strong?.requiredHits || 0)
    && anchorCoverage + Number.EPSILON >= Number(profile?.strong?.requiredCoverage || 0));
  return {
    accepted: lexicalAccepted,
    hits,
    coverage,
    anchorsAccepted,
    anchorHits,
    anchorCoverage,
    anchorCount: anchors.length,
  };
}
