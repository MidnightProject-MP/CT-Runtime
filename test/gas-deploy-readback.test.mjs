import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerifiedReadback, verifyWithReadback, READBACK_MAX_ATTEMPTS } from '../lib/gas-deploy-readback.mjs';

const HASH = 'a'.repeat(64);

function plan(liveBundleHash = HASH, headBundleHash = HASH) {
  return { status: 'planned', liveVersion: '86', liveBundleHash, headBundleHash };
}

test('readback succeeds immediately when live and HEAD match', async () => {
  let calls = 0;
  const result = await verifyWithReadback({
    readback: async () => { calls++; return plan(); },
    expectedBundleHash: HASH,
    sleep: async () => assert.fail('sleep should not be called')
  });
  assert.equal(calls, 1);
  assert.equal(result.liveVersion, '86');
  assert.equal(result.readbackAttempts, 1);
});

test('non-JSON/readback errors are retried without invoking mutation', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await verifyWithReadback({
    readback: async () => {
      calls++;
      if (calls < 3) throw new Error('invalid JSON response');
      return plan();
    },
    expectedBundleHash: HASH,
    sleep: async (ms) => sleeps.push(ms)
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(result.readbackAttempts, 3);
});

test('a transient hash mismatch is retried and then accepted', async () => {
  let calls = 0;
  const result = await verifyWithReadback({
    readback: async () => {
      calls++;
      return calls < 2 ? plan('b'.repeat(64), 'b'.repeat(64)) : plan();
    },
    expectedBundleHash: HASH,
    sleep: async () => {}
  });
  assert.equal(calls, 2);
  assert.equal(result.readbackAttempts, 2);
});

test('readback stops at the bounded attempt count and fails uncertain', async () => {
  let calls = 0;
  await assert.rejects(
    verifyWithReadback({
      readback: async () => { calls++; throw new Error('invalid JSON response'); },
      expectedBundleHash: HASH,
      sleep: async () => {}
    }),
    /verification-uncertain after 6 readback attempts/
  );
  assert.equal(calls, READBACK_MAX_ATTEMPTS);
});

test('verification requires both live and HEAD to match', () => {
  assert.equal(isVerifiedReadback(plan(), HASH), true);
  assert.equal(isVerifiedReadback(plan('b'.repeat(64), HASH), HASH), false);
  assert.equal(isVerifiedReadback(plan(HASH, 'b'.repeat(64)), HASH), false);
});
