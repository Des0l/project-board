import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const port = Number(process.env.PROJECT_BOARD_PORT || 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Неверный порт доски.');
const base = 'http://127.0.0.1:' + port + '/api/';
const app = process.env.PROJECT_BOARD_APP_DIR;

async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-Board-Action': '1' }, body: body && JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка доски ' + response.status);
  return data;
}

const string = { type: 'string' };
const status = { type: 'string', enum: ['planned', 'queued', 'active', 'review', 'done'] };
const fields = { title: string, status, next: string, dueOn: { type: 'string', description: 'YYYY-MM-DD, empty to clear' }, description: string };
function tool(name, description, properties, required, readOnlyHint) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint, destructiveHint: name === 'update_card', openWorldHint: false } };
}
const tools = [
  tool('list_projects', 'List projects available on the local board.', {}, [], true),
  tool('list_cards', 'Read the current cards for one project. Use its ID from list_projects.', { projectId: string }, ['projectId'], true),
  tool('create_card', 'Add a task to a project. Include details from this conversation in description when available. Default status is planned.', { projectId: string, ...fields }, ['projectId', 'title'], false),
  tool('update_card', 'Change the specified fields of a task by its card ID from list_cards.', { id: string, ...fields }, ['id'], false),
];
function summary({ id, number, projectId, title, status, next, dueOn, description, block, tags }) {
  return { id, number, projectId, title, status, next, dueOn, description, block, tags };
}
async function call(name, args) {
  const spec = tools.find(t => t.name === name);
  if (!spec) throw new Error('Неизвестная команда.');
  const schema = spec.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(schema.properties, k) || typeof args[k] !== 'string')
      || schema.required.some(k => !Object.hasOwn(args, k) || !args[k].trim())) throw new Error('Проверьте параметры команды.');
  if (app) {
    // The launcher verifies the database identity and starts the service if it stopped.
    await promisify(execFile)(process.execPath, [join(app, 'open-board.mjs'), '--no-open'], { cwd: app, windowsHide: true, timeout: 18000 });
  }
  const info = await request('launcher');
  if (info.app !== 'project-board' || info.demo) throw new Error('Откройте личную доску проектов.');
  if (name === 'list_projects') return request('bridge/projects');
  if (name === 'list_cards') {
    const board = await request('state');
    if (!board.projects.some(p => p.id === args.projectId)) throw new Error('Проект не найден.');
    return board.cards.filter(c => !c.deletedAt && c.projectId === args.projectId).map(summary);
  }
  if (name === 'create_card') {
    const board = await request('cards', 'POST', args);
    const card = board.cards.findLast(c => !c.deletedAt && c.projectId === args.projectId && c.title === args.title.trim());
    if (!card) throw new Error('Перечитайте карточки проекта, чтобы проверить результат создания.');
    return summary(card);
  }
  const { id, ...changes } = args;
  if (!/^[a-f0-9-]{36}$/.test(id) || !Object.keys(changes).length) throw new Error('Укажите ID карточки и изменения.');
  const board = await request('cards/' + id, 'PATCH', changes);
  return summary(board.cards.find(c => c.id === id));
}

function reply(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
}
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let msg;
  try { msg = JSON.parse(line); } catch { reply(null, { error: { code: -32700, message: 'Parse error' } }); continue; }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    reply(msg?.id ?? null, { error: { code: -32600, message: 'Invalid request' } }); continue;
  }
  if (msg.id === undefined) continue;
  let result;
  if (msg.method === 'initialize') {
    const version = msg.params?.protocolVersion;
    result = { protocolVersion: protocols.includes(version) ? version : protocols[0], serverInfo: { name: 'project-board', version: '1.0.0' }, capabilities: { tools: {} } };
  } else if (msg.method === 'ping') result = {};
  else if (msg.method === 'tools/list') result = { tools };
  else if (msg.method === 'tools/call') {
    try {
      const value = await call(msg.params?.name, msg.params?.arguments ?? {});
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error.cause?.code === 'ECONNREFUSED' ? 'Запустите Доску проектов.' : error.message }] };
    }
  } else { reply(msg.id, { error: { code: -32601, message: 'Method not found' } }); continue; }
  reply(msg.id, { result });
}
