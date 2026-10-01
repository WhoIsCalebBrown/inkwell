import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function launch(configDir, accessMode = 'auto') {
  const webPort = await port();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, CONFIG_DIR: configDir, PORT: String(webPort), INKWELL_ACCESS_MODE: accessMode,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${webPort}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch { /* booting */ }
    await sleep(50);
  }
  assert.equal((await fetch(`${base}/api/ready`)).status, 200, logs);
  return { base, child, async stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  } };
}

function privateAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/.test(item.address)) return item.address;
    }
  }
  return null;
}

async function call(base, route, body, cookie = '') {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Inkwell': '1' }),
    ...(cookie ? { Cookie: cookie } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

async function rawCall(base, route, { body, cookie = '', headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    ...(cookie ? { Cookie: cookie } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

test('a fresh auto install is claimed in the browser before any catalogue API is public', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onboarding-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const first = await launch(configDir);
  t.after(() => first.stop());
  const setup = await call(first.base, '/api/setup');
  assert.equal(setup.body.accessMode, 'multi');
  assert.equal(setup.body.accountSetupRequired, true);
  assert.equal((await call(first.base, '/api/search')).status, 401);
  assert.equal((await rawCall(first.base, '/api/setup/admin', {
    body: { username: 'owner', password: 'a long owner password', acknowledgePrivateHttp: false },
  })).status, 403, 'the browser-only header is required before owner setup');
  assert.equal((await rawCall(first.base, '/api/setup/admin', {
    body: { username: 'owner', password: 'a long owner password', acknowledgePrivateHttp: false },
    headers: { 'X-Inkwell': '1', Origin: 'https://attacker.test' },
  })).status, 403, 'a cross-site form cannot claim the first account');
  const created = await call(first.base, '/api/setup/admin', {
    username: 'owner', displayName: 'Owner', password: 'a long owner password', acknowledgePrivateHttp: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.user.username, 'owner');
  assert.ok(created.cookie);
  assert.equal(created.body.setup.accountSetupRequired, false);
  assert.equal((await rawCall(first.base, '/api/setup/complete', { body: {}, headers: { 'X-Inkwell': '1' } })).status, 401,
    'provider setup cannot be completed without the owner session');
  assert.equal((await rawCall(first.base, '/api/health')).status, 401, 'detailed health is private after account setup');
  const health = await rawCall(first.base, '/api/health', { cookie: created.cookie });
  assert.equal(health.status, 200);
  assert.ok('requestSafety' in health.body, 'the owner can diagnose Mylar request safety');
  assert.equal((await call(first.base, '/api/setup/admin', {
    username: 'other', password: 'another long password', acknowledgePrivateHttp: false,
  })).status, 409, 'an existing or disabled account never reopens first-owner setup');
  await first.stop();
  const restart = await launch(configDir);
  t.after(() => restart.stop());
  const afterRestart = await call(restart.base, '/api/setup');
  assert.equal(afterRestart.body.accessMode, 'multi');
  assert.equal(afterRestart.body.accountSetupRequired, false);
  assert.equal((await call(restart.base, '/api/proposals')).status, 401);
});

test('explicit multi mode without an owner serves the wizard and races claim atomically', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onboarding-race-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const app = await launch(configDir, 'multi');
  t.after(() => app.stop());
  const attempts = await Promise.all([
    call(app.base, '/api/setup/admin', { username: 'first', password: 'a long first password', acknowledgePrivateHttp: false }),
    call(app.base, '/api/setup/admin', { username: 'second', password: 'a long second password', acknowledgePrivateHttp: false }),
  ]);
  assert.equal(attempts.filter((result) => result.status === 201).length, 1);
  assert.equal(attempts.filter((result) => result.status === 400).length, 1);
});

test('a completed legacy install stays single-user in auto mode', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onboarding-legacy-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const seeded = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeSetting, close } from './store.js';
    writeSetting('installation', { completedAt: new Date().toISOString(), access: 'legacy-upgrade' });
    close();
  `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir } });
  await new Promise((resolve) => seeded.once('exit', resolve));
  assert.equal(seeded.exitCode, 0);
  const app = await launch(configDir);
  t.after(() => app.stop());
  const setup = await call(app.base, '/api/setup');
  assert.equal(setup.body.accessMode, 'single');
  assert.equal(setup.body.accountSetupRequired, false);
});

test('a disabled old owner never reopens the first-admin wizard', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onboarding-locked-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const seeded = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createFirstAdmin } from './membership.js';
    import { applicationDb, close } from './store.js';
    await createFirstAdmin('old-owner', 'Old owner', 'a long old owner password');
    applicationDb.prepare('UPDATE users SET active=0').run();
    close();
  `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir } });
  await new Promise((resolve) => seeded.once('exit', resolve));
  assert.equal(seeded.exitCode, 0);
  const app = await launch(configDir, 'multi');
  t.after(() => app.stop());
  const setup = await call(app.base, '/api/setup');
  assert.equal(setup.body.accountSetupRequired, false);
  assert.equal((await call(app.base, '/api/setup/admin', {
    username: 'takeover', password: 'a long takeover password', acknowledgePrivateHttp: false,
  })).status, 409);
});

