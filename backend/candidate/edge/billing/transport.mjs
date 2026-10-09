import { BillingError, receiveStripeWebhook } from './core.mjs';
const response = (status, code) => new Response(JSON.stringify({ code }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function boundedRaw(request, maxBytes, timeoutMs) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) throw new BillingError('body_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BillingError('empty_body');
  let timer, total = 0;
  const chunks = [];
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new BillingError('body_timeout', 408)), timeoutMs); });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BillingError('body_too_large', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
// Host must separately supply verified endpoint-to-account binding and secret from its secret manager.
// This factory starts no listener, makes no provider call, and remains inactive by default.
export function createBillingWebhookHandler({ store, binding, signingSecret, enabled = false, clock = () => Math.floor(Date.now() / 1000), bodyTimeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 10000) throw new BillingError('invalid_body_timeout');
  return async request => {
    if (enabled !== true) return response(503, 'billing_inactive');
    if (request.method !== 'POST') return response(405, 'method_not_allowed');
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return response(415, 'json_required');
    try {
      const raw = await boundedRaw(request, 262144, bodyTimeoutMs);
      const result = await receiveStripeWebhook({ raw, signature: request.headers.get('stripe-signature'), secret: signingSecret,
        binding, now: clock(), store, enabled });
      return response(result.status, result.code);
    } catch (error) {
      // Never echo provider payload, SQL, customer details, signatures, or secret values.
      if (error instanceof BillingError) return response(error.status, error.code);
      return response(503, 'billing_store_unavailable');
    }
  };
}
