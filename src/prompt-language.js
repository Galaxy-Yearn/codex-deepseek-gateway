export const DEFAULT_PROMPT_LANGUAGE = 'en';
export const PROMPT_LANGUAGES = ['en', 'zh'];

export function normalizePromptLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return PROMPT_LANGUAGES.includes(normalized) ? normalized : DEFAULT_PROMPT_LANGUAGE;
}

export function catalogFileForPromptLanguage(language) {
  return normalizePromptLanguage(language) === 'zh'
    ? 'model-catalog.zh.json'
    : 'model-catalog.json';
}
