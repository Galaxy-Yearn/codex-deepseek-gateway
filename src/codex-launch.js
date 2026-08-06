import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clearScreenDown, cursorTo } from 'node:readline';
import { readCodexConfig } from './codex-config.js';
import { readLocalConfigFile } from './local-config.js';
import { modelCatalogEntries, readModelCatalog } from './model-catalog.js';
import { catalogFileForPromptLanguage, normalizePromptLanguage } from './prompt-language.js';
import { displayWidth, padDisplay, truncateDisplay } from './terminal-text.js';

export const DEFAULT_PROVIDER = 'deepseek-gateway';
export const REASONING_EFFORTS = ['low', 'high', 'max'];
const SELECTED_ROW = '\x1b[38;2;57;100;254m';
const MUTED_TEXT = '\x1b[90m';
const RESET_STYLE = '\x1b[0m';
const PICKER_COPY = {
  en: {
    browse: 'browse',
    back: 'back',
    confirm: 'confirm',
    quit: 'quit',
    modelTitle: 'Choose gateway model',
    reasoningTitle: (model) => `Choose DeepSeek reasoning level for ${model}`,
    sessionTitle: 'Choose Codex session',
    noSessions: 'No matching sessions found.',
    newSession: 'new',
    sessionColumns: ['Date', 'Provider', 'Title'],
    showing: (first, last, total) => `Showing ${first}-${last} of ${total}`,
    unknownProvider: '(unknown)',
    missingModel: (catalogPath) => `No gateway models found in ${catalogPath}\n`,
  },
  zh: {
    browse: '选择',
    back: '返回',
    confirm: '确认',
    quit: '退出',
    modelTitle: '选择网关模型',
    reasoningTitle: (model) => `为 ${model} 选择 DeepSeek 推理强度`,
    sessionTitle: '选择 Codex 会话',
    noSessions: '没有匹配的会话。',
    newSession: '新建',
    sessionColumns: ['日期', '提供方', '标题'],
    showing: (first, last, total) => `显示 ${first}-${last}，共 ${total} 项`,
    unknownProvider: '(未知)',
    missingModel: (catalogPath) => `在 ${catalogPath} 未找到网关模型\n`,
  },
};
const require = createRequire(import.meta.url);
const CODEX_PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function print(message = '') {
  process.stdout.write(message);
}

export function defaultCodexHome() {
  return process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.codex');
}

export function findProjectRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function readPromptLanguage(installDir) {
  const configFile = join(installDir, 'config', 'gateway.local.json');
  const localConfig = readLocalConfigFile(configFile);
  return normalizePromptLanguage(localConfig.CODEX_PROMPT_LANGUAGE);
}

function readPickerCatalog(file) {
  const catalog = readModelCatalog(file);
  const models = [];
  const modelDescriptions = {};
  const defaultReasoningEfforts = {};
  const reasoningDescriptions = {};
  const reasoningEfforts = {};
  for (const model of modelCatalogEntries(catalog)) {
    const slug = model.slug;
    models.push(slug);
    modelDescriptions[slug] = String(model.description || '').trim();
    const levels = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
      .map((level) => [String(level?.effort || '').trim(), String(level?.description || '').trim()])
      .filter(([effort]) => effort);
    reasoningDescriptions[slug] = Object.fromEntries(levels);
    reasoningEfforts[slug] = levels.map(([effort]) => effort);
    const defaultEffort = String(model.default_reasoning_level || '').trim();
    if (defaultEffort) defaultReasoningEfforts[slug] = defaultEffort;
  }
  return { defaultReasoningEfforts, modelDescriptions, models: models.sort(), reasoningDescriptions, reasoningEfforts };
}

function reasoningEffortsForModel(context) {
  const efforts = context.reasoningEfforts?.[context.model];
  return Array.isArray(efforts) && efforts.length ? efforts : REASONING_EFFORTS;
}

export function pickerCopy(language) {
  return PICKER_COPY[normalizePromptLanguage(language)];
}

