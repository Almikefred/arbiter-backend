'use strict';

const assert = require('assert');
const { backoffDelayMs } = require('../src/webhookDelivery');

// Issue #328: the 20% random jitter on exponential backoff was not asserted
// to stay within bounds across many random() draws. These tests pin the
// documented behavior so future audits can treat the area as reviewed.

describe('backoffDelayMs jitter bounds', () => {
  const BASE = 1000;
  const MAX_ATTEMPTS = 10;

  it('stays within +/-20% of the exponential base across many draws', () => {
    const originalRandom = Math.random;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const base = BASE * Math.pow(2, attempt);
        const lower = base * 0.8;
        const upper = base * 1.2;

        for (let i = 0; i < 1000; i++) {
          const delay = backoffDelayMs(attempt, BASE);
          assert.ok(
            delay >= lower && delay <= upper,
            `attempt ${attempt}: delay ${delay} outside [${lower}, ${upper}]`
          );
        }
      }
    } finally {
      Math.random = originalRandom;
    }
  });

  it('respects the jitter bounds at the random() extremes', () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      assert.strictEqual(backoffDelayMs(0, BASE), BASE * 0.8);

      Math.random = () => 1;
      assert.strictEqual(backoffDelayMs(0, BASE), BASE * 1.2);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('grows exponentially with the attempt number', () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.5;
      const first = backoffDelayMs(0, BASE);
      const second = backoffDelayMs(1, BASE);
      const third = backoffDelayMs(2, BASE);

      assert.strictEqual(first, BASE);
      assert.strictEqual(second, BASE * 2);
      assert.strictEqual(third, BASE * 4);
    } finally {
      Math.random = originalRandom;
    }
  });
});
