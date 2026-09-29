import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const { encryptToken, decryptToken, signState, verifyState, mergeBusy, googleConfigured, authUrl } =
  await import('./google.js');

test('config gate reports ready only when all three vars are present', () => {
  assert.equal(googleConfigured(), true);
});

test('a refresh token survives a round trip', () => {
  const tok = '1//0gLONGREFRESHTOKEN-with_odd.chars==';
  assert.equal(decryptToken(encryptToken(tok)), tok);
});

test('encryption is non-deterministic, so two rows never look alike', () => {
  const a = encryptToken('same'), b = encryptToken('same');
  assert.notEqual(a, b);
  assert.equal(decryptToken(a), decryptToken(b));
});

test('a tampered ciphertext is rejected rather than silently decrypted', () => {
  const packed = encryptToken('secret');
  const [iv, tag, data] = packed.split('.');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => decryptToken([iv, tag, flipped.toString('base64')].join('.')));
});

test('state round-trips and carries its payload', () => {
  const s = signState({ repId: 'abc', role: 'rep' });
  const back = verifyState(s);
  assert.equal(back.repId, 'abc');
  assert.equal(back.role, 'rep');
});

test('a forged or edited state is refused', () => {
  const s = signState({ repId: 'abc' });
  const [body] = s.split('.');
  assert.equal(verifyState(body + '.deadbeef'), null);
  assert.equal(verifyState('garbage'), null);
  assert.equal(verifyState(''), null);
});

test('an expired state is refused', () => {
  const s = signState({ repId: 'abc' }, -1000); // already expired
  assert.equal(verifyState(s), null);
});

test('auth url requests offline access and both calendar scopes', () => {
  const u = new URL(authUrl('https://example.com/cb', 'st'));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.com/cb');
  const scope = u.searchParams.get('scope');
  assert.ok(scope.includes('calendar.readonly'));
  assert.ok(scope.includes('calendar.events'));
});

test('overlapping busy blocks merge into one', () => {
  const out = mergeBusy([
    { start: '2026-10-01T14:00:00Z', end: '2026-10-01T15:00:00Z' },
    { start: '2026-10-01T14:30:00Z', end: '2026-10-01T16:00:00Z' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, '2026-10-01T14:00:00.000Z');
  assert.equal(out[0].end,   '2026-10-01T16:00:00.000Z');
});

test('the same meeting on two calendars collapses to one block', () => {
  const b = { start: '2026-10-01T14:00:00Z', end: '2026-10-01T15:00:00Z' };
  assert.equal(mergeBusy([b, { ...b }]).length, 1);
});

test('separate blocks stay separate, and touching blocks join', () => {
  const apart = mergeBusy([
    { start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' },
    { start: '2026-10-01T11:00:00Z', end: '2026-10-01T12:00:00Z' }
  ]);
  assert.equal(apart.length, 2);
  const touching = mergeBusy([
    { start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' },
    { start: '2026-10-01T10:00:00Z', end: '2026-10-01T11:00:00Z' }
  ]);
  assert.equal(touching.length, 1, 'back-to-back blocks are one continuous busy period');
});

test('malformed or inverted blocks are dropped, not trusted', () => {
  assert.deepEqual(mergeBusy([
    { start: 'nonsense', end: '2026-10-01T10:00:00Z' },
    { start: '2026-10-01T12:00:00Z', end: '2026-10-01T11:00:00Z' }, // ends before it starts
    null, undefined
  ].filter(Boolean)), []);
});