export function createLaunchContext(options) {
  const codexHome = defaultCodexHome();
  const codexConfig = readCodexConfig();
  const promptLanguage = readPromptLanguage(options.dir);
  const modelCatalogPath = join(options.dir, 'config', catalogFileForPromptLanguage(promptLanguage));
  const pickerCatalog = readPickerCatalog(modelCatalogPath);
  const models = pickerCatalog.models;
  const provider = options.provider || DEFAULT_PROVIDER;
  const configModel = codexConfig.modelProvider === DEFAULT_PROVIDER && models.includes(codexConfig.model) ? codexConfig.model : '';
  const configReasoningEffort = codexConfig.modelProvider === provider ? codexConfig.modelReasoningEffort : '';
  const model = options.model || configModel || models[0] || '';
  return {
    all: options.all,
    codexHome,
    installDir: options.dir,
    modelCatalogPath,
    modelDescriptions: pickerCatalog.modelDescriptions,
    defaultReasoningEfforts: pickerCatalog.defaultReasoningEfforts,
    models,
    promptLanguage,
    projectRoot: findProjectRoot(process.cwd()),
    provider,
    reasoningDescriptions: pickerCatalog.reasoningDescriptions,
    reasoningEfforts: pickerCatalog.reasoningEfforts,
    model,
    reasoningEffort: options.reasoningEffort || configReasoningEffort || pickerCatalog.defaultReasoningEfforts[model] || 'high',
  };
}

export function missingModelMessage(context) {
  return pickerCopy(context.promptLanguage).missingModel(context.modelCatalogPath);
}

function configOverrideArgs(context) {
  const reasoningEfforts = reasoningEffortsForModel(context);
  if (context.provider === DEFAULT_PROVIDER && !reasoningEfforts.includes(context.reasoningEffort)) {
    throw new Error(
      `Unsupported DeepSeek reasoning effort ${JSON.stringify(context.reasoningEffort)}. Expected one of: ${reasoningEfforts.join(', ')}`,
    );
  }
  const args = [
    '-c',
    `model_provider=${JSON.stringify(context.provider)}`,
    '-c',
    `model=${JSON.stringify(context.model)}`,
    '-c',
    `model_reasoning_effort=${JSON.stringify(context.reasoningEffort)}`,
    '-c',
    'model_supports_reasoning_summaries=true',
    '-c',
    'model_reasoning_summary="auto"',
  ];
  if (context.provider === DEFAULT_PROVIDER && context.modelCatalogPath) {
    args.push('-c', `model_catalog_json=${JSON.stringify(context.modelCatalogPath)}`);
  }
  return args;
}

export function codexNewArgs(context) {
  return configOverrideArgs(context);
}

export function codexResumeArgs(sessionId, context) {
  return ['resume', sessionId, ...configOverrideArgs(context)];
}

