import { store } from './store.js';
import { config } from './config.js';

// One webhook per payer, mirroring push.js's one-subscription-per-worker
// model. Keyed by address so a re-registration overwrites the previous URL.
const WEBHOOK_PREFIX = 'payer-webhook:';

function webhookKey(payerAddress) {
  return WEBHOOK_PREFIX + payerAddress;
}

/**
 * Stores (or replaces) the webhook URL a payer wants notified when one of
 * their questions settles. Registration is gated by the caller (see the
 * /payers/:address/webhook route) on a valid session token for
 * payerAddress — a URL registered against an address you don't control
 * would leak someone else's settlement outcomes.
 */
export async function saveWebhook(payerAddress, url) {
  await store.set(webhookKey(payerAddress), { url, createdAt: Date.now() }, config.pendingQuestionTtlMs);
  return { url };
}

export async function getWebhook(payerAddress) {
  return store.get(webhookKey(payerAddress));
}

/**
 * Fire-and-forget POST of a settlement outcome to the payer's registered
 * webhook, mirroring push.js's notifyWorker(): delivery is a supplement to
 * the primary channel (GET /oracle/:jobId), never a replacement, so a
 * failing endpoint must never affect or delay settlement. Retry policy and
 * dead-letter handling are deliberately out of scope here (#154/#155).
 */
export async function notifyPayerWebhook(payerAddress, payload) {
  if (!payerAddress) return;
  const record = await getWebhook(payerAddress);
  if (!record?.url) return;

  try {
    await fetch(record.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Swallow: a down webhook endpoint must not affect settlement.
  }
}
