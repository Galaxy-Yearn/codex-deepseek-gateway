import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWebSearchEvidenceForTests,
  rememberWebSearchEvidence,
  webSearchEvidenceNote,
} from '../src/web-search-evidence.js';

async function scenario(name, run) {
  clearWebSearchEvidenceForTests();
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function searchRecord(label) {
  return {
    action: 'search',
    query: label,
    results: [{ title: `Result ${label}`, url: `https://example.com/${label}` }],
  };
}

test('web search evidence remembers and replays best-effort follow-up context', async () => {
  await scenario('a remembered search hit is prefixed and includes the source', async () => {
    rememberWebSearchEvidence('item-1', searchRecord('a'));
    const note = webSearchEvidenceNote('item-1');
    assert.match(note, /^Earlier web evidence: /);
    assert.match(note, /Result a/);
    assert.match(note, /https:\/\/example\.com\/a/);
    assert.match(note, /\[search snippet\]/);
  });
  await scenario('opened search results preserve page provenance and prefer page evidence', async () => {
    rememberWebSearchEvidence('item-opened-result', {
      action: 'search',
      results: [{
        title: 'Search Title',
        url: 'https://example.com/search',
        snippet: 'Search snippet should be secondary.',
        page: {
          title: 'Opened Title',
          url: 'https://example.com/opened?full=1',
          summary: 'Opened page summary.',
          matches: ['First opened match.', 'Second opened match.'],
          markdown: 'Long page body should not outrank the summary.',
        },
      }],
    });
    const note = webSearchEvidenceNote('item-opened-result');
    assert.match(note, /\[opened page\]/);
    assert.match(note, /Opened Title/);
    assert.match(note, /https:\/\/example\.com\/opened\?full=1/);
    assert.match(note, /Opened page summary/);
    assert.doesNotMatch(note, /Long page body/);
  });
  await scenario('an open_page record is remembered under its own action shape', async () => {
    rememberWebSearchEvidence('item-page', {
      action: 'open_page',
      url: 'https://example.com/page',
      title: 'Page Title',
      summary: 'Page summary text',
    });
    const note = webSearchEvidenceNote('item-page');
    assert.match(note, /^Earlier web evidence: /);
    assert.match(note, /\[opened page\]/);
    assert.match(note, /Page Title/);
    assert.match(note, /Page summary text/);
  });
  await scenario('unknown, empty, or blank item ids return an empty note', async () => {
    assert.equal(webSearchEvidenceNote(''), '');
    assert.equal(webSearchEvidenceNote('   '), '');
    assert.equal(webSearchEvidenceNote(undefined), '');
    assert.equal(webSearchEvidenceNote('never-remembered'), '');
  });
  await scenario('remembering with an empty or blank item id is a no-op', async () => {
    rememberWebSearchEvidence('', searchRecord('ignored'));
    rememberWebSearchEvidence('   ', searchRecord('ignored'));
    rememberWebSearchEvidence(undefined, searchRecord('ignored'));
    assert.equal(webSearchEvidenceNote(''), '');
  });
  await scenario('a record that produces no evidence text is not stored', async () => {
    rememberWebSearchEvidence('item-empty', { action: 'search', results: [] });
    assert.equal(webSearchEvidenceNote('item-empty'), '');
  });
  await scenario('a hit persists and can be read again on a later follow-up', async () => {
    rememberWebSearchEvidence('item-again', searchRecord('again'));
    assert.notEqual(webSearchEvidenceNote('item-again'), '');
    assert.notEqual(webSearchEvidenceNote('item-again'), '');
  });
  await scenario('remembering the same item id again replaces the stored evidence', async () => {
    rememberWebSearchEvidence('item-replace', searchRecord('first'));
    rememberWebSearchEvidence('item-replace', searchRecord('second'));
    const note = webSearchEvidenceNote('item-replace');
    assert.match(note, /Result second/);
    assert.doesNotMatch(note, /Result first/);
  });
  await scenario('the LRU cap evicts the oldest untouched entry once past 200 records', async () => {
    for (let index = 0; index < 200; index += 1) {
      rememberWebSearchEvidence(`evidence-${index}`, searchRecord(String(index)));
    }
    rememberWebSearchEvidence('evidence-201', searchRecord('201'));
    assert.equal(webSearchEvidenceNote('evidence-0'), '');
    assert.notEqual(webSearchEvidenceNote('evidence-1'), '');
  });
  await scenario('reading an entry refreshes its freshness ahead of the next eviction', async () => {
    for (let index = 0; index < 200; index += 1) {
      rememberWebSearchEvidence(`fresh-${index}`, searchRecord(String(index)));
    }
    assert.notEqual(webSearchEvidenceNote('fresh-0'), '');
    rememberWebSearchEvidence('fresh-200', searchRecord('200'));
    assert.equal(webSearchEvidenceNote('fresh-1'), '');
    assert.notEqual(webSearchEvidenceNote('fresh-0'), '');
    assert.notEqual(webSearchEvidenceNote('fresh-199'), '');
    assert.notEqual(webSearchEvidenceNote('fresh-200'), '');
  });
  await scenario('clearWebSearchEvidenceForTests empties all remembered evidence', async () => {
    rememberWebSearchEvidence('item-clear-1', searchRecord('one'));
    rememberWebSearchEvidence('item-clear-2', searchRecord('two'));
    clearWebSearchEvidenceForTests();
    assert.equal(webSearchEvidenceNote('item-clear-1'), '');
    assert.equal(webSearchEvidenceNote('item-clear-2'), '');
  });
});
