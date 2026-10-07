import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadConfiguration(directory, environment = process.env) {
  let secret = environment.SESSION_SECRET;
  let goalCode = environment.GOAL_CODE;
  if (environment.NODE_ENV === 'production') {
    if (!secret || !goalCode) throw new Error('Production requires SESSION_SECRET and GOAL_CODE environment variables.');
  } else if (!secret || !goalCode) {
    const filename = path.join(directory, '.local-secrets.json');
    let saved;
    try { saved = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!saved) {
      saved = { SESSION_SECRET: randomBytes(32).toString('hex'), GOAL_CODE: String(randomInt(1_000_000_000, 10_000_000_000)) };
      try { await writeFile(filename, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        saved = JSON.parse(await readFile(filename, 'utf8'));
      }
    }
    secret ||= saved.SESSION_SECRET;
    goalCode ||= saved.GOAL_CODE;
  }
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  if (!/^[0-9]{10}$/.test(goalCode)) throw new Error('GOAL_CODE must be exactly ten digits.');
  return { secret, goalCode };
}
