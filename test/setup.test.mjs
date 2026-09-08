import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(configDir, requestedPort = null) {
  const port = requestedPort || await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_DIR: configDir,
      MYLAR_URL: 'http://mylar.invalid/api',
      MYLAR_API_KEY: 'test-mylar-key',
      COMICVINE_API_KEY: 'test-comicvine-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return { child, base, output: () => output };
    } catch { /* wait for SQLite migration and HTTP bind */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${output}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not stop')), 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'X-Inkwell': '1', ...options.headers },
  });
  return { response, body: await response.json() };
}

test('setup is persisted in /config and protects writes until an explicit trusted-LAN acknowledgement', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-setup-test-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  const first = await start(configDir);
  t.after(() => stop(first.child));
  const initial = await request(first.base, '/api/setup');
  assert.equal(initial.body.completed, false);
  assert.equal(initial.body.ready, true);

  const blocked = await request(first.base, '/api/cache/clear', { method: 'POST' });
  assert.equal(blocked.response.status, 428);
  assert.equal(blocked.body.code, 'setup_required');

  const unacknowledged = await request(first.base, '/api/setup/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(unacknowledged.response.status, 422);

  const complete = await request(first.base, '/api/setup/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledgeTrustedLan: true }),
  });
  assert.equal(complete.response.status, 201);
  assert.equal(complete.body.setup.completed, true);
  await stop(first.child);

  const second = await start(configDir, Number(new URL(first.base).port));
  t.after(() => stop(second.child));
  const restarted = await request(second.base, '/api/setup');
  assert.equal(restarted.body.completed, true);
  const allowed = await request(second.base, '/api/cache/clear', { method: 'POST' });
  assert.equal(allowed.response.status, 200);
});
