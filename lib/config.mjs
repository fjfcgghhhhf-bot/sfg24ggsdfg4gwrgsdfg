import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadConfiguration(directory, environment = process.env) {
  let secret = environment.SESSION_SECRET;
  if (environment.NODE_ENV === 'production') {
    if (!secret) throw new Error('Production requires SESSION_SECRET environment variables.');
  } else if (!secret) {
    const filename = path.join(directory, '.local-secrets.json');
    let saved;
    try { saved = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!saved) {
      saved = { SESSION_SECRET: randomBytes(32).toString('hex') };
      try { await writeFile(filename, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        saved = JSON.parse(await readFile(filename, 'utf8'));
      }
    }
    secret ||= saved.SESSION_SECRET;
  }
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  return { secret };
}
