// Durable accounts and requests. Provider responses remain in store.js; this
// module owns the decisions that cannot be rebuilt from Mylar after a restart.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { applicationDb as db, readSetting, writeSetting } from './store.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const SESSION_MS = 30 * 24 * 60 * 60_000;
const INVITE_MS = 7 * 24 * 60 * 60_000;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
export const PERMISSIONS = ['request', 'auto_approve', 'manage_requests', 'manage_users'];
const DEFAULT_POLICY = { limit: 0, windowDays: 30, autoApprove: false, defaultPermissions: ['request'] };
const permissionsOf = (user) => {
  if (user?.role === 'admin') return [...PERMISSIONS];
  try {
    const values = JSON.parse(user?.permissions || '["request"]');
    return Array.isArray(values) ? PERMISSIONS.filter((permission) => values.includes(permission)) : ['request'];
  } catch { return ['request']; }
};
export const can = (user, permission) => Boolean(user && permissionsOf(user).includes(permission));
export function requestPolicy() {
  return { ...DEFAULT_POLICY, ...(readSetting('request_policy') || {}) };
}
export function setRequestPolicy(value) {
  const limit = Number(value?.limit);
  const windowDays = Number(value?.windowDays);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw new Error('Limit must be 0–10,000 items; 0 means unlimited.');
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new Error('Choose a window from 1 to 365 days.');
  if (typeof value?.autoApprove !== 'boolean') throw new Error('Choose whether requests are approved automatically.');
  const defaults = value?.defaultPermissions;
  if (!Array.isArray(defaults) || defaults.some((permission) => !PERMISSIONS.includes(permission))) throw new Error('Choose valid default permissions.');
  return writeSetting('request_policy', { limit, windowDays, autoApprove: value.autoApprove,
    defaultPermissions: [...new Set(defaults)] });
}

