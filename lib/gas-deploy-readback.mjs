export const READBACK_MAX_ATTEMPTS = 6;
export const READBACK_INITIAL_DELAY_MS = 1000;
export const READBACK_MAX_DELAY_MS = 8000;

export function isVerifiedReadback(readback, expectedBundleHash) {
  return readback &&
    readback.liveBundleHash === expectedBundleHash &&
    readback.headBundleHash === expectedBundleHash;
}

export async function verifyWithReadback({ readback, expectedBundleHash, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxAttempts = READBACK_MAX_ATTEMPTS }) {
  let lastError = null;
  let lastReadback = null;
  let delayMs = READBACK_INITIAL_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await readback();
      lastReadback = value;
      if (isVerifiedReadback(value, expectedBundleHash)) {
        return { ...value, readbackAttempts: attempt };
      }
      lastError = new Error(`readback mismatch: live=${value?.liveBundleHash || 'missing'} head=${value?.headBundleHash || 'missing'}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, READBACK_MAX_DELAY_MS);
    }
  }

  const detail = lastError ? `; last_error=${lastError.message}` : '';
  const observed = lastReadback ? `; last_live=${lastReadback.liveBundleHash || 'missing'}; last_head=${lastReadback.headBundleHash || 'missing'}` : '';
  throw new Error(`verification-uncertain after ${maxAttempts} readback attempts${detail}${observed}`);
}
