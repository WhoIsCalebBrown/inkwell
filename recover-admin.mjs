// Emergency local recovery for an existing owner. It deliberately accepts no
// command-line arguments, so a password cannot land in a shell history, ps
// output, or container environment.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './membership.js';
import { applicationDb as db, close } from './store.js';

export async function recoverAdmin(username, replacement) {
  const name = String(username || '').trim();
  const hash = await hashPassword(replacement);
  db.exec('BEGIN IMMEDIATE');
  try {
    const admin = db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(name);
    if (!admin) throw new Error('Only an existing administrator account can be recovered.');
    db.prepare("UPDATE users SET password_hash=?, active=1 WHERE id=? AND role='admin'").run(hash, admin.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(admin.id);
    db.exec('COMMIT');
    return { id: admin.id, username: admin.username };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function hiddenQuestion(prompt) {
  if (!stdin.isTTY) throw new Error('Run this command in an interactive terminal. Passwords are never read from arguments or environment variables.');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise((resolve, reject) => {
    const done = (error, answer) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error); else resolve(answer);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return done(new Error('Recovery cancelled.'));
        if (character === '\r' || character === '\n') return done(null, value);
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
        } else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  if (!stdin.isTTY) throw new Error('Run this command in an interactive terminal. Passwords are never read from arguments or environment variables.');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const username = await prompt.question('Existing admin username: ');
    prompt.close();
    stdout.write('The selected administrator will be reactivated and all of its sessions will end.\n');
    const password = await hiddenQuestion('New password (5–256 characters): ');
    const confirm = await hiddenQuestion('Confirm new password: ');
    if (password !== confirm) throw new Error('Passwords do not match.');
    const admin = await recoverAdmin(username, password);
    stdout.write(`Recovered administrator ${admin.username}. Sign in with the new password.\n`);
  } finally {
    prompt.close();
    close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
