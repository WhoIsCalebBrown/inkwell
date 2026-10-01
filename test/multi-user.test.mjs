import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}

test('requester submission waits for admin approval and cannot use Mylar controls', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-members-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const configFile = path.join(configDir, 'mylar.ini');
  fs.writeFileSync(configFile, 'autowant_all = False\nautowant_upcoming = False\n');
  const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createFirstAdmin } from './membership.js';
    import { rememberVolumes, close } from './store.js';
    await createFirstAdmin('owner', 'Owner', 'a long test password');
    rememberVolumes({ id: 123, name: 'Example Series', resource_type: 'volume',
      count_of_issues: 2, publisher: { name: 'Example' } });
    rememberVolumes({ id: 456, name: 'New Weekly Series', resource_type: 'volume',
      count_of_issues: 5, publisher: { name: 'Example' } });
    close();
  `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir }, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);

  let tracked = false;
  let weeklyTracked = false;
  const commands = [];
  let holdWeekly = false;
  let heldResponse = null;
  let extraWeeklyIssue = false;
  let weeklyStatus = 'Active';
  let uncertainIssue = false;
  let resolvedIssue = false;
  let holdIssueQueue = false;
  let heldQueue = null;
  const today = new Date().toISOString().slice(0, 10);
  const mylar = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cmd = url.searchParams.get('cmd');
    commands.push(cmd);
    res.setHeader('Content-Type', 'application/json');
    if (cmd === 'getIndex') return res.end(JSON.stringify({ data: [
      ...(tracked ? [{ id: 123, name: 'Example Series' }] : []),
      ...(weeklyTracked ? [{ id: 456, name: 'New Weekly Series' }] : []),
    ] }));
    if (cmd === 'getComic') {
      const id = url.searchParams.get('id');
      const data = id === '456' && weeklyTracked
        ? { comic: { id: 456, name: 'New Weekly Series', status: weeklyStatus }, issues: [
          { id: 2001, number: '1', status: 'Skipped', releaseDate: '2000-01-01' },
          { id: 2002, number: '2', status: 'Skipped', releaseDate: '2099-01-01' },
          { id: 2003, number: '3', status: 'Skipped', releaseDate: today },
          { id: 2004, number: '4', status: 'Skipped', releaseDate: '0000-00-00', issueDate: today },
          ...(extraWeeklyIssue ? [{ id: 2005, number: '5', status: 'Skipped', releaseDate: today }] : []),
          ...(uncertainIssue ? [{ id: 2006, number: '6', status: resolvedIssue ? 'Wanted' : 'Skipped', releaseDate: today }] : []),
        ] }
        : tracked ? { comic: { id: Number(id), name: 'Example Series' }, issues: [
          { id: 1001, number: '1', status: 'Skipped' }, { id: 1002, number: '2', status: 'Skipped' },
        ] } : {};
      if (id === '456' && holdWeekly) { heldResponse = () => res.end(JSON.stringify({ data })); return; }
      return res.end(JSON.stringify({ data }));
    }
    if (cmd === 'addComic') {
      if (url.searchParams.get('id') === '456') weeklyTracked = true;
      else tracked = true;
      return res.end('"OK"');
    }
    if (cmd === 'queueIssue') {
      if (url.searchParams.get('id') === '2006') {
        const fail = () => { res.statusCode = 500; res.end(JSON.stringify({ error: 'unconfirmed handoff' })); };
        if (holdIssueQueue) { heldQueue = fail; return; }
        return fail();
      }
      return res.end('"OK"');
    }
    return res.end('"OK"');
  });
  const mylarPort = await port();
  await new Promise((resolve) => mylar.listen(mylarPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mylar.close(resolve)));

  const webPort = await port();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, CONFIG_DIR: configDir, PORT: String(webPort), MYLAR_CONFIG: configFile,
    MYLAR_URL: `http://127.0.0.1:${mylarPort}/api`, MYLAR_API_KEY: 'test', COMICVINE_API_KEY: 'test',
    INKWELL_ACCESS_MODE: 'multi', INKWELL_WATCH_INITIAL_DELAY_MS: '1', INKWELL_WATCH_INTERVAL_MS: '100',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  });
  const base = `http://127.0.0.1:${webPort}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch { /* startup */ }
    await sleep(100);
  }
  assert.equal((await fetch(`${base}/api/ready`)).status, 200, logs);
  const call = async (route, body, cookie = '', method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${base}${route}`, { method, headers: {
      'X-Inkwell': '1', ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  };

  assert.equal((await call('/api/proposals')).status, 401);
  const admin = await call('/api/auth/login', { username: 'owner', password: 'a long test password' });
  assert.equal(admin.status, 200, logs);
  assert.equal((await call('/api/setup/complete', {}, admin.cookie)).status, 201);
  const invite = await call('/api/invitations', { role: 'requester' }, admin.cookie);
  assert.equal(invite.status, 201);
  assert.equal((await call('/api/auth/invite/accept', {
    token: invite.body.token, username: 'friend', displayName: 'Friend', password: 'another long password',
  })).status, 201);
  const friend = await call('/api/auth/login', { username: 'friend', password: 'another long password' });
  assert.equal(friend.status, 200);
  assert.equal((await call('/api/requests', undefined, friend.cookie)).status, 403);
  assert.equal((await call('/api/mylar/settings', undefined, friend.cookie)).status, 403);
  assert.equal((await call('/api/mylar/settings', { autoWantAll: false, autoWantUpcoming: false, version: 'x' }, friend.cookie, 'PUT')).status, 403);
  const capabilities = await call('/api/request-capabilities', undefined, friend.cookie);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.future, { available: true, reason: null });
  assert.equal('autoWantAll' in capabilities.body, false, 'requesters do not receive raw Mylar config');
  assert.equal((await call('/api/request', { id: 123 }, friend.cookie)).status, 403);
  assert.equal((await call('/api/downloads/retry', {}, friend.cookie)).status, 403);
  const before = commands.length;
  const proposed = await call('/api/proposals', { kind: 'parts', volumeId: '123', partNumbers: ['2'] }, friend.cookie);
  assert.equal(proposed.status, 201);
  assert.equal(proposed.body.status, 'pending');
  assert.equal(commands.length, before, 'submission must not call Mylar');
  const id = proposed.body.id;
  assert.equal((await call(`/api/proposals/${id}/approve`, {}, friend.cookie)).status, 403);
  for (const unsafe of ['True', 'true', '1', 'unknown', '']) {
    fs.writeFileSync(configFile, `autowant_all = ${unsafe}\nautowant_upcoming = False\n`);
    assert.equal((await call(`/api/proposals/${id}/approve`, {}, admin.cookie)).status, 409,
      `a new series must be blocked when autowant_all is ${JSON.stringify(unsafe)}`);
    assert.equal((await call(`/api/proposals/${id}`, undefined, friend.cookie)).body.status, 'pending');
  }
  fs.writeFileSync(configFile, 'autowant_all = False\nautowant_upcoming = True\n');
  assert.equal((await call(`/api/proposals/${id}/approve`, {}, admin.cookie)).status, 409,
    'a new selected request must also block Mylar upcoming auto-downloads');
  assert.equal(commands.includes('addComic'), false, 'blocked approvals must not add a series');
  assert.equal(commands.includes('queueIssue'), false, 'blocked approvals must not queue an issue');
  fs.writeFileSync(configFile, 'autowant_all = False\nautowant_upcoming = False\n');
  const approved = await call(`/api/proposals/${id}/approve`, {}, admin.cookie);
  assert.equal(approved.status, 200, logs);
  assert.equal(approved.body.status, 'active', JSON.stringify(approved.body));
  assert.equal(commands.filter((command) => command === 'queueIssue').length, 1);
  assert.equal((await call(`/api/proposals/${id}`, undefined, friend.cookie)).body.parts[0].issueId, '1002');

  const follow = await call('/api/proposals', { kind: 'follow', volumeId: '456' }, friend.cookie);
  assert.equal(follow.status, 201);
  const addedBeforeFollow = commands.filter((command) => command === 'addComic').length;
  for (const unsafe of ['True', 'true', '1', 'unknown', '']) {
    fs.writeFileSync(configFile, `autowant_all = False\nautowant_upcoming = ${unsafe}\n`);
    assert.equal((await call(`/api/proposals/${follow.body.id}/approve`, {}, admin.cookie)).status, 409,
      `an ongoing follow must be blocked when autowant_upcoming is ${JSON.stringify(unsafe)}`);
  }
  assert.equal(commands.filter((command) => command === 'addComic').length, addedBeforeFollow,
    'blocked follows must not add a series');
  fs.writeFileSync(configFile, 'autowant_all = false\nautowant_upcoming = false\n');
  assert.equal((await call(`/api/proposals/${follow.body.id}/approve`, {}, admin.cookie)).body.status, 'active');
  assert.equal(weeklyTracked, true);
  await sleep(350);
  assert.equal(commands.filter((command) => command === 'queueIssue').length, 1,
    'future-dated, same-day and missing-release-date issues must not queue');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const backdate = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { applicationDb as db, close } from './store.js';
    db.prepare('UPDATE proposals SET future_cutoff_day=? WHERE id=?').run('${yesterday}', ${follow.body.id});
    close();
  `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir }, encoding: 'utf8' });
  assert.equal(backdate.status, 0, backdate.stderr);
  weeklyStatus = 'Paused';
  await sleep(250);
  assert.equal(commands.filter((command) => command === 'queueIssue').length, 1, 'a paused Mylar series must not dispatch');
  weeklyStatus = 'Active';
  await sleep(350);
  assert.equal(commands.filter((command) => command === 'queueIssue').length, 2,
    'only an already released issue after the approval cutoff is queued');
  uncertainIssue = true;
  for (let attempt = 0; commands.filter((command) => command === 'queueIssue').length < 3 && attempt < 40; attempt++) await sleep(50);
  const uncertain = await call(`/api/proposals/${follow.body.id}`, undefined, admin.cookie);
  assert.equal(uncertain.body.future.status, 'attention', 'an unconfirmed handoff must be visible');
  assert(uncertain.body.recentIssues.some((issue) => issue.dispatchStatus === 'sending'));
  assert.equal((await call(`/api/proposals/${follow.body.id}/future/2006/retry`, {}, friend.cookie)).status, 403);
  holdIssueQueue = true;
  const retryInFlight = call(`/api/proposals/${follow.body.id}/future/2006/retry`, {}, admin.cookie);
  for (let attempt = 0; !heldQueue && attempt < 40; attempt++) await sleep(50);
  assert(heldQueue);
  assert.equal((await call(`/api/proposals/${follow.body.id}/future/2006/retry`, {}, admin.cookie)).status, 409,
    'a retry cannot replace an in-flight claim');
  holdIssueQueue = false;
  heldQueue();
  assert.equal((await retryInFlight).status, 200);
  resolvedIssue = true;
  const reconciled = await call(`/api/proposals/${follow.body.id}/future/2006/retry`, {}, admin.cookie);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.future.status, 'monitoring');
  assert.equal(commands.filter((command) => command === 'queueIssue').length, 4,
    'reconciliation of Wanted must not send another handoff');
  const secondInvite = await call('/api/invitations', { role: 'requester' }, admin.cookie);
  assert.equal((await call('/api/auth/invite/accept', {
    token: secondInvite.body.token, username: 'friend2', password: 'a third long password',
  })).status, 201);
  const secondFriend = await call('/api/auth/login', { username: 'friend2', password: 'a third long password' });
  const secondFollow = await call('/api/proposals', { kind: 'follow', volumeId: '456' }, secondFriend.cookie);
  fs.writeFileSync(configFile, 'autowant_all = 0\nautowant_upcoming = 0\n');
  assert.equal((await call(`/api/proposals/${secondFollow.body.id}/approve`, {}, admin.cookie)).body.status, 'active');
  assert.equal((await call(`/api/proposals/${follow.body.id}/stop-request`, {}, friend.cookie)).status, 200);
  const stopped = await call(`/api/proposals/${follow.body.id}/stop`, {}, admin.cookie);
  assert.equal(stopped.body.status, 'stopped', JSON.stringify(stopped.body));
  assert.equal(commands.filter((command) => command === 'pauseComic').length, 0, 'another friend still follows');
  const backdateSecond = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { applicationDb as db, close } from './store.js';
    db.prepare('UPDATE proposals SET future_cutoff_day=? WHERE id=?').run('${yesterday}', ${secondFollow.body.id});
    close();
  `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir }, encoding: 'utf8' });
  assert.equal(backdateSecond.status, 0, backdateSecond.stderr);
  holdWeekly = true;
  extraWeeklyIssue = true;
  for (let attempt = 0; !heldResponse && attempt < 40; attempt++) await sleep(50);
  assert(heldResponse, 'monitor should be waiting on a slow Mylar response');
  assert.equal((await call(`/api/proposals/${secondFollow.body.id}/stop`, {}, admin.cookie)).body.status, 'stopped');
  holdWeekly = false;
  heldResponse();
  await sleep(250);
  assert.equal(commands.filter((command) => command === 'queueIssue').length, 4,
    'stopping during a Mylar read prevents the later handoff');
  assert.equal(commands.filter((command) => command === 'pauseComic').length, 0, 'stopping only ends Inkwell monitoring');

  assert.equal((await call('/api/users', undefined, friend.cookie)).status, 403);
  assert.equal((await call('/api/users/2/status', { active: false }, admin.cookie)).status, 200);
  assert.equal((await call('/api/proposals', undefined, friend.cookie)).status, 401, 'disabling an account revokes its sessions');

  const policy = await call('/api/request-policy', undefined, admin.cookie);
  assert.equal(policy.body.limit, 0, 'limits are off until the admin chooses one');
  assert.equal((await call('/api/request-policy', {
    limit: 1, windowDays: 30, autoApprove: false, defaultPermissions: [],
  }, admin.cookie, 'PUT')).status, 200);
  const thirdInvite = await call('/api/invitations', { role: 'requester' }, admin.cookie);
  assert.equal((await call('/api/auth/invite/accept', {
    token: thirdInvite.body.token, username: 'friend3', password: 'a fourth long password',
  })).status, 201);
  const thirdFriend = await call('/api/auth/login', { username: 'friend3', password: 'a fourth long password' });
  assert.deepEqual(thirdFriend.body.user.permissions, [], 'new users receive current default permissions');
  assert.equal((await call('/api/proposals', { kind: 'parts', volumeId: '123', partNumbers: ['1'] }, thirdFriend.cookie)).status, 400);
  assert.equal((await call('/api/users', undefined, thirdFriend.cookie)).status, 403);
  const granted = await call('/api/users/4/permissions', {
    permissions: ['request', 'manage_requests'], requestLimitOverride: 2,
  }, admin.cookie);
  assert.equal(granted.status, 200);
  assert.equal((await call('/api/requests', undefined, thirdFriend.cookie)).status, 403,
    'a request manager does not gain direct Mylar controls');
  assert.equal((await call('/api/proposals', undefined, thirdFriend.cookie)).body.items.length >= 2, true,
    'a request manager sees requests from other users');
  const managed = await call('/api/proposals', { kind: 'parts', volumeId: '123', partNumbers: ['1'] }, thirdFriend.cookie);
  assert.equal(managed.status, 201);
  assert.equal(managed.body.status, 'pending');
  assert.equal((await call(`/api/proposals/${managed.body.id}/approve`, {}, thirdFriend.cookie)).body.status, 'active');
  assert.equal((await call('/api/proposals', { kind: 'parts', volumeId: '456', partNumbers: ['2', '1'] }, thirdFriend.cookie)).status, 400,
    'each selected part counts toward the limit');
  assert.equal((await call('/api/proposals', { kind: 'follow', volumeId: '456', partNumbers: ['1'] }, thirdFriend.cookie)).status, 400,
    'a follow counts as one item plus each selected part');

  assert.equal((await call('/api/users/3/permissions', {
    permissions: ['request', 'auto_approve'], requestLimitOverride: 0,
  }, admin.cookie)).status, 200);
  const queuedBeforeAuto = commands.filter((command) => command === 'queueIssue').length;
  const automatic = await call('/api/proposals', { kind: 'parts', volumeId: '123', partNumbers: ['1'] }, secondFriend.cookie);
  assert.equal(automatic.body.status, 'active', JSON.stringify(automatic.body));
  assert.equal(commands.filter((command) => command === 'queueIssue').length, queuedBeforeAuto + 1);
  assert.equal((await call('/api/request-policy', {
    limit: 1, windowDays: 30, autoApprove: true, defaultPermissions: [],
  }, admin.cookie, 'PUT')).status, 200);
  const globallyAutomatic = await call('/api/proposals', {
    kind: 'parts', volumeId: '456', partNumbers: ['2'],
  }, thirdFriend.cookie);
  assert.equal(globallyAutomatic.body.status, 'active', JSON.stringify(globallyAutomatic.body));

  const created = await call('/api/users', {
    username: 'direct-friend', displayName: 'Direct Friend', password: 'a fifth long password',
    permissions: ['request'], requestLimitOverride: 4,
  }, admin.cookie);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.user.username, 'direct-friend');
  assert.deepEqual(created.body.user.permissions, ['request']);
  assert.equal(created.body.user.allowance.limit, 4);
  assert.equal('password_hash' in created.body.user, false);
  const directFriend = await call('/api/auth/login', { username: 'direct-friend', password: 'a fifth long password' });
  assert.equal(directFriend.status, 200);
  assert.equal((await call('/api/users', {
    username: 'no', password: 'a sixth long password', permissions: ['request'],
  }, admin.cookie)).status, 400, 'direct creation validates usernames');
  assert.equal((await call('/api/users', {
    username: 'weak-password', password: 'short', permissions: ['request'],
  }, admin.cookie)).status, 400, 'direct creation validates passwords');
  assert.equal((await call('/api/users', {
    username: 'denied-friend', password: 'a seventh long password', permissions: ['request'],
  }, secondFriend.cookie)).status, 403, 'requesters cannot create accounts');

  const manager = await call('/api/users', {
    username: 'user-manager', password: 'an eighth long password',
    permissions: ['request', 'manage_users'], requestLimitOverride: null,
  }, admin.cookie);
  assert.equal(manager.status, 201, JSON.stringify(manager.body));
  const managerLogin = await call('/api/auth/login', { username: 'user-manager', password: 'an eighth long password' });
  assert.equal(managerLogin.status, 200);
  assert.equal((await call('/api/users', {
    username: 'escalated-friend', password: 'a ninth long password', permissions: ['request', 'auto_approve'],
  }, managerLogin.cookie)).status, 400, 'managers cannot grant permissions they do not have');
  assert.equal((await call(`/api/users/${created.body.user.id}/permissions`, {
    permissions: ['request', 'auto_approve'], requestLimitOverride: 0,
  }, managerLogin.cookie)).status, 400, 'managers cannot add permissions they do not have');
  assert.equal((await call(`/api/users/${created.body.user.id}/permissions`, {
    permissions: ['request'], requestLimitOverride: 0,
  }, managerLogin.cookie)).status, 200, 'managers can grant their own permissions');

  assert.equal((await call('/api/request-policy', {
    limit: 1, windowDays: 30, autoApprove: true, defaultPermissions: ['request', 'auto_approve'],
  }, admin.cookie, 'PUT')).status, 200);
  assert.equal((await call('/api/invitations', { role: 'requester' }, managerLogin.cookie)).status, 400,
    'a delegated manager cannot use invitations to grant permissions they lack');
  const adminInvite = await call('/api/invitations', { role: 'requester' }, admin.cookie);
  assert.equal(adminInvite.status, 201);
  assert.equal((await call('/api/auth/invite/accept', {
    token: adminInvite.body.token, username: 'admin-invited', password: 'a tenth long password',
  })).status, 201, 'an admin invitation keeps the configured default permissions');
  const adminInvited = await call('/api/auth/login', { username: 'admin-invited', password: 'a tenth long password' });
  assert.deepEqual(adminInvited.body.user.permissions, ['request', 'auto_approve']);

  assert.equal((await call('/api/request-policy', {
    limit: 1, windowDays: 30, autoApprove: true, defaultPermissions: ['request'],
  }, admin.cookie, 'PUT')).status, 200);
  const managerInvite = await call('/api/invitations', { role: 'requester' }, managerLogin.cookie);
  assert.equal(managerInvite.status, 201);
  assert.equal((await call(`/api/users/${manager.body.user.id}/status`, { active: false }, admin.cookie)).status, 200);
  assert.equal((await call('/api/auth/invite/accept', {
    token: managerInvite.body.token, username: 'inactive-manager-invite', password: 'an eleventh long password',
  })).status, 400, 'an invitation cannot be used after its delegated manager is disabled');
});
