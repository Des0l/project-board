import { chatDescription } from './description.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

export function codexCommand() {
  if (process.platform !== 'win32') return ['codex', []];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const base = directory.replace(/^"|"$/g, '');
    if (!base) continue;
    const wrapper = join(base, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(wrapper)) return [process.execPath, [wrapper]];
    const executable = join(base, 'codex.exe');
    if (existsSync(executable)) return [executable, []];
  }
  throw new Error('Не найден Codex CLI в PATH.');
}

export async function openCodex({ root, onEvent, onExit, command = codexCommand() }) {
  const temp = join(root, '.work', 'temp');
  mkdirSync(temp, { recursive: true });
  const [executable, args] = command;
  const child = spawn(executable, [...args, 'app-server', '--listen', 'stdio://'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let alive = true;

  function stop(error) {
    if (!alive) return;
    alive = false;
    for (const waiting of pending.values()) waiting.finish(error);
    onExit?.(error);
  }

  function send(message) {
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  lines.on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Запрос требует интерактивного клиента Codex.' } });
      return;
    }
    if (message.method) {
      onEvent?.(message.method, message.params);
      return;
    }
    const waiting = pending.get(message.id);
    if (waiting) waiting.finish(message.error ? new Error(message.error.message) : null, message.result);
  });
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.on('close', code => stop(new Error('Связь с Codex прервалась (код ' + code + ').')));

  const client = {
    get alive() { return alive; },
    request(method, params) {
      if (!alive) return Promise.reject(new Error('Связь с Codex закрыта.'));
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          waiting.finish(new Error('Codex не ответил на ' + method + '.'));
        }, 25_000);
        const waiting = {
          finish(error, result) {
            clearTimeout(timer);
            pending.delete(id);
            if (error) rejectRequest(error);
            else resolveRequest(result);
          },
        };
        pending.set(id, waiting);
        send({ id, method, params });
      });
    },
    close() {
      child.stdin.end();
    },
  };
  try {
    await client.request('initialize', {
      clientInfo: { name: 'project_board', title: 'Доска проектов', version: '0.1.0' },
      capabilities: null,
    });
    send({ method: 'initialized' });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function containsPath(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot);
}

export function agentWorkDir(workRoot, chatCwd) {
  const base = resolve(workRoot);
  return chatCwd && isAbsolute(chatCwd) && containsPath(base, chatCwd) ? resolve(chatCwd) : base;
}

export function projectForPath(projects, cwd) {
  if (!cwd) return null;
  const path = resolve(cwd);
  let match = null;
  let matchedLength = -1;
  for (const project of projects) {
    for (const root of project.roots) {
      const base = resolve(root);
      if (base.length > matchedLength && containsPath(base, path)) {
        match = project;
        matchedLength = base.length;
      }
    }
  }
  return match;
}

export async function listChats(client, projects) {
  const chats = [];
  let cursor = null;
  do {
    const result = await client.request('thread/list', {
      cursor, limit: 100, sortKey: 'updated_at', archived: false,
      sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true, modelProviders: [],
    });
    for (const thread of result.data) {
      const project = projectForPath(projects, thread.cwd);
      if (!project || thread.ephemeral) continue;
      const flags = thread.status?.type === 'active' ? thread.status.activeFlags ?? [] : [];
      chats.push({
        id: thread.id, projectId: project.id, title: (thread.name || 'Чат без названия').slice(0, 200),
        offerDescription: chatDescription(thread.preview, thread.name || ''),
        waitingFor: flags.includes('waitingOnUserInput') ? 'input' : flags.includes('waitingOnApproval') ? 'approval' : null,
        cwd: thread.cwd, createdAt: thread.createdAt, updatedAt: thread.updatedAt, activity: thread.status?.type ?? 'notLoaded',
      });
    }
    cursor = result.nextCursor;
  } while (cursor);
  return chats;
}

export async function activityFor(client, chatId, expected = []) {
  const result = await client.request('thread/turns/list', {
    threadId: chatId, sortDirection: 'desc', limit: 5, itemsView: 'summary',
  });
  let reply;
  for (const turn of result.data) {
    if (turn.status !== 'completed') continue;
    const item = turn.items.findLast(item => item.type === 'agentMessage' && item.phase === 'final_answer')
      ?? turn.items.findLast(item => item.type === 'agentMessage');
    if (!item) continue;
    reply = { id: item.id || turn.id, at: turn.completedAt, turnId: turn.id };
    break;
  }
  const turns = [...result.data];
  let cursor = result.nextCursor;
  const visited = new Set();
  while (cursor && expected.some(id => !turns.some(turn => turn.id === id))) {
    if (visited.has(cursor)) throw new Error('Codex вернул повторную страницу ходов.');
    visited.add(cursor);
    const page = await client.request('thread/turns/list', {
      threadId: chatId, sortDirection: 'desc', cursor, limit: 50, itemsView: 'summary',
    });
    turns.push(...page.data);
    cursor = page.nextCursor;
  }
  return { reply, latest: turns[0], turns };
}

