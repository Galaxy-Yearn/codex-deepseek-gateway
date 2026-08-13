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
  pickerCopy,
  pickModel,
  pickReasoning,
  runCodex,
  withPickerScreen,
} from './codex-launch.js';
import { displayWidth, padDisplay, truncateDisplay } from './terminal-text.js';

const TIME_WIDTH = 11;
const PROVIDER_WIDTH = 17;
const TITLE_WIDTH = 32;
const TABLE_INDENT = '    ';
const COLUMN_GAP = '  ';
const MUTED_TEXT = '\x1b[90m';
const RESET_STYLE = '\x1b[0m';
export const DEFAULT_SESSION_LIMIT = 15;

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

function userPreviewFromRow(row) {
  const payload = row?.payload;
  let text = '';
  if (row?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
    text = textFromContent(payload.content);
  } else if (row?.type === 'event_msg' && payload?.type === 'user_message') {
    text = payload.message || '';
  } else if (row?.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') {
    text = textFromContent(payload.item.content);
  }
  text = String(text)
    .replace(/<image\b[^>]*>/giu, '')
    .replace(/<\/image>/giu, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text || text.startsWith('<environment_context>') || text.startsWith('# AGENTS.md instructions')) return '';
  return truncateDisplay(text, TITLE_WIDTH);
}

function firstUserPreview(file, chunkSize = 256 * 1024, maxLineBytes = 512 * 1024) {
  const handle = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    let position = 0;
    let prefix = Buffer.alloc(0);
    let skipLine = false;
    while (position < size) {
      const buffer = Buffer.alloc(Math.min(chunkSize, size - position));
      const length = readSync(handle, buffer, 0, buffer.length, position);
      position += length;
      let start = 0;
      for (let index = 0; index < length; index += 1) {
        if (buffer[index] !== 10) continue;
        if (!skipLine) {
          const line = Buffer.concat([prefix, buffer.subarray(start, index)]).toString('utf8').trim();
          const preview = userPreviewFromRow(parseJsonLine(line));
          if (preview) return preview;
        }
        prefix = Buffer.alloc(0);
        skipLine = false;
        start = index + 1;
      }
      const suffix = buffer.subarray(start, length);
      if (skipLine) continue;
      if (prefix.length + suffix.length > maxLineBytes) {
        prefix = Buffer.alloc(0);
        skipLine = true;
      } else {
        prefix = prefix.length ? Buffer.concat([prefix, suffix]) : Buffer.from(suffix);
      }
    }
    return skipLine ? '' : userPreviewFromRow(parseJsonLine(prefix.toString('utf8').trim()));
  } finally {
    closeSync(handle);
  }
}

function meaningfulThreadName(value) {
  const title = String(value || '').trim();
  return title && !/^[（(]?untitled[)）]?$/iu.test(title) ? title : '';
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
    title: meaningfulThreadName(index.thread_name) || firstUserPreview(file) || '(untitled)',
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
  const listed = sessionsList.slice(0, options.limit || DEFAULT_SESSION_LIMIT);
  print(`Codex sessions ${options.all ? `under ${context.codexHome}` : `for project ${context.projectRoot}`}\n`);
  print(`Target: ${context.provider} / ${context.model} / ${context.reasoningEffort}\n\n`);
  if (!listed.length) {
    print('  No matching sessions found.\n');
    return;
  }
  const header = sessionHeader();
  const divider = '─'.repeat(displayWidth(header));
  const styledDivider = process.stdout.isTTY ? `${MUTED_TEXT}${divider}${RESET_STYLE}` : divider;
  print(`${TABLE_INDENT}${header}\n`);
  print(`${TABLE_INDENT}${styledDivider}\n`);
  listed.forEach((session, index) => {
    print(`${String(index + 1).padStart(2, ' ')}  ${sessionRow(session)}\n`);
    if (options.all) print(`    cwd: ${session.cwd || '(unknown cwd)'}\n`);
    print(`    resume: ${codexResumeCommand(session.id, context)}\n\n`);
  });
  if (sessionsList.length > listed.length) print(`Showing ${listed.length} of ${sessionsList.length}. Use --limit ${sessionsList.length} or --all as needed.\n`);
}

function sessionHeader(language = 'en') {
  const [date, provider, title] = pickerCopy(language).sessionColumns;
  return `${padDisplay(date, TIME_WIDTH)}${COLUMN_GAP}${padDisplay(provider, PROVIDER_WIDTH)}${COLUMN_GAP}${padDisplay(title, TITLE_WIDTH)}`;
}

function sessionRow(session, language = 'en') {
  return `${padDisplay(formatTime(session.updatedAt), TIME_WIDTH)}${COLUMN_GAP}${padDisplay(session.provider || pickerCopy(language).unknownProvider, PROVIDER_WIDTH)}${COLUMN_GAP}${padDisplay(session.title, TITLE_WIDTH)}`;
}

function sessionRows(sessionsList, language = 'en') {
  return sessionsList.map((session) => sessionRow(session, language));
}

export function sessionPickerRows(allSessions, language = 'en') {
  return sessionRows(allSessions, language);
}

async function chooseSessionFlow(allSessions, context, limit) {
  if (!context.models.length) {
    print(missingModelMessage(context));
    return null;
  }

  const copy = pickerCopy(context.promptLanguage);
  const header = sessionHeader(context.promptLanguage);
  const windowSize = limit || DEFAULT_SESSION_LIMIT;
  return await withPickerScreen(async () => {
    let step = 'session';
    while (true) {
      if (step === 'session') {
        const result = await pick(
          copy.sessionTitle,
          sessionPickerRows(allSessions, context.promptLanguage),
          header,
          {
            windowSize,
            emptyMessage: copy.noSessions,
            language: context.promptLanguage,
            shortcuts: [{ key: 'n', displayKey: 'N', action: 'new', label: copy.newSession }],
          },
        );
        if (result.action === 'cancel') return null;
        if (result.action === 'back') return null;
        context.selectedSession = result.action === 'new' ? { newConversation: true } : allSessions[result.index];
        step = 'model';
      } else if (step === 'model') {
        const action = await pickModel(context);
        if (action === 'cancel') return null;
        if (action === 'back') step = 'session';
        else step = 'reasoning';
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

  const selected = await chooseSessionFlow(allSessions, context, options.limit || DEFAULT_SESSION_LIMIT);
  if (selected?.newConversation) await runCodex(codexNewArgs(context));
  else if (selected) await runCodex(codexResumeArgs(selected.id, context));
}
