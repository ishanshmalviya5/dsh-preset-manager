// Structured audit trail. Records names, rules and counts only: never tool arguments or results.
import { appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_STRING = 200;
const SAFE_KEYS = new Set(['agent', 'preset', 'capability', 'layer', 'rule', 'reason', 'argKeys', 'hidden', 'visible', 'tokens', 'from', 'to', 'count', 'ids', 'detail', 'dynamic', 'enabled', 'why']);

function clean(value) {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [k, clean(v)]));
  return value;
}

/** @param {{file?: string, capacity?: number, now?: () => number}} options */
export function createAudit({ file, capacity = 1000, now = Date.now } = {}) {
  const ring = [];
  return {
    record(type, fields = {}) {
      const event = { ts: now(), type };
      for (const [k, v] of Object.entries(fields)) if (SAFE_KEYS.has(k) && v !== undefined) event[k] = clean(v);
      ring.push(event);
      if (ring.length > capacity) ring.shift();
      if (file) {
        try {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
          chmodSync(file, 0o600);
        } catch { /* auditing must never break enforcement */ }
      }
      return event;
    },
    events: (filter) => ring.filter((e) => !filter || e.type === filter),
  };
}
