import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clearScreenDown, cursorTo } from 'node:readline';
import { readCodexConfig } from './codex-config.js';

export const DEFAULT_PROVIDER = 'deepseek-gateway';
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const SELECTED_ROW = '\x1b[38;5;81m';
const RESET_STYLE = '\x1b[0m';

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

function readJsonObject(file) {
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function gatewayModels(installDir) {
  return Object.keys(readJsonObject(join(installDir, 'config', 'model-aliases.json'))).sort();
}

export function createLaunchContext(options) {
  const codexHome = defaultCodexHome();
  const models = gatewayModels(options.dir);
  const codexConfig = readCodexConfig();
  const configModel = codexConfig.modelProvider === DEFAULT_PROVIDER && models.includes(codexConfig.model) ? codexConfig.model : '';
  return {
    all: options.all,
    codexHome,
    installDir: options.dir,
    models,
    projectRoot: findProjectRoot(process.cwd()),
    provider: options.provider || DEFAULT_PROVIDER,
    model: options.model || configModel || models[0] || '',
    reasoningEffort: options.reasoningEffort || codexConfig.modelReasoningEffort || 'low',
  };
}

export function missingModelMessage(context) {
  return `No gateway models found in ${join(context.installDir, 'config', 'model-aliases.json')}\n`;
}

function configOverrideArgs(context) {
  return [
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
}

function configOverrideCommandParts(context) {
  return [
    '-c',
    `model_provider=${context.provider}`,
    '-c',
    `model=${context.model}`,
    '-c',
    `model_reasoning_effort=${context.reasoningEffort}`,
    '-c',
    'model_supports_reasoning_summaries=true',
    '-c',
    'model_reasoning_summary=auto',
  ];
}

export function codexNewArgs(context) {
  return configOverrideArgs(context);
}

export function codexResumeArgs(sessionId, context) {
  return ['resume', sessionId, ...configOverrideArgs(context)];
}

export function codexNewCommand(context) {
  return ['codex', ...configOverrideCommandParts(context)].join(' ');
}

export function codexResumeCommand(sessionId, context) {
  return ['codex', 'resume', sessionId, ...configOverrideCommandParts(context)].join(' ');
}

export async function runCodex(args) {
  const child = spawn('codex', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exitCode = await new Promise((resolveChild) => {
    child.on('exit', (exitCode) => resolveChild(exitCode ?? 0));
  });
}

function rowOffset(header) {
  return header ? 4 : 2;
}

function renderRow(state, index) {
  cursorTo(process.stdout, 0, rowOffset(state.header) + index);
  const row = `${index === state.selected ? '>' : ' '} ${state.rows[index]}`;
  const styled = index === state.selected ? `${SELECTED_ROW}${row}${RESET_STYLE}` : row;
  print(`\x1b[2K${styled}`);
}

function renderPicker(state) {
  const { title, rows, selected, header } = state;
  cursorTo(process.stdout, 0, 0);
  clearScreenDown(process.stdout);
  let output = `${title}\n\n`;
  if (header) output += `  ${header}\n  ${'-'.repeat(header.length)}\n`;
  for (const [index] of rows.entries()) {
    const row = `${index === selected ? '>' : ' '} ${rows[index]}`;
    output += `${index === selected ? `${SELECTED_ROW}${row}${RESET_STYLE}` : row}\n`;
  }
  output += '\nUp/Down select  Enter confirm  Left back  Esc quit\n';
  print(output);
}

function openPickerScreen() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
}

function closePickerScreen() {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
}

export async function pick(title, rows, header = '') {
  if (!rows.length) return { action: 'back' };
  let selected = 0;
  const stdin = process.stdin;
  const state = { title, rows, selected, header };
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
      if (key === '\r' || key === '\n') return done({ action: 'select', index: selected });
      const previous = selected;
      if (key === '\u001b[A') selected = Math.max(0, selected - 1);
      else if (key === '\u001b[B') selected = Math.min(rows.length - 1, selected + 1);
      else return;
      if (selected === previous) return;
      state.selected = selected;
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
  const result = await pick('Choose gateway model', context.models);
  if (result.action === 'select') context.model = context.models[result.index];
  return result.action;
}

export async function pickReasoning(context) {
  const result = await pick(`Choose Codex reasoning effort for ${context.model}`, REASONING_EFFORTS);
  if (result.action === 'select') context.reasoningEffort = REASONING_EFFORTS[result.index];
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
  if (options.print || (!hasLaunchOverrides && !canPick)) {
    print(`${codexNewCommand(context)}\n`);
    return;
  }
  await runCodex(codexNewArgs(context));
}
