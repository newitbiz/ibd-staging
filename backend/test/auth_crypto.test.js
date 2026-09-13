import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signJwt, verifyJwt, randomOtpCode } from '../src/crypto_util.js';
import { hasAnyRole, ROLES, ALL_ROLES } from '../src/roles.js';

test('password hash verifies and rejects wrong password', async () => {
  const encoded = await hashPassword('DemoPass123!');
  assert.equal(await verifyPassword('DemoPass123!', encoded), true);
  assert.equal(await verifyPassword('WrongPass999!', encoded), false);
});

test('JWT signs and verifies with expiry', () => {
  const secret = 'test-secret-at-least-thirty-two-chars!!';
  const token = signJwt({ sub: 'user-1', roles: ['investor'], typ: 'access' }, secret, 60);
  const payload = verifyJwt(token, secret);
  assert.equal(payload.sub, 'user-1');
  assert.deepEqual(payload.roles, ['investor']);
  assert.equal(verifyJwt(token, 'other-secret-at-least-thirty-two-ch'), null);
});

test('OTP codes are six digits', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(randomOtpCode(), /^\d{6}$/);
  }
});

test('role catalog matches schema roles', () => {
  assert.deepEqual([...ALL_ROLES].sort(), [
    'auditor',
    'compliance_reviewer',
    'finance_officer',
    'investor',
    'project_owner',
    'project_reviewer',
    'super_admin',
    'support',
  ]);
  assert.equal(hasAnyRole([ROLES.INVESTOR], [ROLES.INVESTOR, ROLES.SUPER_ADMIN]), true);
  assert.equal(hasAnyRole([ROLES.SUPPORT], [ROLES.FINANCE_OFFICER]), false);
});
