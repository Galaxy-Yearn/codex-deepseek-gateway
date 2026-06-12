import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clearLine, clearScreenDown, cursorTo } from 'node:readline';
import { readCodexConfig } from './codex-config.js';

const DEFAULT_PROVIDER = 'deepseek-gateway';
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const TIME_WIDTH = 10;
const PROVIDER_WIDTH = 18;
const ID_WIDTH = 36;
const TITLE_WIDTH = 16;
const TABLE_INDENT = '    ';
const COLUMN_GAP = '    ';

function print(message = '') {
  process.stdout.write(message);
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.codex');
}

function readStart(file, bytes = 256 * 1024) {
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(handle, buffer, 0, bytes, 0)).toString('utf8');
  } finally {
    closeSync(handle);
  }
}

function walkJsonl(dir, result = []) {
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(path, result);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
  }
  return result;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readSessionIndex(codexHome) {
  const file = join(codexHome, 'session_index.jsonl');
  const byId = new Map();
  if (!existsSync(file)) return byId;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseJsonLine(line);
    if (!row?.id) continue;
    const prior = byId.get(row.id);
    if (!prior || String(row.updated_at || '') > String(prior.updated_at || '')) byId.set(row.id, row);
  }
  return byId;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => part?.text || '')
    .filter(Boolean)
    .join(' ');
}

