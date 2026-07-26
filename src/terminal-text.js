const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MARK = /\p{Mark}/u;

function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(grapheme) {
  const characters = [...grapheme];
  const visible = characters.filter((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== 0x200d && codePoint !== 0xfe0e && codePoint !== 0xfe0f && !MARK.test(character);
  });
  if (!visible.length) return 0;
  return characters.some((character) => isWideCodePoint(character.codePointAt(0)) || EXTENDED_PICTOGRAPHIC.test(character)) ? 2 : 1;
}

export function displayWidth(text) {
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(String(text))) width += graphemeWidth(segment);
  return width;
}

export function truncateDisplay(text, max) {
  const value = String(text);
  if (max <= 0) return '';
  if (displayWidth(value) <= max) return value;
  if (max < 3) return '.'.repeat(max);
  const contentWidth = max - 3;
  let result = '';
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const nextWidth = graphemeWidth(segment);
    if (width + nextWidth > contentWidth) break;
    result += segment;
    width += nextWidth;
  }
  return `${result}...`;
}

export function padDisplay(text, width) {
  const value = truncateDisplay(String(text || ''), width);
  return `${value}${' '.repeat(width - displayWidth(value))}`;
}
