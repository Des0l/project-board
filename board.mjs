#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const usage = [
  'Use --port PORT to select a different board (default 4178).',
  'node board.mjs projects',
  'node board.mjs context --project ID [--provider NAME --session ID]',
  'node board.mjs add|suggest --project ID --provider NAME --session ID [--event ID] [--next "Next step"] [--description "Details from the chat"] "Task title"',
  'node board.mjs ask --project ID --provider NAME --session ID --event QUESTION_ID "Question"',
  'node board.mjs answered --project ID --provider NAME --session ID --event QUESTION_ID',
].join('\n');

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, provider: { type: 'string' }, session: { type: 'string' },
    event: { type: 'string' }, next: { type: 'string' }, description: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, title, ...extra] = positionals;
  if (values.help || !command) return console.log(usage);
  const port = Number(values.port || process.env.PROJECT_BOARD_PORT || 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PROJECT_BOARD_PORT');
  const base = 'http://127.0.0.1:' + port + '/api/bridge/';
  let response;
  if (command === 'projects' && !title) {
    response = await fetch(base + 'projects');
  } else if (command === 'context' && values.project && !title && Boolean(values.provider) === Boolean(values.session)) {
    const query = new URLSearchParams({ project: values.project });
    if (values.session) {
      query.set('provider', values.provider);
      query.set('session', values.session);
    }
    response = await fetch(base + 'context?' + query);
  } else if (['add', 'suggest'].includes(command) && values.project && values.provider && values.session && title && !extra.length) {
    const event = values.event || createHash('sha256').update(JSON.stringify([command, title])).digest('hex');
    response = await fetch(base + 'tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Action': '1' },
      body: JSON.stringify({ projectId: values.project, title, next: values.next, description: values.description, mode: command, source: { provider: values.provider, session: values.session, event } }) });
  } else if (['ask', 'answered'].includes(command) && values.project && values.provider && values.session && values.event
      && !extra.length && (command === 'ask' ? Boolean(title) : !title)) {
    response = await fetch(base + 'questions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Action': '1' },
      body: JSON.stringify({ projectId: values.project, action: command, question: title, source: { provider: values.provider, session: values.session, event: values.event } }) });
  } else throw new Error(usage);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error.cause?.code === 'ECONNREFUSED' ? 'Доска недоступна. Запустите сервер доски и проверьте PROJECT_BOARD_PORT.' : error.message);
  process.exitCode = 1;
});
