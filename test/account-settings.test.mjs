import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('account settings preserve identity and revoke sessions at the right boundaries', (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-account-settings-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import {
      acceptInvitation, authenticate, changePassword, createFirstAdmin, createInvitation, createUser,
      newSession, resetUserPassword, sessionUser, setUserMode, updateProfile, userMode,
    } from './membership.js';
    import { applicationDb, close, readSetting, writeSetting } from './store.js';

    await createFirstAdmin('owner', 'Owner', 'owner password');
    const friend = await createUser(1, 'friend', 'Friend', 'friend password', ['request']);
    const friendId = friend.id;
    const originalSession = newSession(friendId);
    await assert.rejects(updateProfile(friendId, 'wrong password', { username: 'friend', displayName: 'Changed' }), /Current password/);
    assert.ok(sessionUser(originalSession.token), 'a rejected profile change keeps sessions');
    await assert.rejects(updateProfile(friendId, 'friend password', { username: 'owner', displayName: 'Changed' }), /already taken/);
    assert.equal((await authenticate('friend', 'friend password')).id, friendId);

    const displayOnly = await updateProfile(friendId, 'friend password', { username: 'friend', displayName: 'Friend Changed' });
    assert.equal(displayOnly.reauthenticate, false);
    assert.equal(displayOnly.user.id, friendId);
    assert.equal(displayOnly.user.displayName, 'Friend Changed');
    assert.ok(sessionUser(originalSession.token), 'display-only changes keep sessions');

    const renamed = await updateProfile(friendId, 'friend password', { username: 'friend-renamed', displayName: 'Friend Changed' });
    assert.equal(renamed.reauthenticate, true);
    assert.equal(renamed.user.id, friendId, 'renaming preserves request ownership');
    assert.equal(sessionUser(originalSession.token), null, 'renaming revokes old sessions');
    assert.equal(await authenticate('friend', 'friend password'), null);
    assert.equal((await authenticate('friend-renamed', 'friend password')).id, friendId);

    const loginRenameRace = authenticate('friend-renamed', 'friend password');
    applicationDb.prepare('UPDATE users SET username=? WHERE id=?').run('friend-raced', friendId);
    assert.equal(await loginRenameRace, null, 'an old username login cannot mint a session after a rename');
    applicationDb.prepare('UPDATE users SET username=? WHERE id=?').run('friend-renamed', friendId);

    const passwordSession = newSession(friendId);
    await assert.rejects(changePassword(friendId, 'wrong password', 'new password'), /Current password/);
    assert.ok(sessionUser(passwordSession.token), 'a rejected password change keeps sessions');
    await assert.rejects(changePassword(friendId, 'friend password', 'nope'), /between 5 and 256/);
    await changePassword(friendId, 'friend password', 'new password');
    assert.equal(sessionUser(passwordSession.token), null, 'password changes revoke all sessions');
    assert.equal(await authenticate('friend-renamed', 'friend password'), null);
    assert.equal((await authenticate('friend-renamed', 'new password')).id, friendId);

    const target = await createUser(1, 'reset-target', 'Reset Target', 'target password', ['request']);
    const targetSession = newSession(target.id);
    await assert.rejects(resetUserPassword(1, target.id, 'wrong password', 'reset password'), /Current password/);
    assert.ok(sessionUser(targetSession.token), 'a rejected admin reset keeps target sessions');
    await assert.rejects(resetUserPassword(friendId, target.id, 'new password', 'reset password'), /Administrator account required/);
    await assert.rejects(resetUserPassword(1, 1, 'owner password', 'reset password'), /own account settings/);
    await resetUserPassword(1, target.id, 'owner password', 'reset password');
    assert.equal(sessionUser(targetSession.token), null, 'admin resets revoke all target sessions');
    assert.equal(await authenticate('reset-target', 'target password'), null);
    assert.ok(await authenticate('reset-target', 'reset password'));

    const passwordRace = changePassword(friendId, 'new password', 'race replacement');
    applicationDb.prepare('UPDATE users SET active=0 WHERE id=?').run(friendId);
    await assert.rejects(passwordRace, /Current password/);
    applicationDb.prepare('UPDATE users SET active=1 WHERE id=?').run(friendId);
    assert.ok(await authenticate('friend-renamed', 'new password'), 'a disabled account cannot finish a password change');

    const profileModeRace = updateProfile(friendId, 'new password', { username: 'friend-profile-race', displayName: 'Race' });
    writeSetting('installation', { ...readSetting('installation'), userMode: 'personal' });
    await assert.rejects(profileModeRace, /Personal mode/);
    writeSetting('installation', { ...readSetting('installation'), userMode: 'friends' });
    const passwordModeRace = changePassword(friendId, 'new password', 'mode race password');
    writeSetting('installation', { ...readSetting('installation'), userMode: 'personal' });
    await assert.rejects(passwordModeRace, /Personal mode/);
    writeSetting('installation', { ...readSetting('installation'), userMode: 'friends' });
    assert.ok(await authenticate('friend-renamed', 'new password'));

    const invitation = createInvitation(1, 'requester');
    const modeSession = newSession(friendId);
    assert.equal(await setUserMode(1, 'owner password', 'friends'), 'friends');
    assert.ok(sessionUser(modeSession.token), 'a no-op mode save keeps requester sessions');
    assert.equal(await setUserMode(1, 'owner password', 'personal'), 'personal');
    assert.equal(userMode(), 'personal');
    assert.equal(sessionUser(modeSession.token), null, 'personal mode removes requester sessions');
    assert.equal(await authenticate('friend-renamed', 'new password'), null, 'personal mode refuses requester sign-in');
    await assert.rejects(createUser(1, 'blocked-user', 'Blocked', 'blocked password', ['request']), /friends mode/);
    assert.throws(() => createInvitation(1, 'requester'), /friends mode/);
    await assert.rejects(acceptInvitation(invitation.token, 'blocked-invite', 'Blocked', 'blocked password'), /personal mode/);
    assert.equal(applicationDb.prepare('SELECT used_at FROM invitations WHERE created_by=1 ORDER BY created_at DESC LIMIT 1').get().used_at, null,
      'personal mode never consumes an invitation');
    await assert.rejects(setUserMode(1, 'wrong password', 'friends'), /Current password/);
    assert.equal(await setUserMode(1, 'owner password', 'friends'), 'friends');
    await acceptInvitation(invitation.token, 'accepted-invite', 'Accepted', 'accepted password');
    assert.ok(await authenticate('accepted-invite', 'accepted password'));

    applicationDb.prepare('UPDATE users SET active=0 WHERE id=?').run(target.id);
    await resetUserPassword(1, target.id, 'owner password', 'inactive reset password');
    assert.equal(applicationDb.prepare('SELECT active FROM users WHERE id=?').get(target.id).active, 0,
      'resetting an inactive requester does not reactivate the account');
    assert.equal(await authenticate('reset-target', 'inactive reset password'), null);

    const modeRace = setUserMode(1, 'owner password', 'personal');
    applicationDb.prepare('UPDATE users SET active=0 WHERE id=1').run();
    await assert.rejects(modeRace, /Current password/);
    applicationDb.prepare('UPDATE users SET active=1 WHERE id=1').run();
    assert.equal(userMode(), 'friends', 'a disabled administrator cannot switch modes');
    close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { ...process.env, CONFIG_DIR: configDir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
