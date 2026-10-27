// Manifest file: ~/.dsh/preset-manager/presets.json (DSH_HOME overrides ~/.dsh), written atomically.
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseManifest } from './engine/index.js';

export const home = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'preset-manager');
export const defaultManifestFile = () => join(home(), 'presets.json');
export const defaultAuditFile = () => join(home(), 'audit.jsonl');

/** Never throws: {ok, missing?, manifest?, errors, warnings}. A missing file is not an error (plugin stays inactive). */
export function loadManifest(file = defaultManifestFile()) {
  if (!existsSync(file)) return { ok: false, missing: true, errors: [], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: `cannot read ${file}: ${e.message}` }], warnings: [] };
  }
  return parseManifest(raw);
}

/** Validate first; only a valid manifest ever reaches disk (tmp + rename, so a crash leaves the old file). */
export function saveManifest(raw, file = defaultManifestFile()) {
  const parsed = parseManifest(raw);
  if (!parsed.ok) return parsed;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) copyFileSync(file, `${file}.prev`); // one level of rollback
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return parsed;
}

export const readRaw = (file = defaultManifestFile()) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
export const hasPrevious = (file = defaultManifestFile()) => existsSync(`${file}.prev`);
