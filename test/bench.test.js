import test from 'node:test';
import assert from 'node:assert/strict';
import { bench, catalog } from '../bench/context.mjs';

test('benchmark: real catalog, exact wire bytes, discover cost included, every example preset saves context', () => {
  const r = bench();
  assert.equal(r.tools, 25);
  assert.equal(catalog.length, 25);
  assert.equal(r.unrestricted.bytes, 19629, 'matches the bytes the real host sent to the model');
  assert.ok(r.discover.bytes > 500 && r.discover.bytes < 2500, 'the discover tool is counted, and is small');
  assert.deepEqual(r.rows.map((x) => x.agent).sort(), ['minimal', 'standard']);
  for (const row of r.rows) {
    assert.ok(row.bytes < r.unrestricted.bytes, `${row.preset} must cost less than unrestricted`);
    assert.ok(row.bytes > r.discover.bytes, 'and still include its primary tools');
    assert.equal(row.counts.primary + row.counts.secondary + row.counts.tertiary + row.counts.denied, 25);
  }
  const reviewer = r.rows.find((x) => x.preset === 'reviewer');
  assert.ok(reviewer.savedPct > 70);
});
