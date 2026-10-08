import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { startTerminalServer } from '../src/preview/terminal/server.js';
import { TerminalOutput } from '../src/preview/terminal/server.js';
import { TERMINAL_HISTORY_BYTES } from '../src/contracts/previewTerminal.js';

it('bounds retained output and explicitly reports overwritten history to slow readers', () => {
  const history = new TerminalOutput();
  history.append(Buffer.alloc(TERMINAL_HISTORY_BYTES + 12, 65));
  const page = history.read(0);
  expect(page.truncated).toBe(true);
  expect(Buffer.from(page.data, 'base64')).toEqual(Buffer.alloc(65536, 65));
  expect(page.cursor).toBe(12 + 65536);
  expect(history.read(page.cursor).truncated).toBe(false);
  expect(history.read(TERMINAL_HISTORY_BYTES + 12).data).toBe('');
});

describe('compiled terminal runtime and real PTY', () => {
  let root: string;
  let running: Awaited<ReturnType<typeof startTerminalServer>>;
  let base: string;
  let cursor = 0;
  let output = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-terminal-'));
    const assets = join(root, 'runtime');
    execFileSync(process.execPath, ['scripts/build-preview-terminal.mjs', assets], { cwd: resolve('.'), stdio: 'pipe' });
    mkdirSync(join(root, 'source'));
    writeFileSync(join(root, 'source', 'input.json'), '[{"amount":12}]');
    writeFileSync(join(root, 'source', 'cli.cjs'), "console.log(JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'))[0].amount * 2)");
    const module = await import(pathToFileURL(join(assets, 'server.mjs')).href) as { startTerminalServer: typeof startTerminalServer };
    running = await module.startTerminalServer({ sourceRoot: join(root, 'source'), dataRoot: join(root, 'data'),
      assetsRoot: assets, bridge: join(assets, 'pty.py'), host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${running.port}`;
  }, 30_000);
  afterAll(async () => { await running?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
  const post = (path: string, body: string) => fetch(base + path, { method: 'POST', headers: { 'x-atoma-terminal': '1' }, body });
  async function waitFor(text: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/output?after=${cursor}`);
      const result = await response.json() as { data: string; cursor: number };
      output += Buffer.from(result.data, 'base64').toString('utf8');
      cursor = result.cursor;
      // Lines, not bytes: the runner's bash runs with bracketed paste, which
      // writes `\x1b[?2004l\r` right before a command's output, and node colours
      // a TTY number. Stripped of VT sequences that still left `\r\n\r24\r\n`,
      // so a `\r\n`-framed expectation failed only on CI (2026-10-09).
      if (stripVTControlCharacters(output).replace(/\r/g, '').includes(text)) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`terminal did not emit ${text}: ${output}`);
  }
  it('serves packaged assets and executes the delivered CLI on editable data', async () => {
    expect((await fetch(base + '/')).status).toBe(200);
    expect((await fetch(base + '/client.js')).status).toBe(200);
    await waitFor('[exit:0]');
    await post('/input', `'${process.execPath}' cli.cjs input.json\r`);
    await waitFor('\n24\n');
    expect((await post('/upload?name=input.json', '[{"amount":21}]')).status).toBe(200);
    await post('/input', `'${process.execPath}' cli.cjs input.json\r`);
    await waitFor('\n42\n');
    expect(readFileSync(join(root, 'source', 'input.json'), 'utf8')).toBe('[{"amount":12}]');
  });
  it('supports stdin, terminal dimensions, exit codes and interrupting a foreground process', async () => {
    expect((await post('/resize', JSON.stringify({ cols: 93, rows: 27 }))).status).toBe(200);
    await post('/input', 'stty size\r');
    await waitFor('27 93');
    await post('/input', 'read -p "Name: " name; printf "hello-%s\\n" "$name"\r');
    await waitFor('Name: ');
    await post('/input', 'Atoma\r');
    await waitFor('hello-Atoma');
    await post('/input', 'false\r');
    await waitFor('[exit:1]');
    await post('/input', 'sleep 90\r');
    await new Promise((done) => setTimeout(done, 100));
    await post('/input', '\x03');
    await waitFor('[exit:130]');
  });
  it('refuses traversal, symlink uploads, invalid geometry and headerless input', async () => {
    expect((await post('/upload?name=../escape', 'no')).status).toBe(400);
    symlinkSync(join(root, 'source', 'input.json'), join(root, 'data', 'workspace', 'link.json'));
    expect((await post('/upload?name=link.json', 'changed')).status).toBe(400);
    expect(readFileSync(join(root, 'source', 'input.json'), 'utf8')).toBe('[{"amount":12}]');
    expect((await post('/resize', '{"cols":9999,"rows":2}')).status).toBe(400);
    expect((await fetch(base + '/input', { method: 'POST', body: 'false\r' })).status).toBe(404);
  });
});
