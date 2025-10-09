// api/webhook-product.js
// Webhook Shopify (products/create & products/update)
// - Vérifie HMAC
// - Nettoie les tags parasites si présents (supprime uniquement "needs-attribution" et "zakeke-attributed")
// - NE RENOMME PAS, NE (RE)TAGUE PAS, NE DEVINE RIEN
// Tout le tagging/titre 1M/2M se fait dans /api/link-design-customer

const crypto = require('crypto');

const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_WEBHOOK_SECRET= process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-01';

exports.config = { api: { bodyParser: false } };

// --- utils bas niveau ---
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
function verifyShopifyHmac(rawBody, hmacHeaderB64) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeaderB64) return false;
  const digestB64 = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(digestB64, 'base64');
  const b = Buffer.from(hmacHeaderB64, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}
function isZakekeProduct(p) {
  const pt = (p && p.product_type) || '';
  return /zakeke/i.test(pt); // sécurité pour ne pas nettoyer tout le shop
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = await readRawBody(req);
    const ok = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
    if (!ok) {
      console.warn('[webhook-product] HMAC invalid', {
        topic: req.headers['x-shopify-topic'] || 'unknown',
        shop: req.headers['x-shopify-shop-domain'] || 'unknown'
      });
      return res.status(401).end('unauthorized');
    }

    const topic = req.headers['x-shopify-topic'] || '';
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ skipped: true, reason: 'irrelevant-topic', topic });
    }

    const body = JSON.parse(raw.toString('utf8'));
    const productId = body.id;
    const gid = `gid://shopify/Product/${productId}`;

    // optionnel: on ne nettoie que les produits Zakeke
    if (!isZakekeProduct(body)) {
      return res.status(200).json({ skipped: true, reason: 'not-zakeke', productType: body.product_type });
    }

    const currentTags = String(body.tags || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // on enlève seulement ces deux parasites
    const cleaned = currentTags.filter(t => t !== 'needs-attribution' && t !== 'zakeke-attributed');

    if (cleaned.length !== currentTags.length) {
      const m = `mutation($input: ProductInput!){
        productUpdate(input:$input){
          product{ id tags title }
          userErrors{ field message }
        }
      }`;
      try {
        await shopifyGraphQL(m, { input: { id: gid, tags: Array.from(new Set(cleaned)) } });
        console.log('[webhook-product] tags nettoyés', { productId, cleaned });
      } catch (e) {
        console.error('[webhook-product] update error', e);
        // on renvoie quand même 200 pour éviter le retry Shopify en boucle
      }
    } else {
      console.log('[webhook-product] rien à nettoyer', { productId });
    }

    // terminé: pas de rename, pas d’ajouts
    return res.status(200).end('ok');
  } catch (e) {
    console.error('[webhook-product] fatal', e);
    return res.status(500).json({ error: 'server', message: e.message });
  }
};
