// api/webhook-product.js  (CommonJS, Vercel Node runtime)
// Tag + renommage des produits Zakeke dès création/mise à jour
const crypto = require('crypto');

const SHOPIFY_ACCESS_TOKEN    = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN     = process.env.SHOPIFY_SHOP_DOMAIN;           // ex: tevdc6-0y.myshopify.com
const SHOPIFY_WEBHOOK_SECRET  = process.env.SHOPIFY_WEBHOOK_SECRET;        // Shared secret de l'app
const SHOPIFY_API_VERSION     = process.env.SHOPIFY_API_VERSION || '2025-01';

// Désactiver le bodyParser pour lire le RAW body (obligatoire pour HMAC)
module.exports.config = { api: { bodyParser: false } };

// -------- utils bas niveau --------
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody, hmacHeaderB64) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeaderB64) return false;
  const digestB64 = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
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

// -------- logique métier --------
function isZakekeProduct(p) {
  const pt = (p && p.product_type) || '';
  // couvre "provider-zakeke-product" puis "zakeke-design"
  return /zakeke/i.test(pt);
}

function companyFromProTag(tag) {
  if (!tag) return '';
  const raw = String(tag).replace(/^pro[-_]?/i, '');
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// Mapping en mémoire (venant de /api/link-design-customer) ou session Pro active (track-customer)
function findAttribution(designId) {
  if (designId && global.designCustomerMap?.has(designId)) {
    return global.designCustomerMap.get(designId);
  }
  if (global.activeProSessions && global.activeProSessions.size) {
    let latest = null;
    for (const s of global.activeProSessions.values()) {
      if (!latest || s.lastActivity > latest.lastActivity) latest = s;
    }
    return latest;
  }
  return null;
}

async function getProduct(gid) {
  const q = `query($id: ID!){ product(id:$id){ id title tags } }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}

async function updateProduct(gid, customerTag, rename = true) {
  const pd = await getProduct(gid);
  if (!pd) throw new Error('Produit introuvable');

  const existing = Array.isArray(pd.tags) ? pd.tags : [];
  const tags = Array.from(new Set([...existing, customerTag]));

  let title = pd.title;
  if (rename) {
    const comp = companyFromProTag(customerTag);
    if (comp && !title.includes(comp)) title = `${title} - ${comp}`;
  }

  const m = `
    mutation($input: ProductInput!){
      productUpdate(input:$input){
        product{ id title tags }
        userErrors{ field message }
      }
    }`;
  const res = await shopifyGraphQL(m, { input: { id: gid, tags, title } });
  const ue = res.productUpdate.userErrors || [];
  if (ue.length) throw new Error('productUpdate errors: ' + JSON.stringify(ue));
  return res.productUpdate.product;
}

// -------- handler --------
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = await readRawBody(req);
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const ok = verifyShopifyHmac(raw, hmacHeader);
    if (!ok) {
      console.warn('[webhook-product] HMAC invalid', {
        topic: req.headers['x-shopify-topic'],
        shop: req.headers['x-shopify-shop-domain']
      });
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    const topic = req.headers['x-shopify-topic'] || '';
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ skipped: true, reason: 'irrelevant-topic' });
    }

    const body = JSON.parse(raw.toString('utf8'));
    if (!isZakekeProduct(body)) {
      return res.status(200).json({ skipped: true, reason: 'not-zakeke' });
    }

    // Webhook REST: id numérique
    const productId = body.id;
    const productGid = `gid://shopify/Product/${productId}`;

    // Si tu n'as pas un champ sûr pour extraire designId du webhook, on s'appuie sur la session active.
    const designId = null;
    const attr = findAttribution(designId);

    if (!attr?.customerTag) {
      console.log('[webhook-product] no attribution, skip', { productId });
      return res.status(200).json({ skipped: true, reason: 'no-attribution' });
    }

    const updated = await updateProduct(productGid, attr.customerTag, true);
    console.log('[webhook-product] tagged/renamed', {
      productId,
      tag: attr.customerTag,
      title: updated.title
    });

    return res.status(200).json({ success: true, productId, tag: attr.customerTag });

  } catch (e) {
    console.error('[webhook-product] error', e);
    return res.status(500).json({ error: 'server', message: e.message });
  }
};
