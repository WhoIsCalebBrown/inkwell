import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('recovery reactivates an existing administrator without changing their history', (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-admin-recovery-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { authenticate, createFirstAdmin, createUser, newSession, sessionUser, submitProposal } from './membership.js';
    import { recoverAdmin } from './recover-admin.mjs';
    import { applicationDb, close, readSetting } from './store.js';

    const owner = await createFirstAdmin('owner', 'Owner', 'owner password');
    const friend = await createUser(owner.id, 'friend', 'Friend', 'friend password', ['request']);
    const request = submitProposal(owner.id, { kind: 'parts', volumeId: '123', title: 'Preserved history', publisher: 'Test', partNumbers: ['1'] });
    const session = newSession(owner.id);
    const claimed = readSetting('owner_claimed');
    await assert.rejects(recoverAdmin('owner', 'nope'), /between 5 and 256/);
    await assert.rejects(recoverAdmin('friend', 'friend replacement'), /existing administrator/);
    applicationDb.prepare('UPDATE users SET active=0 WHERE id=?').run(owner.id);
    assert.equal(applicationDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(owner.id).n, 1);
    const recovered = await recoverAdmin('owner', 'owner replacement');
    assert.equal(recovered.id, owner.id);
    const restored = applicationDb.prepare('SELECT * FROM users WHERE id=?').get(owner.id);
    assert.equal(restored.id, owner.id);
    assert.equal(restored.username, 'owner');
    assert.equal(restored.active, 1);
    assert.equal(applicationDb.prepare('SELECT user_id FROM proposals WHERE id=?').get(request.id).user_id, owner.id);
    assert.deepEqual(readSetting('owner_claimed'), claimed);
    assert.equal(applicationDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(owner.id).n, 0);
    assert.equal(sessionUser(session.token), null);
    assert.equal(await authenticate('owner', 'owner password'), null);
    assert.equal((await authenticate('owner', 'owner replacement')).id, owner.id);
    close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { ...process.env, CONFIG_DIR: configDir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