function quoteShellArg(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function codexResumeCommand(sessionId, context) {
  return ['codex', ...codexResumeArgs(sessionId, context)].map(quoteShellArg).join(' ');
}

function codexTargetTriple(platform = process.platform, arch = process.arch) {
  if ((platform === 'linux' || platform === 'android') && arch === 'x64') return 'x86_64-unknown-linux-musl';
  if ((platform === 'linux' || platform === 'android') && arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  return '';
}

function pathEntries(env = process.env) {
  const pathValue = env.PATH || env.Path || env.path || '';
  return pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

function candidateExecutables(command, env = process.env) {
  if (command.includes('/') || command.includes('\\')) return [command];
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const names = process.platform === 'win32'
    ? extensions.map((extension) => `${command}${extension.toLowerCase()}`)
    : [command];
  return pathEntries(env).flatMap((entry) => names.map((name) => join(entry, name)));
}

function npmShimCodexPackageRoot(shimPath) {
  const base = dirname(shimPath);
  const packageRoot = join(base, 'node_modules', '@openai', 'codex');
  return existsSync(join(packageRoot, 'package.json')) ? packageRoot : '';
}

function ancestorCodexPackageRoot(filePath) {
  try {
    let current = dirname(realpathSync(filePath));
    while (true) {
      const packageJson = join(current, 'package.json');
      if (existsSync(packageJson)) {
        try {
          const parsed = JSON.parse(readFileSync(packageJson, 'utf8'));
          if (parsed?.name === '@openai/codex') return current;
        } catch {
        }
      }
      const parent = dirname(current);
      if (parent === current) return '';
      current = parent;
    }
  } catch {
    return '';
  }
}

function codexPackageRoot() {
  try {
    return dirname(require.resolve('@openai/codex/package.json'));
  } catch {
    for (const candidate of candidateExecutables('codex')) {
      const packageRoot = npmShimCodexPackageRoot(candidate) || ancestorCodexPackageRoot(candidate);
      if (packageRoot) return packageRoot;
    }
    return '';
  }
}

function codexPlatformPackageJson(packageRoot, platformPackage) {
  try {
    return createRequire(join(packageRoot, 'package.json')).resolve(`${platformPackage}/package.json`);
  } catch {
    const nested = join(packageRoot, 'node_modules', platformPackage, 'package.json');
    return existsSync(nested) ? nested : '';
  }
}

export function resolveCodexExecutable() {
  const packageRoot = codexPackageRoot();
  const targetTriple = codexTargetTriple();
  const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (packageRoot && targetTriple && platformPackage) {
    const packageJson = codexPlatformPackageJson(packageRoot, platformPackage);
    if (existsSync(packageJson)) {
      const executable = join(
        dirname(packageJson),
        'vendor',
        targetTriple,
        'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
      );
      if (existsSync(executable)) return executable;
    }
    const bundledExecutable = join(
      packageRoot,
      'vendor',
      targetTriple,
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
    if (existsSync(bundledExecutable)) return bundledExecutable;
  }

  for (const candidate of candidateExecutables('codex')) {
    if (existsSync(candidate) && !candidate.endsWith('.cmd') && !candidate.endsWith('.bat') && !candidate.endsWith('.ps1')) {
      return candidate;
    }
  }
  return 'codex';
}

export function codexProcessEnv() {
  const packageRoot = codexPackageRoot();
  if (!packageRoot) return process.env;
  return {
    ...process.env,
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_MANAGED_PACKAGE_ROOT: realpathSync(packageRoot),
  };
}

export async function runCodex(args) {
  const child = spawn(resolveCodexExecutable(), args, {
    stdio: 'inherit',
    shell: false,
    env: codexProcessEnv(),
  });
  process.exitCode = await new Promise((resolveChild) => {
    child.on('error', (error) => {
      process.stderr.write(`Failed to launch codex: ${error.message}\n`);
      resolveChild(1);
    });
    child.on('exit', (exitCode) => resolveChild(exitCode ?? 0));
  });
}

function rowOffset(header) {
  return header ? 4 : 2;
}

export function pickerWindow(rows, selected, windowSize, currentOffset = 0) {
  const allRows = Array.isArray(rows) ? rows : [];
  const size = Math.max(1, Math.trunc(Number(windowSize) || allRows.length || 1));
  const clampedSelected = Math.min(Math.max(0, selected), Math.max(0, allRows.length - 1));
  const maxOffset = Math.max(0, allRows.length - size);
  let offset = Math.min(Math.max(0, Math.trunc(Number(currentOffset) || 0)), maxOffset);
  if (clampedSelected < offset) {
    offset = clampedSelected;
  } else if (clampedSelected >= offset + size) {
    offset = clampedSelected - size + 1;
  }
  return {
    offset,
    rows: allRows.slice(offset, offset + size),
  };
}

function pickerControl(key, label) {
  const control = String(key || '').trim();
  const description = String(label || '').trim();
  if (!control) return '';
  return description ? `${control} ${MUTED_TEXT}${description}${RESET_STYLE}` : control;
}

function pickerControls(shortcuts = [], language = 'en') {
  const copy = pickerCopy(language);
  const labels = shortcuts
    .map((shortcut) => pickerControl(shortcut.displayKey || shortcut.key, shortcut.label))
    .filter(Boolean);
  return [
    ...labels,
    pickerControl('↑/↓', copy.browse),
    pickerControl('←', copy.back),
    pickerControl('Enter', copy.confirm),
    pickerControl('Esc', copy.quit),
  ].join('    ');
}

function terminalWidth() {
  return process.stdout.columns || 80;
}

export function pickerChoiceRows(choices, descriptions = {}, width = terminalWidth()) {
  const values = choices.map((choice) => String(choice));
  const nameWidth = Math.max(0, ...values.map(displayWidth));
  const budget = Math.max(0, width - 2);
  const nameColumnWidth = Math.min(nameWidth, budget);
  const descriptionWidth = budget - nameColumnWidth - 2;
  return values.map((value) => {
    const description = String(descriptions[value] || '').trim();
    if (!description || descriptionWidth < 4) return truncateDisplay(value, budget);
    const name = padDisplay(value, nameColumnWidth);
    const truncatedDescription = truncateDisplay(description, descriptionWidth);
    return `${name}  ${MUTED_TEXT}${truncatedDescription}${RESET_STYLE}`;
  });
}

function selectedPickerRow(row) {
  return String(row).replace(/\x1b\[[0-9;]*m/g, '');
}

function renderRow(state, absoluteIndex) {
  if (absoluteIndex < state.offset || absoluteIndex >= state.offset + state.visibleRows.length) return;
  const visibleIndex = absoluteIndex - state.offset;
  cursorTo(process.stdout, 0, rowOffset(state.header) + visibleIndex);
  const isSelected = absoluteIndex === state.selected;
  const rowText = isSelected ? selectedPickerRow(state.rows[absoluteIndex]) : state.rows[absoluteIndex];
  const row = `${isSelected ? '>' : ' '} ${rowText}`;
  const styled = isSelected ? `${SELECTED_ROW}${row}${RESET_STYLE}` : row;
  print(`\x1b[2K${styled}`);
}

function pickerLines(state) {
  const { title, rows, selected, header, emptyMessage, shortcuts, language } = state;
  const copy = pickerCopy(language);
  const window = pickerWindow(rows, selected, state.windowSize, state.offset);
  state.offset = window.offset;
  state.visibleRows = window.rows;
  const lines = [title, ''];
  if (header) lines.push(`  ${header}`, `  ${MUTED_TEXT}${'─'.repeat(displayWidth(header))}${RESET_STYLE}`);
  for (const [visibleIndex, rowText] of state.visibleRows.entries()) {
    const absoluteIndex = state.offset + visibleIndex;
    const isSelected = absoluteIndex === selected;
    const visibleText = isSelected ? selectedPickerRow(rowText) : rowText;
    const row = `${isSelected ? '>' : ' '} ${visibleText}`;
    lines.push(isSelected ? `${SELECTED_ROW}${row}${RESET_STYLE}` : row);
  }
  if (!rows.length && emptyMessage) lines.push(`  ${emptyMessage}`);
  if (rows.length > state.visibleRows.length) {
    lines.push('', `  ${copy.showing(state.offset + 1, state.offset + state.visibleRows.length, rows.length)}`);
  }
  lines.push('', `  ${pickerControls(shortcuts, language)}`);
  return lines;
}

function renderPicker(state, { clear = true } = {}) {
  const lines = pickerLines(state);
  cursorTo(process.stdout, 0, 0);
  if (clear) {
    clearScreenDown(process.stdout);
    print(`${lines.join('\n')}\n`);
    state.renderedLineCount = lines.length;
    return;
  }
  for (const line of lines) {
    print(`\x1b[2K${line}\n`);
  }
  for (let index = lines.length; index < (state.renderedLineCount || 0); index += 1) {
    print('\x1b[2K\n');
  }
  state.renderedLineCount = lines.length;
}

function openPickerScreen() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
}

function closePickerScreen() {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
}

export async function pick(title, rows, header = '', options = {}) {
  const shortcuts = Array.isArray(options.shortcuts) ? options.shortcuts : [];
  if (!rows.length && !shortcuts.length) return { action: 'back' };
  let selected = 0;
  const stdin = process.stdin;
  const state = {
    title,
    rows,
    selected,
    header,
    shortcuts,
    windowSize: options.windowSize,
    emptyMessage: options.emptyMessage,
    language: normalizePromptLanguage(options.language),
    offset: 0,
    visibleRows: [],
    renderedLineCount: 0,
  };
  renderPicker(state);

  return await new Promise((resolvePick) => {
    const done = (result) => {
      stdin.off('data', onData);
      resolvePick(result);
    };
    const onData = (chunk) => {
      const key = chunk.toString('utf8');
      if (key === '\u0003' || key === '\u001b') return done({ action: 'cancel' });
      if (key === '\u001b[D') return done({ action: 'back' });
      for (const shortcut of shortcuts) {
        if (key.toLowerCase() === String(shortcut.key || '').toLowerCase()) {
          return done({ action: shortcut.action || shortcut.key });
        }
      }
      if ((key === '\r' || key === '\n') && rows.length) return done({ action: 'select', index: selected });
      if (!rows.length) return;
      const previous = selected;
      const previousOffset = state.offset;
      if (key === '\u001b[A') selected = Math.max(0, selected - 1);
      else if (key === '\u001b[B') selected = Math.min(rows.length - 1, selected + 1);
      else return;
      if (selected === previous) return;
      state.selected = selected;
      const nextWindow = pickerWindow(rows, selected, state.windowSize, state.offset);
      if (nextWindow.offset !== previousOffset) {
        renderPicker(state, { clear: false });
        return;
      }
      renderRow(state, previous);
      renderRow(state, selected);
    };
    stdin.on('data', onData);
  });
}

export async function withPickerScreen(callback) {
  const stdin = process.stdin;
  stdin.resume();
  stdin.setRawMode(true);
  openPickerScreen();
  try {
    return await callback();
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    closePickerScreen();
  }
}

export async function pickModel(context) {
  const copy = pickerCopy(context.promptLanguage);
  const rows = pickerChoiceRows(context.models, context.modelDescriptions, terminalWidth());
  const result = await pick(copy.modelTitle, rows, '', { language: context.promptLanguage });
  if (result.action === 'select') {
    context.model = context.models[result.index];
    const reasoningEfforts = reasoningEffortsForModel(context);
    if (!reasoningEfforts.includes(context.reasoningEffort)) {
      context.reasoningEffort = context.defaultReasoningEfforts?.[context.model] || reasoningEfforts[0];
    }
  }
  return result.action;
}

export async function pickReasoning(context) {
  const copy = pickerCopy(context.promptLanguage);
  const descriptions = context.reasoningDescriptions?.[context.model];
  const reasoningEfforts = reasoningEffortsForModel(context);
  const rows = pickerChoiceRows(reasoningEfforts, descriptions, terminalWidth());
  const result = await pick(copy.reasoningTitle(context.model), rows, '', { language: context.promptLanguage });
  if (result.action === 'select') context.reasoningEffort = reasoningEfforts[result.index];
  return result.action;
}

export async function chooseLaunchContext(context) {
  return await withPickerScreen(async () => {
    let step = 'model';
    while (true) {
      if (step === 'model') {
        const action = await pickModel(context);
        if (action !== 'select') return false;
        step = 'reasoning';
      } else {
        const action = await pickReasoning(context);
        if (action === 'cancel') return false;
        if (action === 'back') step = 'model';
        else return true;
      }
    }
  });
}

export async function newConversation(options) {
  if (options.print) throw new Error('--print is only supported with sessions');
  const context = createLaunchContext(options);
  if (!context.model) {
    print(missingModelMessage(context));
    return;
  }
  const canPick = process.stdin.isTTY && process.stdout.isTTY;
  const hasLaunchOverrides = options.provider || options.model || options.reasoningEffort;
  if (!hasLaunchOverrides && !options.print && canPick) {
    const selected = await chooseLaunchContext(context);
    if (!selected) return;
  }
  await runCodex(codexNewArgs(context));
}