function firstUserPreview(lines) {
  for (const line of lines.slice(1, 180)) {
    const payload = parseJsonLine(line)?.payload;
    if (payload?.type !== 'message' || payload.role !== 'user') continue;
    const text = textFromContent(payload.content).trim().replace(/\s+/g, ' ');
    if (!text || text.startsWith('<environment_context>') || text.startsWith('# AGENTS.md instructions')) continue;
    return truncate(text, TITLE_WIDTH);
  }
  return '';
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function pad(text, width) {
  return truncate(String(text || ''), width).padEnd(width, ' ');
}

function formatTime(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function normalizePath(path) {
  const resolved = resolve(path || '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function findProjectRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function isInsideProject(cwd, projectRoot) {
  if (!cwd) return false;
  const sessionCwd = normalizePath(cwd);
  const root = normalizePath(projectRoot);
  return sessionCwd === root || sessionCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`);
}

function readSession(file, indexById) {
  const lines = readStart(file).split(/\r?\n/).filter(Boolean);
  const meta = parseJsonLine(lines[0])?.payload;
  if (!meta?.id) return null;
  const index = indexById.get(meta.id) || {};
  return {
    id: meta.id,
    provider: meta.model_provider || '',
    cwd: meta.cwd || '',
    updatedAt: index.updated_at || meta.timestamp || '',
    title: index.thread_name || firstUserPreview(lines) || '(untitled)',
  };
}

function shellQuoteTomlString(key, value) {
  return `-c ${key}=${value}`;
}

function resumeCommand(sessionId, context) {
  return [
    'codex',
    'resume',
    sessionId,
    shellQuoteTomlString('model_provider', context.provider),
    shellQuoteTomlString('model', context.model),
    shellQuoteTomlString('model_reasoning_effort', context.reasoningEffort),
  ].join(' ');
}

function readJsonObject(file) {
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function gatewayModels(installDir) {
  return Object.keys(readJsonObject(join(installDir, 'config', 'model-aliases.json'))).sort();
}

function resolveSessionSelection(selection, sessionsList) {
  if (/^\d+$/.test(selection)) {
    const byIndex = sessionsList[Number(selection) - 1];
    if (byIndex) return byIndex;
  }
  const matches = sessionsList.filter((session) => session.id.startsWith(selection));
  return matches.length === 1 ? matches[0] : null;
}

function resumeArgs(session, context) {
  return [
    'resume',
    session.id,
    '-c',
    `model_provider=${JSON.stringify(context.provider)}`,
    '-c',
    `model=${JSON.stringify(context.model)}`,
    '-c',
    `model_reasoning_effort=${JSON.stringify(context.reasoningEffort)}`,
  ];
}

async function runCodexResume(session, context) {
  const child = spawn('codex', resumeArgs(session, context), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exitCode = await new Promise((resolveChild) => {
    child.on('exit', (exitCode) => resolveChild(exitCode ?? 0));
  });
}

function printSessions(sessionsList, options, context) {
  const listed = sessionsList.slice(0, options.limit || 20);
  print(`Codex sessions ${options.all ? `under ${context.codexHome}` : `for project ${context.projectRoot}`}\n`);
  print(`Target: ${context.provider} / ${context.model} / ${context.reasoningEffort}\n\n`);
  if (!listed.length) {
    print('No matching sessions found.\n');
    return;
  }
  print(`${TABLE_INDENT}${sessionHeader()}\n`);
  print(`${TABLE_INDENT}${'-'.repeat(TIME_WIDTH)}${COLUMN_GAP}${'-'.repeat(PROVIDER_WIDTH)}${COLUMN_GAP}${'-'.repeat(ID_WIDTH)}${COLUMN_GAP}${'-'.repeat(TITLE_WIDTH)}\n`);
  listed.forEach((session, index) => {
    print(`${String(index + 1).padStart(2, ' ')}  ${sessionRow(session)}\n`);
    if (options.all) print(`    cwd: ${session.cwd || '(unknown cwd)'}\n`);
    print(`    resume: ${resumeCommand(session.id, context)}\n\n`);
  });
  if (sessionsList.length > listed.length) print(`Showing ${listed.length} of ${sessionsList.length}. Use --limit ${sessionsList.length} or --all as needed.\n`);
}

function sessionHeader() {
  return `${pad('Date', TIME_WIDTH)}${COLUMN_GAP}${pad('Provider', PROVIDER_WIDTH)}${COLUMN_GAP}${pad('Session ID', ID_WIDTH)}${COLUMN_GAP}Title`;
}

function sessionRow(session) {
  return `${pad(formatTime(session.updatedAt), TIME_WIDTH)}${COLUMN_GAP}${pad(session.provider || '(unknown)', PROVIDER_WIDTH)}${COLUMN_GAP}${session.id}${COLUMN_GAP}${truncate(session.title, TITLE_WIDTH)}`;
}

function sessionRows(sessionsList) {
  return sessionsList.map((session) => sessionRow(session));
}

function rowOffset(header) {
  return header ? 4 : 2;
}

function renderRow(state, index) {
  cursorTo(process.stdout, 0, rowOffset(state.header) + index);
  clearLine(process.stdout, 0);
  print(`${index === state.selected ? '>' : ' '} ${state.rows[index]}`);
}

function renderPicker(state) {
  const { title, rows, selected, header } = state;
  cursorTo(process.stdout, 0, 0);
  clearScreenDown(process.stdout);
  let output = `${title}\n\n`;
  if (header) output += `  ${header}\n  ${'-'.repeat(header.length)}\n`;
  for (const [index, row] of rows.entries()) output += `${index === selected ? '>' : ' '} ${row}\n`;
  output += '\n↑/↓ select  Enter confirm  ← back  Esc quit\n';
  print(output);
}

function openPickerScreen() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
}

function closePickerScreen() {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
}

async function pick(title, rows, header = '') {
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

async function chooseSessionFlow(allSessions, context, limit) {
  const models = gatewayModels(context.installDir);
  const listed = allSessions.slice(0, limit);
  const header = sessionHeader();
  if (!listed.length) {
    print('No matching sessions found.\n');
    return null;
  }
  if (!models.length) {
    print(`No gateway models found in ${join(context.installDir, 'config', 'model-aliases.json')}\n`);
    return null;
  }

  const stdin = process.stdin;
  stdin.resume();
  stdin.setRawMode(true);
  openPickerScreen();
  try {
    let step = 'model';
    while (true) {
      if (step === 'model') {
        const result = await pick('Choose gateway model', models);
        if (result.action !== 'select') return null;
        context.model = models[result.index];
        step = 'reasoning';
      } else if (step === 'reasoning') {
        const result = await pick(`Choose Codex reasoning effort for ${context.model}`, REASONING_EFFORTS);
        if (result.action === 'cancel') return null;
        if (result.action === 'back') step = 'model';
        else {
          context.reasoningEffort = REASONING_EFFORTS[result.index];
          step = 'session';
        }
      } else {
        const result = await pick(`Choose Codex session for ${context.provider} / ${context.model} / ${context.reasoningEffort}`, sessionRows(listed), header);
        if (result.action === 'cancel') return null;
        if (result.action === 'back') step = 'reasoning';
        else return listed[result.index];
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    closePickerScreen();
  }
}

export async function sessions(options) {
  const codexHome = defaultCodexHome();
  const sessionsDir = join(codexHome, 'sessions');
  const indexById = readSessionIndex(codexHome);
  const projectRoot = findProjectRoot(process.cwd());
  const codexConfig = readCodexConfig();
  const models = gatewayModels(options.dir);
  const configModel = codexConfig.modelProvider === DEFAULT_PROVIDER && models.includes(codexConfig.model) ? codexConfig.model : '';
  const context = {
    all: options.all,
    codexHome,
    installDir: options.dir,
    projectRoot,
    provider: options.provider || DEFAULT_PROVIDER,
    model: options.model || configModel || models[0] || '',
    reasoningEffort: options.reasoningEffort || codexConfig.modelReasoningEffort || 'low',
  };
  const seen = new Map();

  for (const file of walkJsonl(sessionsDir)) {
    const session = readSession(file, indexById);
    if (!session || (!options.all && !isInsideProject(session.cwd, projectRoot))) continue;
    const prior = seen.get(session.id);
    if (!prior || session.updatedAt > prior.updatedAt) seen.set(session.id, session);
  }

  const allSessions = [...seen.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (options.exec) {
    const session = resolveSessionSelection(options.exec, allSessions);
    if (!session) throw new Error(`Session not found or ambiguous: ${options.exec}`);
    await runCodexResume(session, context);
    return;
  }

  if (options.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    printSessions(allSessions, options, context);
    return;
  }

  const session = await chooseSessionFlow(allSessions, context, options.limit || 20);
  if (session) await runCodexResume(session, context);
}
