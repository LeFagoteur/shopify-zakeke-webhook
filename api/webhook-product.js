// api/webhook-product.js  (CommonJS, Node, Vercel)
// Version corrigée pour utiliser designCustomerMap au lieu de productCustomerMap

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

// ------------ low-level utils ------------
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

// ------------ business utils ------------
function isZakekeProduct(p) {
  const pt = (p && p.product_type) || '';
  const vendor = (p && p.vendor) || '';
  const title = (p && p.title) || '';
  
  // Plus de critères pour détecter Zakeke
  return /zakeke/i.test(pt) || 
         /zakeke/i.test(vendor) || 
         /custom/i.test(title) ||
         /mug/i.test(title); // Vos produits sont des mugs
}

function companyFromProTag(tag) {
  if (!tag) return '';
  const raw = String(tag).replace(/^pro[-_]?/i, '');
  return raw.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

// Extraire designId du HTML ou d'autres sources
function extractDesignId(webhookData) {
  // Du body HTML
  if (webhookData.body_html) {
    const patterns = [
      /data-design="([^"]+)"/,
      /designDocID=([^&\s"]+)/,
      /design[_-]?id["\s:=]+([a-zA-Z0-9-]+)/i
    ];
    
    for (const pattern of patterns) {
      const match = webhookData.body_html.match(pattern);
      if (match && match[1]) {
        console.log('[webhook-product] DesignId trouvé dans HTML:', match[1]);
        return match[1];
      }
    }
  }
  
  // Du SKU des variants
  if (webhookData.variants && webhookData.variants[0]) {
    const sku = webhookData.variants[0].sku;
    if (sku && sku.includes('design-')) {
      console.log('[webhook-product] DesignId trouvé dans SKU:', sku);
      return sku;
    }
  }
  
  return null;
}

// CORRIGÉ : Chercher dans les bonnes sources
function findAttributionForProduct(productId, designId) {
  console.log('[webhook-product] Recherche attribution pour:', {
    productId: productId,
    designId: designId || 'non trouvé'
  });
  
  // Log de l'état du système
  console.log('[webhook-product] État système:', {
    designCustomerMap: global.designCustomerMap ? 
      (global.designCustomerMap.size || Object.keys(global.designCustomerMap).length || 0) : 0,
    activeProSessions: global.activeProSessions ? global.activeProSessions.size : 0,
    productCustomerMap: global.productCustomerMap ? global.productCustomerMap.size : 0
  });
  
  // 1) Chercher par designId dans designCustomerMap
  if (designId && global.designCustomerMap) {
    // Si c'est une Map
    if (global.designCustomerMap.has && typeof global.designCustomerMap.has === 'function') {
      if (global.designCustomerMap.has(designId)) {
        const attr = global.designCustomerMap.get(designId);
        console.log('[webhook-product] ✅ Trouvé via designCustomerMap (Map):', attr.customerTag);
        return attr;
      }
    }
    // Si c'est un Object
    else if (global.designCustomerMap[designId]) {
      const attr = global.designCustomerMap[designId];
      console.log('[webhook-product] ✅ Trouvé via designCustomerMap (Object):', attr.customerTag);
      return attr;
    }
  }
  
  // 2) Chercher par productId si on a un mapping productId -> customer
  if (productId && global.productCustomerMap) {
    const productIdStr = String(productId);
    if (global.productCustomerMap.has && global.productCustomerMap.has(productIdStr)) {
      const attr = global.productCustomerMap.get(productIdStr);
      console.log('[webhook-product] ✅ Trouvé via productCustomerMap:', attr.customerTag);
      return attr;
    }
  }
  
  // 3) Session Pro active la plus récente (dans les 5 dernières minutes)
  if (global.activeProSessions && global.activeProSessions.size > 0) {
    const now = Date.now();
    let latest = null;
    
    for (const session of global.activeProSessions.values()) {
      const age = now - session.lastActivity;
      if (age < 5 * 60 * 1000) { // 5 minutes
        if (!latest || session.lastActivity > latest.lastActivity) {
          latest = session;
        }
      }
    }
    
    if (latest) {
      console.log('[webhook-product] ✅ Trouvé via session active:', latest.customerTag);
      return latest;
    }
  }
  
  // 4) Activité de design récente
  if (global.recentDesignActivity && Array.isArray(global.recentDesignActivity)) {
    const recent = global.recentDesignActivity[global.recentDesignActivity.length - 1];
    if (recent && (Date.now() - recent.timestamp < 10 * 60 * 1000)) {
      console.log('[webhook-product] ✅ Trouvé via activité récente:', recent.customerTag);
      return recent;
    }
  }
  
  console.log('[webhook-product] ❌ Aucune attribution trouvée');
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
  const nextTags = Array.from(new Set([...existing, customerTag, 'zakeke-attributed']));

  let nextTitle = pd.title;
  if (rename) {
    const comp = companyFromProTag(customerTag);
    if (comp && !nextTitle.includes(comp)) {
      nextTitle = `${nextTitle} - ${comp}`;
    }
  }

  // Rien à changer ?
  const nothingToDo = (existing.length === nextTags.length) && (nextTitle === pd.title);
  if (nothingToDo) {
    console.log('[webhook-product] Produit déjà à jour');
    return pd;
  }

  const m = `mutation($input: ProductInput!){
    productUpdate(input:$input){
      product{ id title tags }
      userErrors{ field message }
    }
  }`;
  
  const res = await shopifyGraphQL(m, { 
    input: { 
      id: gid, 
      tags: nextTags, 
      title: nextTitle 
    } 
  });
  
  const ue = (res.productUpdate && res.productUpdate.userErrors) || [];
  if (ue.length) {
    console.error('[webhook-product] productUpdate userErrors', ue);
    throw new Error('productUpdate errors');
  }
  
  return res.productUpdate.product;
}

// ------------ handler ------------
module.exports = async function handler(req, res) {
  console.log('\n═══════════════════════════════════════');
  console.log('🎯 WEBHOOK PRODUCT REÇU');
  console.log('═══════════════════════════════════════');
  
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const raw = await readRawBody(req);
    const hOk = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
    
    if (!hOk) {
      console.warn('[webhook-product] HMAC invalid');
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    const topic = req.headers['x-shopify-topic'] || '';
    console.log('[webhook-product] Topic:', topic);
    
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ skipped: true, reason: 'irrelevant-topic' });
    }

    const body = JSON.parse(raw.toString('utf8'));
    
    console.log('[webhook-product] Produit:', {
      id: body.id,
      title: body.title,
      vendor: body.vendor,
      type: body.product_type
    });
    
    if (!isZakekeProduct(body)) {
      console.log('[webhook-product] Pas Zakeke, ignoré');
      return res.status(200).json({ skipped: true, reason: 'not-zakeke' });
    }

    const productId = body.id;
    const productGid = `gid://shopify/Product/${productId}`;
    
    // IMPORTANT : Extraire le designId
    const designId = extractDesignId(body);
    
    // Chercher l'attribution avec BOTH productId ET designId
    const attr = findAttributionForProduct(productId, designId);
    
    if (!attr || !attr.customerTag) {
      console.log('[webhook-product] ❌ Aucune attribution disponible');
      
      // Optionnel : marquer pour review
      try {
        await updateProduct(productGid, 'needs-attribution', false);
        console.log('[webhook-product] Produit marqué pour review manuel');
      } catch (e) {
        console.error('[webhook-product] Impossible de marquer:', e.message);
      }
      
      return res.status(200).json({ 
        skipped: true, 
        reason: 'no-attribution',
        productId: productId,
        designId: designId || 'not-found'
      });
    }

    // Mettre à jour le produit
    const updated = await updateProduct(productGid, attr.customerTag, true);
    
    console.log('[webhook-product] ✅ SUCCÈS - Produit tagué:', {
      productId: productId,
      tag: attr.customerTag,
      title: updated.title
    });
    
    // Nettoyer le mapping utilisé
    if (designId && global.designCustomerMap) {
      if (typeof global.designCustomerMap.delete === 'function') {
        global.designCustomerMap.delete(designId);
      } else if (global.designCustomerMap[designId]) {
        delete global.designCustomerMap[designId];
      }
      console.log('[webhook-product] Mapping design nettoyé');
    }
    
    console.log('═══════════════════════════════════════\n');
    
    return res.status(200).json({ 
      success: true, 
      productId: productId, 
      tag: attr.customerTag,
      title: updated.title
    });

  } catch (e) {
    console.error('[webhook-product] ERREUR:', e);
    console.log('═══════════════════════════════════════\n');
    return res.status(500).json({ 
      error: 'server', 
      message: e.message 
    });
  }
};
