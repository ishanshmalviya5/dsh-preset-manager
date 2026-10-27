// Glob matching for capability names: `*` = any run of characters, `?` = one character. Nothing else is special.
// Not a regex language on purpose: a manifest is data and must not be able to cause pathological backtracking.
export const MAX_PATTERN_LENGTH = 256;
export const MAX_WILDCARDS = 8;

const cache = new Map();

export function patternProblem(p) {
  if (typeof p !== 'string' || p.length === 0) return 'must be a non-empty string';
  if (p.length > MAX_PATTERN_LENGTH) return `longer than ${MAX_PATTERN_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'contains control characters';
  if ((p.match(/\*/g) ?? []).length > MAX_WILDCARDS) return `more than ${MAX_WILDCARDS} wildcards`;
  return undefined;
}

export const isPattern = (p) => /[*?]/.test(p);

function compile(p) {
  let re = cache.get(p);
  if (!re) {
    const body = [...p].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
    re = new RegExp(`^${body}$`, 's');
    cache.set(p, re);
  }
  return re;
}

export const matches = (pattern, name) => compile(pattern).test(name);

/** The first pattern that matches `name`, or undefined. */
export function matchAny(patterns, name) {
  for (const p of patterns) if (matches(p, name)) return p;
  return undefined;
}