export function requestAllowance(user) {
  const policy = requestPolicy();
  const limit = user.role === 'admin' ? 0 : user.request_limit_override ?? policy.limit;
  const since = Date.now() - policy.windowDays * 24 * 60 * 60_000;
  const used = Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='follow' THEN 1 +
    (SELECT COUNT(*) FROM proposal_parts WHERE proposal_id=p.id) ELSE
    (SELECT COUNT(*) FROM proposal_parts WHERE proposal_id=p.id) END), 0) AS units
    FROM proposals p WHERE user_id=? AND created_at>=? AND status NOT IN ('rejected','withdrawn')`)
    .get(user.id, since).units);
  return { limit, windowDays: policy.windowDays, used, remaining: limit ? Math.max(0, limit - used) : null };
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Choose a password between 12 and 256 characters.');
  }
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

async function checkPassword(password, stored) {
  const [kind, salt, encoded] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'base64url');
  const actual = await scrypt(String(password), salt, expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export const adminCount = () => Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n);
export const userCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
export const publicUser = (user) => user && ({ id: user.id, username: user.username, displayName: user.display_name,
  role: user.role, permissions: permissionsOf(user), allowance: requestAllowance(user),
  autoApprove: user.role === 'admin' || can(user, 'auto_approve') || requestPolicy().autoApprove });

export async function createFirstAdmin(username, displayName, password, { allowPrivateHttp = false } = {}) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(name)) throw new Error('Username must be 3–40 letters, numbers, dots, dashes or underscores.');
  const hash = await hashPassword(password);
  // scrypt yields to the event loop. Claim first-admin status under SQLite's
  // write lock after hashing, so two setup tabs cannot create two owners and
  // a disabled old account never reopens an installation to public takeover.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (userCount() || readSetting('owner_claimed')) throw new Error('This installation already has an account.');
    const result = db.prepare('INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, String(displayName || name).trim().slice(0, 80), 'admin', hash, Date.now());
    const now = Date.now();
    writeSetting('owner_claimed', { at: now });
    const installation = readSetting('installation') || {};
    writeSetting('installation', { ...installation, accessMode: 'multi', accountsCreatedAt: new Date(now).toISOString(),
      allowPrivateHttp: Boolean(allowPrivateHttp) });
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid));
  } catch (error) {
    db.exec('ROLLBACK');
    if (/UNIQUE constraint/.test(error.message)) throw new Error('That username is already taken.');
    throw error;
  }
}

function validUsername(username) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(name)) {
    throw new Error('Username must be 3–40 letters, numbers, dots, dashes or underscores.');
  }
  return name;
}

function validPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.some((permission) => !PERMISSIONS.includes(permission))) {
    throw new Error('Choose valid permissions.');
  }
  return [...new Set(permissions)];
}

function validLimitOverride(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 10000)) {
    throw new Error('The per-user limit must be 0–10,000, or inherit the default.');
  }
  return value;
}

function activeManager(actorId) {
  const actor = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(Number(actorId));
  if (!can(actor, 'manage_users')) throw new Error('Manage users permission required.');
  return actor;
}

function canGrant(actor, permissions) {
  if (actor.role === 'admin') return;
  if (permissions.some((permission) => !can(actor, permission))) {
    throw new Error('You can only grant permissions your account has.');
  }
}

export async function createUser(actorId, username, displayName, password, permissions, requestLimitOverride = null) {
  activeManager(actorId);
  const name = validUsername(username);
  validPermissions(permissions === undefined ? requestPolicy().defaultPermissions : permissions);
  const limit = validLimitOverride(requestLimitOverride);
  const hash = await hashPassword(password);
  // Password hashing yields to the event loop. Re-read the actor afterwards so
  // an account disabled or downgraded during that work cannot finish creating
  // an account with its former authority.
  const actor = activeManager(actorId);
  const granted = validPermissions(permissions === undefined ? requestPolicy().defaultPermissions : permissions);
  canGrant(actor, granted);
  try {
    const result = db.prepare(`INSERT INTO users
      (username, display_name, role, password_hash, created_at, permissions, request_limit_override)
      VALUES (?, ?, 'requester', ?, ?, ?, ?)`)
      .run(name, String(displayName || name).trim().slice(0, 80), hash, Date.now(), JSON.stringify(granted), limit);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid));
    return publicUser(user);
  } catch (error) {
    if (/UNIQUE constraint/.test(error.message)) throw new Error('That username is already taken.');
    throw error;
  }
}

export function createInvitation(actorId, role = 'requester') {
  if (!['admin', 'requester'].includes(role)) throw new Error('Unknown role.');
  const actor = activeManager(actorId);
  if (role === 'admin' && actor.role !== 'admin') throw new Error('You cannot create this invitation.');
  // Invitations pick up the current policy when they are redeemed. Check it
  // here and again at redemption so a delegated manager cannot hand out a
  // capability they do not have through a stale link.
  canGrant(actor, requestPolicy().defaultPermissions);
  const secret = token();
  db.prepare('INSERT INTO invitations (token_hash, role, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(secret), role, Number(actorId), Date.now() + INVITE_MS, Date.now());
  return { token: secret, expiresAt: Date.now() + INVITE_MS };
}

export async function acceptInvitation(secret, username, displayName, password) {
  const invite = db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(hashToken(String(secret || '')));
  if (!invite || invite.used_at || invite.expires_at < Date.now()) throw new Error('This invitation is invalid or has expired.');
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(name)) throw new Error('Username must be 3–40 letters, numbers, dots, dashes or underscores.');
  const hash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    const actor = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(invite.created_by);
    if (!actor || !can(actor, 'manage_users') || (invite.role === 'admin' && actor.role !== 'admin')) {
      throw new Error('This invitation is no longer valid.');
    }
    const permissions = validPermissions(requestPolicy().defaultPermissions);
    canGrant(actor, permissions);
    const claimed = db.prepare('UPDATE invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?')
      .run(Date.now(), invite.token_hash, Date.now());
    if (!claimed.changes) throw new Error('This invitation has already been used.');
    const result = db.prepare('INSERT INTO users (username, display_name, role, password_hash, created_at, permissions) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, String(displayName || name).trim().slice(0, 80), invite.role, hash, Date.now(),
        JSON.stringify(permissions));
    db.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch (error) {
    db.exec('ROLLBACK');
    if (/UNIQUE constraint/.test(error.message)) throw new Error('That username is already taken.');
    throw error;
  }
}

export async function authenticate(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(username || '').trim());
  // Consume comparable work for unknown accounts to reduce username probing.
  const fallback = 'scrypt$invalid$' + Buffer.alloc(64).toString('base64url');
  const valid = await checkPassword(password, user?.password_hash || fallback);
  return valid ? user : null;
}

export function newSession(userId) {
  const secret = token();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(secret), Number(userId), Date.now() + SESSION_MS, Date.now());
  return { token: secret, maxAge: SESSION_MS };
}

export function sessionUser(secret) {
  if (!secret) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(hashToken(secret), Date.now()) || null;
}

export function revokeSession(secret) {
  if (secret) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(secret));
}

export async function changePassword(userId, current, replacement) {
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(Number(userId));
  if (!user || !await checkPassword(current, user.password_hash)) throw new Error('Current password is incorrect.');
  const hash = await hashPassword(replacement);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, Number(userId));
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(Number(userId));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all().map((user) => ({
    id: user.id, username: user.username, display_name: user.display_name, role: user.role,
    active: user.active, created_at: user.created_at, permissions: permissionsOf(user),
    requestLimitOverride: user.request_limit_override, allowance: requestAllowance(user),
  }));
}

function manageableUser(id, actorId) {
  const actor = activeManager(actorId);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(Number(id));
  if (!target) throw new Error('Account not found or access denied.');
  if (target.id === actor.id || (target.role === 'admin' && actor.role !== 'admin')) {
    throw new Error('You cannot change this account.');
  }
  return { actor, target };
}

export function setUserActive(id, actorId, active) {
  const { target } = manageableUser(id, actorId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, target.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function setUserPermissions(id, actorId, permissions, requestLimitOverride) {
  const { actor, target } = manageableUser(id, actorId);
  if (target.role === 'admin') throw new Error('Administrator permissions are fixed.');
  const granted = validPermissions(permissions);
  canGrant(actor, granted);
  const limit = validLimitOverride(requestLimitOverride);
  db.prepare('UPDATE users SET permissions=?, request_limit_override=? WHERE id=?')
    .run(JSON.stringify(granted), limit, target.id);
  return listUsers().find((user) => user.id === target.id);
}

const selectProposal = db.prepare(`SELECT p.*, u.display_name AS requester, d.display_name AS decided_by_name
  FROM proposals p JOIN users u ON u.id=p.user_id LEFT JOIN users d ON d.id=p.decided_by WHERE p.id=?`);
const selectParts = db.prepare('SELECT part_number AS number, issue_id AS issueId, dispatch_status AS dispatchStatus FROM proposal_parts WHERE proposal_id=? ORDER BY CAST(part_number AS REAL), part_number');
export function proposal(id) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId < 1) return null;
  const row = selectProposal.get(numericId);
  return row ? { ...row, parts: selectParts.all(row.id) } : null;
}

export function proposalsFor(user, pendingOnly = false) {
  const rows = can(user, 'manage_requests')
    ? db.prepare(`SELECT id FROM proposals ${pendingOnly ? "WHERE status='pending'" : ''} ORDER BY created_at DESC LIMIT 200`).all()
    : db.prepare('SELECT id FROM proposals WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id);
  return rows.map((row) => proposal(row.id));
}

export function submitProposal(userId, { kind, volumeId, title, publisher, partNumbers = [] }) {
  if (!['parts', 'follow'].includes(kind) || !/^\d+$/.test(String(volumeId))) throw new Error('Choose a valid volume.');
  const name = String(title || '').trim();
  if (!name || name.length > 240) throw new Error('Choose a named volume.');
  const numbers = [...new Set(partNumbers.map((part) => String(part).trim()))];
  if ((kind === 'parts' && !numbers.length) || numbers.length > 500 || numbers.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error('Choose one or more valid parts.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(Number(userId));
    if (!can(user, 'request')) throw new Error('Your account cannot submit requests.');
    const allowance = requestAllowance(user);
    const units = kind === 'follow' ? numbers.length + 1 : numbers.length;
    if (allowance.limit && allowance.used + units > allowance.limit) {
      throw new Error(`This request needs ${units} item${units === 1 ? '' : 's'}; you have ${allowance.remaining} left in this ${allowance.windowDays}-day window.`);
    }
    if (kind === 'follow') {
      const other = db.prepare(`SELECT id FROM proposals WHERE user_id=? AND kind='follow' AND volume_id=?
        AND status IN ('pending', 'approved', 'dispatching', 'active', 'attention') LIMIT 1`)
        .get(Number(userId), String(volumeId));
      if (other) throw new Error('You already follow or requested to follow this series.');
      if (numbers.length) {
        const overlapping = db.prepare(`SELECT i.part_number FROM proposal_parts i JOIN proposals p ON p.id=i.proposal_id
          WHERE p.user_id=? AND p.volume_id=?
            AND p.status IN ('pending', 'approved', 'dispatching', 'active', 'attention')
            AND i.part_number IN (SELECT value FROM json_each(?)) LIMIT 1`)
          .get(Number(userId), String(volumeId), JSON.stringify(numbers));
        if (overlapping) throw new Error(`Part ${overlapping.part_number} is already in one of your requests.`);
      }
    } else {
      const overlapping = db.prepare(`SELECT i.part_number FROM proposal_parts i JOIN proposals p ON p.id=i.proposal_id
        WHERE p.user_id=? AND p.volume_id=?
          AND p.status IN ('pending', 'approved', 'dispatching', 'active', 'attention')
          AND i.part_number IN (SELECT value FROM json_each(?)) LIMIT 1`)
        .get(Number(userId), String(volumeId), JSON.stringify(numbers));
      if (overlapping) throw new Error(`Part ${overlapping.part_number} is already in one of your requests.`);
    }
    const result = db.prepare(`INSERT INTO proposals (user_id, kind, volume_id, title, publisher, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(Number(userId), kind, String(volumeId), name, publisher || null, Date.now());
    const id = Number(result.lastInsertRowid);
    const insertPart = db.prepare('INSERT INTO proposal_parts (proposal_id, part_number) VALUES (?, ?)');
    for (const number of numbers) insertPart.run(id, number);
    db.prepare('INSERT INTO proposal_events (proposal_id, actor_id, action, at) VALUES (?, ?, ?, ?)')
      .run(id, Number(userId), 'submitted', Date.now());
    db.exec('COMMIT');
    return proposal(id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function changeProposal(id, from, to, actorId, reason = null) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`UPDATE proposals SET status=?, decided_at=CASE WHEN ? IN ('approved','rejected') THEN ? ELSE decided_at END,
      decided_by=CASE WHEN ? IN ('approved','rejected') THEN ? ELSE decided_by END, reason=? WHERE id=? AND status=?`)
      .run(to, to, Date.now(), to, Number(actorId), reason, Number(id), from);
    if (!result.changes) throw new Error('That request has already changed. Refresh and try again.');
    db.prepare('INSERT INTO proposal_events (proposal_id, actor_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
      .run(Number(id), Number(actorId), to, reason, Date.now());
    db.exec('COMMIT');
    return proposal(id);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function markPart(id, number, issueId, status) {
  db.prepare('UPDATE proposal_parts SET issue_id=COALESCE(?, issue_id), dispatch_status=? WHERE proposal_id=? AND part_number=?')
    .run(issueId || null, status, Number(id), String(number));
}

export function markAttention(id, error) {
  db.prepare("UPDATE proposals SET status='attention', last_error=? WHERE id=?").run(String(error).slice(0, 400), Number(id));
}

export function setFutureCutoff(id, cutoffDay) {
  db.prepare('UPDATE proposals SET future_cutoff_day=? WHERE id=?').run(String(cutoffDay), Number(id));
}

export function activeFutureFollows() {
  return db.prepare(`SELECT id, volume_id, future_cutoff_day FROM proposals
    WHERE kind='follow' AND status='active' AND future_cutoff_day IS NOT NULL`).all();
}

export function claimFutureDispatch(volumeId, issueId, proposalId) {
  const result = db.prepare(`INSERT OR IGNORE INTO future_dispatches
    (volume_id, issue_id, state, proposal_id, claimed_at) VALUES (?, ?, 'sending', ?, ?)`)
    .run(String(volumeId), String(issueId), Number(proposalId), Date.now());
  return Boolean(result.changes);
}

export function finishFutureDispatch(volumeId, issueId, state, error = null) {
  db.prepare(`UPDATE future_dispatches SET state=?, queued_at=CASE WHEN ? IN ('queued','handled') THEN ? ELSE queued_at END,
    last_error=? WHERE volume_id=? AND issue_id=?`)
    .run(state, state, Date.now(), error == null ? null : String(error).slice(0, 400), String(volumeId), String(issueId));
}

export function futureDispatches(volumeId) {
  return db.prepare(`SELECT issue_id, state, claimed_at, queued_at, last_error FROM future_dispatches
    WHERE volume_id=? ORDER BY claimed_at DESC`).all(String(volumeId));
}

export function retryFutureDispatch(volumeId, issueId, claimedAt) {
  // Only an explicit admin retry can reopen an uncertain handoff.
  return Boolean(db.prepare(`DELETE FROM future_dispatches WHERE volume_id=? AND issue_id=? AND state='sending' AND claimed_at=?`)
    .run(String(volumeId), String(issueId), claimedAt).changes);
}

export function activeFollows(volumeId, exceptId = null) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE kind='follow' AND volume_id=?
    AND status IN ('approved','dispatching','active','attention') AND id != ?`).get(String(volumeId), Number(exceptId) || -1).n);
}

export function managedFollow(volumeId) {
  return db.prepare('SELECT * FROM managed_follows WHERE volume_id=?').get(String(volumeId)) || null;
}

export function markManagedFollow(volumeId) {
  db.prepare('INSERT OR IGNORE INTO managed_follows (volume_id, created_at) VALUES (?, ?)')
    .run(String(volumeId), Date.now());
}

export function markManagedPaused(volumeId, paused) {
  db.prepare('UPDATE managed_follows SET paused=? WHERE volume_id=?').run(paused ? 1 : 0, String(volumeId));
}

export function activePartRequests(volumeId) {
  return Number(db.prepare(`SELECT COUNT(DISTINCT p.id) AS n FROM proposals p
    JOIN proposal_parts i ON i.proposal_id=p.id
    LEFT JOIN mylar_parts m ON m.comic_id=p.volume_id AND m.issue_id=i.issue_id
    WHERE p.kind='parts' AND p.volume_id=? AND p.status IN ('approved','dispatching','active','attention')
      AND (i.issue_id IS NULL OR m.status IS NULL OR m.status NOT IN ('Downloaded','Archived'))`).get(String(volumeId)).n);
}

export function requestFollowStop(id, userId) {
  const changed = db.prepare(`UPDATE proposals SET stop_requested_at=?
    WHERE id=? AND user_id=? AND kind='follow' AND status='active' AND stop_requested_at IS NULL`)
    .run(Date.now(), Number(id), Number(userId));
  if (!changed.changes) throw new Error('This follow is not active or its stop was already requested.');
  db.prepare('INSERT INTO proposal_events (proposal_id, actor_id, action, at) VALUES (?, ?, ?, ?)')
    .run(Number(id), Number(userId), 'stop-requested', Date.now());
  return proposal(id);
}
