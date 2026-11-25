import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function installBoardPlugin(root, dataDir, port) {
  const market = join(root, '.work', 'plugin-marketplace');
  const plugin = join(market, 'plugins', 'project-board');
  mkdirSync(join(market, '.agents', 'plugins'), { recursive: true });
  cpSync(join(root, 'plugins', 'project-board'), plugin, { recursive: true });
  const write = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  const name = 'project-board-local';
  write(join(market, '.agents', 'plugins', 'marketplace.json'), { name, plugins: [{
    name: 'project-board', source: { source: 'local', path: './plugins/project-board' }, category: 'Productivity',
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }
  }] });
  const env = { PROJECT_BOARD_APP_DIR: root, PROJECT_BOARD_DATA: dataDir, PROJECT_BOARD_PORT: String(port) };
  if (process.env.PROJECT_BOARD_PROJECTS) env.PROJECT_BOARD_PROJECTS = process.env.PROJECT_BOARD_PROJECTS;
  const connection = { command: process.execPath, args: [join(root, 'plugins', 'project-board', 'board-tools.mjs')], env };
  const bin = basename(process.execPath);
  mkdirSync(join(plugin, 'runtime'), { recursive: true });
  copyFileSync(process.execPath, join(plugin, 'runtime', bin));
  const license = join(dirname(process.execPath), 'LICENSE');
  if (existsSync(license)) copyFileSync(license, join(plugin, 'runtime', 'LICENSE'));
  write(join(plugin, 'mcp.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { board: { type: 'stdio', command: './runtime/' + bin, args: ['${PLUGIN_ROOT}/board-tools.mjs'], env } }
  });
  // Some installed CLI versions still use the compatibility manifest.
  const manifest = JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8'));
  mkdirSync(join(plugin, '.codex-plugin'), { recursive: true });
  write(join(plugin, '.codex-plugin', 'plugin.json'), { name: manifest.name, version: manifest.version, description: manifest.description,
    interface: { displayName: 'Доска проектов' }, mcpServers: './.mcp.json' });
  write(join(plugin, '.mcp.json'), { mcpServers: { board: connection } });
  function codex(args) {
    const windows = process.platform === 'win32';
    execFileSync(windows ? 'cmd.exe' : 'codex', windows ? ['/d', '/c', 'codex', ...args] : args,
      { cwd: market, stdio: 'inherit', windowsHide: true });
  }
  console.log('Локальный каталог плагина: ' + market);
  codex(['plugin', 'marketplace', 'add', '.']);
  codex(['plugin', 'add', 'project-board@' + name]);
}
