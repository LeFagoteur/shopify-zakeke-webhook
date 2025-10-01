// api/webhook-product.js  (CommonJS, Node, Vercel)
// Vérifie HMAC correctement (base64), traite products/create & products/update, tag + rename.

const crypto = require('crypto');

const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_WEBHOOK_SECRET= process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-01';

exports.config = { 
  api: { 
    bodyParser: false 
  } 
};

// Lire le raw body (obligatoire pour HMAC)
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Comparaison timing-safe en base64
function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');

  // Éviter les erreurs de longueur
  const a = Buffer.from(digest, 'base64');
  const b = Buffer.from(hmacHeader, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
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

// Détecter Zakeke à coup sûr (create peut arriver en "provider-zakeke-product")
function isZakekeProduct(p) {
  const pt = (p && p.product_type) || '';
  return /zakeke/i.test(pt);
}

// "proMaSuperBoite" → "Ma Super Boite", "pro_scènes-d'oc" → "scènes-d'oc"
function companyFromProTag(tag) {
  if (!tag) return '';
  const raw = String(tag).replace(/^pro[-_]?/i, '');
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// Récupérer attribution (design → client) ou session Pro active
function findAttribution(designId) {
  // 1) mapping link-design-customer
  if (designId && global.designCustomerMap && global.designCustomerMap.has(designId)) {
    return global.designCustomerMap.get(designId);
  }
  // 2) session active
  if (global.activeProSessions) {
    // prend la plus récente
    let latest = null;
    for (const s of global.activeProSessions.values()) {
      if (!latest || s.lastActivity > latest.lastActivity) latest = s;
    }
    return latest || null;
  }
  return null;
}

async function getProduct(productGid) {
  const q = `query($id: ID!){ product(id:$id){ id title tags } }`;
  const data = await shopifyGraphQL(q, { id: productGid });
  return data.product;
}

async function updateProduct(productGid, customerTag, rename = true) {
  const pd = await getProduct(productGid);
  if (!pd) throw new Error('Produit introuvable');

  const existing = Array.isArray(pd.tags) ? pd.tags : [];
  const newTags = Array.from(new Set([...existing, customerTag]));

  let newTitle = pd.title;
  if (rename) {
    const comp = companyFromProTag(customerTag);
    if (comp && !newTitle.includes(comp)) newTitle = `${newTitle} - ${comp}`;
  }

  const m = `
    mutation($input: ProductInput!){
      productUpdate(input:$input){
        product{ id title tags }
        userErrors{ field message }
      }
    }`;
  const res = await shopifyGraphQL(m, { input: { id: productGid, tags: newTags, title: newTitle } });
  const ue = res.productUpdate.userErrors || [];
  if (ue.length) throw new Error('productUpdate errors: ' + JSON.stringify(ue));
  return res.productUpdate.product;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = await readRawBody(req);
    const ok = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
    if (!ok) {
      // Logs discrets pour debug (sans exposer le secret)
      console.warn('[webhook-product] HMAC invalid', {
        topic: req.headers['x-shopify-topic'],
        shop: req.headers['x-shopify-shop-domain']
      });
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    const topic = req.headers['x-shopify-topic'] || '';
    const body = JSON.parse(raw.toString('utf8'));

    // Shopify envoie id numérique dans webhook REST → on fabrique le GID
    const productId = body.id;
    const productGid = `gid://shopify/Product/${productId}`;

    if (!isZakekeProduct(body)) {
      return res.status(200).json({ skipped: true, reason: 'not-zakeke' });
    }

    // designId facultatif: tu peux l’extraire ici si tu le stockes en metafield/titre; sinon on s’en passe
    const designId = null; // placeholder si tu n’as pas un champ fiable à parser
    const attr = findAttribution(designId);

    if (!attr || !attr.customerTag) {
      // Pas de tag pro dispo → tu ne veux pas "needs-attribution"
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
