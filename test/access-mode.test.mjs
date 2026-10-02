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
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}
async function launch(configDir, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, CONFIG_DIR: configDir, PORT: String(port), ...extra,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch { /* booting */ }
    await sleep(50);
  }
  assert.equal((await fetch(`${base}/api/ready`)).status, 200, logs);
  return { base, async stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  } };
}
async function call(base, route, body, { cookie = '', basic = '', method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Inkwell': '1' }),
    ...(cookie ? { Cookie: cookie } : {}), ...(basic ? { Authorization: basic } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
const auth = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

test('a legacy shared install upgrades to accounts and stays protected after restart', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-access-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const env = { INKWELL_ACCESS_MODE: 'single', INKWELL_USER: 'legacy', INKWELL_PASSWORD: 'shared-pass' };
  let app = await launch(configDir, env);
  t.after(() => app.stop());
  const setup = await call(app.base, '/api/setup', undefined, { basic: auth('legacy', 'shared-pass') });
  assert.equal(setup.body.accessMode, 'single');
  assert.equal(setup.body.accountUpgradeAvailable, true);
  assert.equal((await call(app.base, '/api/setup/admin', { username: 'owner', password: 'long owner password', mode: 'friends', acknowledgePrivateHttp: false })).status, 401);
  const claimed = await call(app.base, '/api/setup/admin', { username: 'owner', password: 'long owner password', mode: 'friends', acknowledgePrivateHttp: false }, { basic: auth('legacy', 'shared-pass') });
  assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
  assert.ok(claimed.cookie);
  assert.equal((await call(app.base, '/api/me', undefined, { cookie: claimed.cookie })).status, 200, 'Basic auth retires as soon as accounts are active');
  await app.stop();
  app = await launch(configDir, env);
  assert.equal((await call(app.base, '/api/me')).status, 401, 'saved account state defeats an explicit legacy environment on restart');
});

test('Personal mode revokes requesters; Friends mode restores account sign-in and account controls', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-access-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const app = await launch(configDir, { MYLAR_URL: 'http://127.0.0.1:1/api', MYLAR_API_KEY: 'test', COMICVINE_API_KEY: 'test' });
  t.after(() => app.stop());
  const owner = await call(app.base, '/api/setup/admin', { username: 'owner', password: 'long owner password', mode: 'friends', acknowledgePrivateHttp: false });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  assert.equal((await call(app.base, '/api/setup/complete', {}, { cookie: owner.cookie })).status, 201);
  const friend = await call(app.base, '/api/users', { username: 'friend', displayName: 'Friend', password: 'long friend password', permissions: ['request'] }, { cookie: owner.cookie });
  assert.equal(friend.status, 201, JSON.stringify(friend.body));
  const signedIn = await call(app.base, '/api/auth/login', { username: 'friend', password: 'long friend password' });
  assert.equal(signedIn.status, 200);
  const personal = await call(app.base, '/api/access/mode', { mode: 'personal', currentPassword: 'long owner password' }, { cookie: owner.cookie });
  assert.equal(personal.status, 200, JSON.stringify(personal.body));
  assert.equal((await call(app.base, '/api/me', undefined, { cookie: signedIn.cookie })).status, 401, 'changing mode revokes requester sessions');
  assert.equal((await call(app.base, '/api/auth/login', { username: 'friend', password: 'long friend password' })).status, 401, 'Personal mode rejects requester sign-in');
  assert.equal((await call(app.base, '/api/invitations', { role: 'requester' }, { cookie: owner.cookie })).status, 400, 'Personal mode cannot create friend invitations');
  assert.equal((await call(app.base, '/api/me', undefined, { cookie: owner.cookie })).status, 200, 'the owner remains signed in');
  assert.equal((await call(app.base, '/api/access/mode', { mode: 'friends', currentPassword: 'long owner password' }, { cookie: owner.cookie })).status, 200);
  assert.equal((await call(app.base, '/api/auth/login', { username: 'friend', password: 'long friend password' })).status, 200);
  assert.equal((await call(app.base, '/api/me/profile', { username: 'captain' }, { cookie: owner.cookie, method: 'PATCH' })).status, 400,
    'profile changes require the current password');
  assert.equal((await call(app.base, '/api/me/profile', { currentPassword: [], username: 'captain' }, { cookie: owner.cookie, method: 'PATCH' })).status, 400,
    'profile input cannot smuggle an array into password verification');
  assert.equal((await call(app.base, '/api/users/not-a-number/password', { currentPassword: 'long owner password', newPassword: [] }, { cookie: owner.cookie })).status, 400,
    'password reset accepts only a scalar replacement password');
  assert.equal((await call(app.base, '/api/access/mode', { mode: 'unknown', currentPassword: 'long owner password' }, { cookie: owner.cookie })).status, 400,
    'mode changes accept only Personal or Friends');
  const profile = await call(app.base, '/api/me/profile', { currentPassword: 'long owner password', username: 'captain', displayName: 'Captain' }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(profile.body.reauthenticate, true);
  const ownerAgain = await call(app.base, '/api/auth/login', { username: 'captain', password: 'long owner password' });
  assert.equal(ownerAgain.status, 200);
  const reset = await call(app.base, `/api/users/${friend.body.user.id}/password`, { currentPassword: 'long owner password', newPassword: 'replacement friend password' }, { cookie: ownerAgain.cookie });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await call(app.base, '/api/auth/login', { username: 'friend', password: 'replacement friend password' })).status, 200);
});
