// Backend of the Settings page: POST /preset-manager-api/<action>, JSON in, {ok, value|error} out.
// Same guards as the other dsh settings plugins: dsh's own request check first, POST only, JSON only, small bodies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const API = '/preset-manager-api';
const MAX_BODY = 512 * 1024;
const MAX_MANIFEST_CHARS = 256 * 1024;

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const exampleFile = fileURLToPath(new URL('../examples/presets.json', import.meta.url));
export const loadExample = () => { try { return readFileSync(exampleFile, 'utf8'); } catch { return ''; } };

/** The editor sends text. Parse it here so a typo yields a precise message instead of a stack trace. */
function manifestFrom(body, { required = true } = {}) {
  const m = body.manifest;
  if (m === undefined && !required) return undefined;
  if (typeof m === 'object' && m !== null) return m;
  if (typeof m !== 'string' || m.trim() === '') throw new HttpError('manifest is empty');
  if (m.length > MAX_MANIFEST_CHARS) throw new HttpError('manifest is too large', 413);
  try { return JSON.parse(m); } catch (e) { throw new HttpError(`not valid JSON: ${e.message}`); }
}

const text = (v, name, max) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(`${name} must be a string of 1-${max} characters`);
  return v;
};

export function createActions(manager) {
  return {
    get: () => ({ ...manager.status(), metrics: manager.liveMetrics(), example: loadExample() }),
    validate(b) {
      let raw;
      try { raw = manifestFrom(b); } catch (e) { return { ok: false, errors: [{ path: '', message: e.message }], warnings: [] }; }
      return manager.validate(raw);
    },
    save(b) { return manager.apply(manifestFrom(b)); },
    rollback: () => manager.rollback(),
    reload: () => manager.reloadFromDisk(),
    dryrun(b) { return manager.dryRun(manifestFrom(b), text(b.agent ?? '*', 'agent', 128)); },
    explain(b) { return manager.explain(text(b.agent ?? '*', 'agent', 128), text(b.capability, 'capability', 600), manifestFrom(b, { required: false })); },
    audit: () => ({ events: manager.audit.events().slice(-100).reverse() }),
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new HttpError('body too large', 413)); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError('body must be a JSON object', 400)); }
    });
    req.on('error', reject);
  });
}

export function createHandler(actions, connection) {
  return async (req, res) => {
    if (typeof connection?.requestRejection !== 'function') return send(res, 503, { ok: false, error: 'dsh authentication unavailable' });
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
    if (rejection !== undefined) return send(res, rejection === 401 ? 401 : 403, { ok: false, error: 'refused by dsh' });
    const action = new URL(req.url, 'http://x').pathname.slice(API.length + 1);
    if (!Object.hasOwn(actions, action)) return send(res, 404, { ok: false, error: 'unknown action' });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'use POST' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { ok: false, error: 'send application/json' });
    try {
      send(res, 200, { ok: true, value: await actions[action](await readBody(req)) });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { ok: false, error: e instanceof HttpError ? e.message : 'internal error' }); // never leak internals
    }
  };
}
