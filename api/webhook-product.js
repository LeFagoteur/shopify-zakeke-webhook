// api/webhook-product.js
const crypto = require('crypto');

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_API_VERSION = '2025-01';

export const config = { api: { bodyParser: false } };

// util: lire le raw body
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || '', 'utf8'));
}

// ... garde ta fonction shopifyGraphQL mais enlève node-fetch et utilise fetch natif
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
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

// détecter Zakeke proprement: on s’en tient au vrai signal
function isZakekeProduct(p) {
  return p?.product_type === 'zakeke-design' || /zakeke/i.test(p?.vendor || '');
}

// util: format "proMaisonDuSoleil" → "Maison Du Soleil"
function companyFromProTag(tag) {
  if (!tag) return '';
  const raw = tag.replace(/^pro[-_]?/i, '');
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// … garde tes helpers extractDesignIdFromProduct / findCustomerAttribution / updateProduct
// mais simplifie updateProduct pour ne taguer QUE le tag pro et renommer optionnellement
async function updateProduct(productId, customerTag, rename = true) {
  const getQuery = `query($id: ID!){ product(id:$id){ title tags } }`;
  const gid = `gid://shopify/Product/${productId}`;
  const pd = await shopifyGraphQL(getQuery, { id: gid });
  if (!pd.product) throw new Error('Produit non trouvé');

  const existing = pd.product.tags || [];
  const newTags = Array.from(new Set([...existing, customerTag])); // pas de doublons

  let newTitle = pd.product.title;
  if (rename) {
    const company = companyFromProTag(customerTag);
    if (company && !newTitle.includes(company)) newTitle = `${newTitle} - ${company}`;
  }

  const updateMutation = `
    mutation($input: ProductInput!){
      productUpdate(input:$input){
        product{ id title tags }
        userErrors{ field message }
      }
    }`;
  const result = await shopifyGraphQL(updateMutation, {
    input: { id: gid, tags: newTags, title: newTitle }
  });
  return result.productUpdate.product;
}

module.exports = async function handler(req, res) {
  // HMAC
  const raw = await readRawBody(req);
  const ok = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
  if (!ok) return res.status(401).json({ error: 'Invalid HMAC' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const webhookData = JSON.parse(raw.toString('utf8'));
  if (!isZakekeProduct(webhookData)) return res.status(200).json({ skipped: true });

  // designId si dispo (ton extract existant)
  const designId = extractDesignIdFromProduct(webhookData);

  // attribution: d’abord mapping design, sinon session Pro active récente
  const attr = findCustomerAttribution(designId);
  if (!attr) {
    // tu as dit « pas besoin de needs-attribution » → on log et on sort
    console.log('Aucune attribution trouvée, on ignore proprement.');
    return res.status(200).json({ skipped: true, reason: 'no-attribution' });
  }

  const product = await updateProduct(webhookData.id, attr.customerTag, true);
  return res.status(200).json({ success: true, product });
};
