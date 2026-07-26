import assert from 'node:assert/strict';
import test from 'node:test';
import { displayWidth, padDisplay, truncateDisplay } from '../src/terminal-text.js';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

test('displayWidth measures grapheme clusters', async () => {
  await scenario('ASCII text counts one column per character', async () => {
    assert.equal(displayWidth('hello'), 5);
    assert.equal(displayWidth(''), 0);
  });
  await scenario('wide CJK characters count two columns each', async () => {
    assert.equal(displayWidth('中文'), 4);
  });
  await scenario('emoji and combining marks collapse to their visible width', async () => {
    assert.equal(displayWidth('é'), 1);
    assert.equal(displayWidth('\u{1F44D}'), 2);
  });
});

test('truncateDisplay bounds output width for every max', async () => {
  await scenario('max <= 0 always returns an empty string', async () => {
    assert.equal(truncateDisplay('hello', 0), '');
    assert.equal(truncateDisplay('hello', -1), '');
    assert.equal(truncateDisplay('', 0), '');
  });
  await scenario('text that already fits is returned unchanged', async () => {
    assert.equal(truncateDisplay('hi', 5), 'hi');
    assert.equal(truncateDisplay('ab', 2), 'ab');
    assert.equal(truncateDisplay('中文', 4), '中文');
  });
  await scenario('overflow with max below the ellipsis width returns bare dots', async () => {
    assert.equal(truncateDisplay('hello', 1), '.');
    assert.equal(truncateDisplay('hello', 2), '..');
    assert.equal(truncateDisplay('中文文本', 1), '.');
    assert.equal(truncateDisplay('中文文本', 2), '..');
  });
  await scenario('overflow at max 3 falls back to the ellipsis with no content', async () => {
    assert.equal(truncateDisplay('hello', 3), '...');
    assert.equal(truncateDisplay('中文文本', 3), '...');
  });
  await scenario('overflow above max 3 keeps as much content as fits before the ellipsis', async () => {
    assert.equal(truncateDisplay('hello world', 4), 'h...');
    assert.equal(truncateDisplay('中文文本内容超长', 5), '中...');
  });
  await scenario('result display width never exceeds max across a boundary sweep', async () => {
    const samples = ['hello world', '中文文本内容超长', 'mixed 中文 text here', ''];
    for (const sample of samples) {
      for (let max = -1; max <= 12; max += 1) {
        const truncated = truncateDisplay(sample, max);
        assert.ok(displayWidth(truncated) <= Math.max(0, max), `${JSON.stringify(sample)} at max=${max} produced ${JSON.stringify(truncated)}`);
      }
    }
  });
});

test('padDisplay never throws and always reaches the target width', async () => {
  await scenario('boundary widths 0 through 3 pad without raising', async () => {
    for (const width of [0, 1, 2, 3]) {
      const padded = padDisplay('hello world', width);
      assert.equal(displayWidth(padded), width);
    }
  });
  await scenario('CJK content at boundary widths pads without raising', async () => {
    for (const width of [0, 1, 2, 3, 4, 5]) {
      const padded = padDisplay('中文文本内容超长', width);
      assert.equal(displayWidth(padded), width);
    }
  });
  await scenario('short text is padded with trailing spaces to the requested width', async () => {
    assert.equal(padDisplay('ab', 5), 'ab   ');
    assert.equal(padDisplay('', 3), '   ');
  });
});
