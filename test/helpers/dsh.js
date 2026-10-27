// Resolve the installed dsh packages at runtime: DSH_PKG_DIR, else the global npm root. Never hardcode a path.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function dshRoot() {
  if (process.env.DSH_PKG_DIR) return process.env.DSH_PKG_DIR;
  return join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh');
}

const req = createRequire(join(dshRoot(), 'package.json'));
export const dshImport = (name) => import(pathToFileURL(req.resolve(name)).href);
export const dshVersion = () => req('./package.json').version;
