import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The portal serves pages the manager stored, under the same headers, so the
// two copies of these files must not drift.
test('sanitize.js and core.js helpers match the Portal Manager copies', () => {
  const here = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const there = (p) => readFileSync(new URL(`../../portal-manager/${p}`, import.meta.url), 'utf8');
  assert.equal(here('lib/sanitize.js'), there('lib/sanitize.js'));
  const strip = (s) => s.replace(/^\/\/ Kept in step[^\n]*\n\/\/[^\n]*\n/, '').replace(/Client portal backend|Portal backend/g, 'X').replace(/'portal route failed'|'portal-manager route failed'/g, 'Y');
  assert.equal(strip(here('lib/core.js')), strip(there('lib/core.js')));
});
