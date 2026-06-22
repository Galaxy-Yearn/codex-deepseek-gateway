import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  codexNewArgs,
  codexResumeArgs,
  codexResumeCommand,
  createLaunchContext,
  missingModelMessage,
  pick,
  pickModel,
  pickReasoning,
  runCodex,
  withPickerScreen,
} from './codex-launch.js';

const TIME_WIDTH = 10;
const PROVIDER_WIDTH = 17;
const ID_WIDTH = 36;
const TITLE_WIDTH = 16;
const TABLE_INDENT = '    ';
const COLUMN_GAP = '  ';
const NEW_SESSION_ROW = '[New conversation]';

function print(message = '') {
  process.stdout.write(message);
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

function isSubagentSession(meta) {
  return meta?.thread_source === 'subagent' || Boolean(meta?.parent_thread_id);
}

function timestampFromUserMessage(row) {
  const payload = row?.payload;
  if (row?.type === 'event_msg' && payload?.type === 'user_message') return row.timestamp || '';
  if (row?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') return row.timestamp || '';
  return '';
}

function readLastUserMessageTimestamp(file, chunkSize = 256 * 1024) {
  const handle = openSync(file, 'r');
  try {
    let position = statSync(file).size;
    let suffix = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      const read = readSync(handle, buffer, 0, length, position);
      let data = buffer.subarray(0, read);
      if (suffix.length) data = Buffer.concat([data, suffix]);

      let lineEnd = data.length;
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 10) continue;
        const row = parseJsonLine(data.subarray(index + 1, lineEnd).toString('utf8').trim());
        const timestamp = timestampFromUserMessage(row);
        if (timestamp) return timestamp;
        lineEnd = index;
      }
      suffix = data.subarray(0, lineEnd);
    }

    const row = parseJsonLine(suffix.toString('utf8').trim());
    return timestampFromUserMessage(row);
  } finally {
    closeSync(handle);
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

function isInsideProject(cwd, projectRoot) {
  if (!cwd) return false;
  const sessionCwd = normalizePath(cwd);
  const root = normalizePath(projectRoot);
  return sessionCwd === root || sessionCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`);
}

export function readSession(file, indexById) {
  const lines = readStart(file).split(/\r?\n/).filter(Boolean);
  const meta = parseJsonLine(lines[0])?.payload;
  if (!meta?.id) return null;
  if (isSubagentSession(meta)) return null;
  const index = indexById.get(meta.id) || {};
  return {
    id: meta.id,
    provider: meta.model_provider || '',
    cwd: meta.cwd || '',
    updatedAt: readLastUserMessageTimestamp(file) || index.updated_at || meta.timestamp || '',
    title: index.thread_name || firstUserPreview(lines) || '(untitled)',
  };
}

function resolveSessionSelection(selection, sessionsList) {
  if (/^\d+$/.test(selection)) {
    const byIndex = sessionsList[Number(selection) - 1];
    if (byIndex) return byIndex;
  }
  const matches = sessionsList.filter((session) => session.id.startsWith(selection));
  return matches.length === 1 ? matches[0] : null;
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
  print(`${TABLE_INDENT}${'-'.repeat(sessionHeader().length)}\n`);
  listed.forEach((session, index) => {
    print(`${String(index + 1).padStart(2, ' ')}  ${sessionRow(session)}\n`);
    if (options.all) print(`    cwd: ${session.cwd || '(unknown cwd)'}\n`);
    print(`    resume: ${codexResumeCommand(session.id, context)}\n\n`);
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

async function chooseSessionFlow(allSessions, context, limit) {
  if (!context.models.length) {
    print(missingModelMessage(context));
    return null;
  }

  const listed = allSessions.slice(0, limit);
  const header = sessionHeader();
  return await withPickerScreen(async () => {
    let step = 'session';
    while (true) {
      if (step === 'session') {
        const rows = [NEW_SESSION_ROW, ...sessionRows(listed)];
        const result = await pick(`Choose Codex session`, rows, header);
        if (result.action === 'cancel') return null;
        if (result.action === 'back') return null;
        context.selectedSession = result.index === 0 ? { newConversation: true } : listed[result.index - 1];
        step = 'model';
      } else if (step === 'model') {
        const action = await pickModel(context);
        if (action !== 'select') return null;
        step = 'reasoning';
      } else if (step === 'reasoning') {
        const action = await pickReasoning(context);
        if (action === 'cancel') return null;
        if (action === 'back') step = 'model';
        else return context.selectedSession;
      }
    }
  });
}

export async function sessions(options) {
  const context = createLaunchContext(options);
  const sessionsDir = join(context.codexHome, 'sessions');
  const indexById = readSessionIndex(context.codexHome);
  const seen = new Map();

  for (const file of walkJsonl(sessionsDir)) {
    const session = readSession(file, indexById);
    if (!session || (!options.all && !isInsideProject(session.cwd, context.projectRoot))) continue;
    const prior = seen.get(session.id);
    if (!prior || session.updatedAt > prior.updatedAt) seen.set(session.id, session);
  }

  const allSessions = [...seen.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (options.exec) {
    const session = resolveSessionSelection(options.exec, allSessions);
    if (!session) throw new Error(`Session not found or ambiguous: ${options.exec}`);
    await runCodex(codexResumeArgs(session.id, context));
    return;
  }

  if (options.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    printSessions(allSessions, options, context);
    return;
  }

  const selected = await chooseSessionFlow(allSessions, context, options.limit || 20);
  if (selected?.newConversation) await runCodex(codexNewArgs(context));
  else if (selected) await runCodex(codexResumeArgs(selected.id, context));
}