test('direct private HTTP needs acknowledgement, persists it, and rejects forwarded setup', async (t) => {
  const address = privateAddress();
  if (!address) return t.skip('no RFC1918 interface is available on this runner');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onboarding-private-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const app = await launch(configDir);
  t.after(() => app.stop());
  const base = app.base.replace('127.0.0.1', address);
  const setup = await rawCall(base, '/api/setup');
  assert.equal(setup.body.needsPrivateHttpAcknowledgement, true);
  assert.equal((await rawCall(base, '/api/setup/admin', {
    body: { username: 'private-owner', password: 'a long private owner password', acknowledgePrivateHttp: false },
    headers: { 'X-Inkwell': '1' },
  })).status, 403);
  assert.equal((await rawCall(base, '/api/setup/admin', {
    body: { username: 'forwarded-owner', password: 'a long private owner password', acknowledgePrivateHttp: true },
    headers: { 'X-Inkwell': '1', 'X-Forwarded-For': '192.168.1.2' },
  })).status, 403, 'forwarded HTTP cannot claim the owner');
  const created = await rawCall(base, '/api/setup/admin', {
    body: { username: 'private-owner', password: 'a long private owner password', acknowledgePrivateHttp: true },
    headers: { 'X-Inkwell': '1' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await app.stop();
  const restart = await launch(configDir);
  t.after(() => restart.stop());
  const login = await rawCall(restart.base.replace('127.0.0.1', address), '/api/auth/login', {
    body: { username: 'private-owner', password: 'a long private owner password' }, headers: { 'X-Inkwell': '1' },
  });
  assert.equal(login.status, 200, 'the acknowledged direct private connection remains usable after restart');
});

test('owner setup is rate limited before password hashing and a deleted owner remains claimed', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onboarding-rate-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const app = await launch(configDir);
  t.after(() => app.stop());
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await call(app.base, '/api/setup/admin', { username: 'no', password: 'short', acknowledgePrivateHttp: false });
    assert.equal(response.status, 400);
  }
  assert.equal((await call(app.base, '/api/setup/admin', {
    username: 'owner', password: 'a long owner password', acknowledgePrivateHttp: false,
  })).status, 429);

  // The marker is independent of the account row. Removing a row manually
  // must not turn an existing server into a public first-owner wizard.
  await app.stop();
  const seed = spawn(process.execPath, ['--input-type=module', '-e', `
    import { applicationDb, writeSetting, close } from './store.js';
    writeSetting('owner_claimed', { at: Date.now() });
    applicationDb.prepare('DELETE FROM users').run();
    close();
  `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir } });
  await new Promise((resolve) => seed.once('exit', resolve));
  assert.equal(seed.exitCode, 0);
  const restarted = await launch(configDir, 'multi');
  t.after(() => restarted.stop());
  assert.equal((await call(restarted.base, '/api/setup')).body.accountSetupRequired, false);
  assert.equal((await call(restarted.base, '/api/setup/admin', {
    username: 'takeover', password: 'a long takeover password', acknowledgePrivateHttp: false,
  })).status, 409);
});
