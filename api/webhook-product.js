// api/webhook-product.js
// No-op volontaire: on vérifie l'HMAC et on sort.
// Toute la logique d'attribution/tag/rename est gérée par /api/link-design-customer.

const crypto = require('crypto');

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody, hmacHeaderB64) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeaderB64) return false;
  const digestB64 = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digestB64, 'base64');
  const b = Buffer.from(hmacHeaderB64, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = await readRawBody(req);
    const hOk = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
    if (!hOk) return res.status(401).json({ error: 'Invalid HMAC' });

    const topic = req.headers['x-shopify-topic'] || '';
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ skipped: true, reason: 'irrelevant-topic', topic });
    }

    // On log juste de façon compacte pour audit
    try {
      const body = JSON.parse(raw.toString('utf8'));
      console.log('[webhook-product] ok', { topic, id: body?.id, type: body?.product_type, title: body?.title });
    } catch {
      console.log('[webhook-product] ok (no parse)', { topic });
    }

    return res.status(200).json({ ok: true, noop: true });
  } catch (e) {
    console.error('[webhook-product] error', e);
    return res.status(500).json({ error: 'server', message: e.message });
  }
};
