// api/webhook-product.js
// Vérifie HMAC, traite products/create & products/update, tag + rename avec retry logic

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

// ------------ Low-level utils ------------
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

// ------------ Business utils ------------
function isZakekeProduct(p) {
  const pt = (p && p.product_type) || '';
  return /zakeke/i.test(pt);
}

function companyFromProTag(tag) {
  if (!tag) return '';
  const raw = String(tag).replace(/^pro[-_]?/i, '');
  return raw.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/**
 * Extrait le designId depuis le body_html du produit
 */
function extractDesignIdFromHtml(bodyHtml) {
  if (!bodyHtml) return null;
  
  // Chercher data-zakeke-design-id
  const match = bodyHtml.match(/data-zakeke-design-id=["']([^"']+)["']/i);
  if (match && match[1]) {
    return match[1];
  }
  
  // Fallback: chercher un pattern 000-xxxxx dans le HTML
  const fallbackMatch = bodyHtml.match(/000-[A-Za-z0-9]{20,}/);
  if (fallbackMatch) {
    return fallbackMatch[0];
  }
  
  return null;
}

/**
 * Recherche d'attribution avec 4 niveaux de fallback
 */
function findAttribution(productId, designId) {
  console.log('[webhook-product] 🔍 Recherche attribution:', { 
    productId, 
    designId,
    mapSizes: {
      productCustomerMap: global.productCustomerMap?.size || 0,
      designCustomerMap: global.designCustomerMap?.size || 0,
      sessionCustomerMap: global.sessionCustomerMap?.size || 0,
      activeProSessions: global.activeProSessions?.size || 0
    }
  });
  
  // NIVEAU 1: Recherche par productId
  if (productId && global.productCustomerMap?.has(String(productId))) {
    const attr = global.productCustomerMap.get(String(productId));
    console.log('[webhook-product] ✅ Trouvé via productCustomerMap');
    return { 
      customerTag: attr.customerTag, 
      customerId: attr.customerId,
      source: 'productCustomerMap' 
    };
  }

  // NIVEAU 2: Recherche par designId
  if (designId && global.designCustomerMap?.has(designId)) {
    const attr = global.designCustomerMap.get(designId);
    console.log('[webhook-product] ✅ Trouvé via designCustomerMap');
    return { 
      customerTag: attr.customerTag,
      customerId: attr.customerId,
      source: 'designCustomerMap' 
    };
  }

  // NIVEAU 3: Recherche par sessionId via recentDesignActivity
  if (designId && global.recentDesignActivity) {
    const recentActivity = Array.from(global.recentDesignActivity.values())
      .filter(a => a.designId === designId)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    
    if (recentActivity?.sessionId && global.sessionCustomerMap) {
      const sessionData = global.sessionCustomerMap.get(recentActivity.sessionId);
      if (sessionData?.customerTag) {
        console.log('[webhook-product] ✅ Trouvé via sessionCustomerMap');
        return {
          customerTag: sessionData.customerTag,
          customerId: sessionData.customerId,
          source: 'sessionCustomerMap'
        };
      }
    }
  }

  // NIVEAU 4: Fallback - Session Pro la plus récente (5 dernières minutes)
  if (global.activeProSessions && global.activeProSessions.size > 0) {
    const FIVE_MINUTES = 5 * 60 * 1000;
    const now = Date.now();
    
    const recentSessions = Array.from(global.activeProSessions.values())
      .filter(s => (now - s.lastActivity) < FIVE_MINUTES)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    
    if (recentSessions.length > 0) {
      const latest = recentSessions[0];
      console.log('[webhook-product] ⚠️ Trouvé via activeProSessions (fallback récent)');
      return {
        customerTag: latest.customerTag,
        customerId: latest.customerId,
        source: 'activeProSessions-fallback'
      };
    }
  }

  console.log('[webhook-product] ❌ Aucune attribution trouvée');
  return null;
}

async function getProduct(gid) {
  const q = `query($id: ID!){ 
    product(id:$id){ 
      id 
      title 
      tags 
      descriptionHtml
    } 
  }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}

async function updateProduct(gid, customerTag, rename = true) {
  const pd = await getProduct(gid);
  if (!pd) throw new Error('Produit introuvable');

  const existing = Array.isArray(pd.tags) ? pd.tags : [];
  
  // Retirer les tags temporaires et ajouter le tag client + zakeke-attributed
  const tagsToRemove = ['needs-attribution'];
  const cleanedTags = existing.filter(t => !tagsToRemove.includes(t));
  const nextTags = Array.from(new Set([...cleanedTags, customerTag, 'zakeke-attributed']));

  let nextTitle = pd.title;
  if (rename) {
    const comp = companyFromProTag(customerTag);
    if (comp && !nextTitle.includes(comp)) {
      nextTitle = `${nextTitle} - ${comp}`;
    }
  }

  // Rien à changer ?
  const nothingToDo = (
    existing.length === nextTags.length && 
    existing.every(t => nextTags.includes(t)) &&
    nextTitle === pd.title
  );
  
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
    throw new Error('productUpdate errors: ' + JSON.stringify(ue));
  }
  
  console.log('[webhook-product] ✅ Produit mis à jour:', {
    title: nextTitle,
    tags: nextTags
  });
  
  return res.productUpdate.product;
}

// ------------ Handler principal avec RETRY LOGIC ------------
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const raw = await readRawBody(req);
    const hOk = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
    
    if (!hOk) {
      console.warn('[webhook-product] ⚠️ HMAC invalide');
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    const topic = req.headers['x-shopify-topic'] || '';
    
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ 
        skipped: true, 
        reason: 'irrelevant-topic',
        topic 
      });
    }

    const body = JSON.parse(raw.toString('utf8'));
    
    console.log('[webhook-product] BODY COMPLET:', JSON.stringify(body, null, 2));
    
    console.log('[webhook-product] 🎯 Webhook reçu:', {
      topic,
      productId: body.id,
      title: body.title,
      type: body.product_type
    });

    if (!isZakekeProduct(body)) {
      return res.status(200).json({ 
        skipped: true, 
        reason: 'not-zakeke',
        productType: body.product_type 
      });
    }

    const productId = body.id;
    const productGid = `gid://shopify/Product/${productId}`;
    const designId = extractDesignIdFromHtml(body.body_html);
    
    console.log('[webhook-product] 📦 Produit Zakeke détecté:', {
      productId,
      designId: designId || 'NON TROUVÉ',
      bodyHtmlLength: body.body_html?.length || 0
    });

    // ✅ FONCTION DE RETRY AVEC DÉLAI
    async function findAttributionWithRetry(maxAttempts = 3, delayMs = 2000) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[webhook-product] 🔄 Tentative ${attempt}/${maxAttempts} de recherche d'attribution`);
        
        const attribution = findAttribution(productId, designId);
        
        if (attribution) {
          console.log(`[webhook-product] ✅ Attribution trouvée à la tentative ${attempt}`);
          return attribution;
        }
        
        // Si pas trouvé et qu'il reste des tentatives, attendre
        if (attempt < maxAttempts) {
          console.log(`[webhook-product] ⏳ Attente de ${delayMs}ms avant nouvelle tentative...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      
      console.log('[webhook-product] ❌ Aucune attribution trouvée après toutes les tentatives');
      return null;
    }

    // Recherche d'attribution avec retry (3 tentatives, 2 secondes entre chaque = max 6 secondes)
    const attribution = await findAttributionWithRetry(3, 2000);

    if (!attribution) {
      console.log('[webhook-product] ⚠️ Aucune attribution - marquage pour review manuel');
      
      // Marquer le produit avec un tag temporaire
      await updateProduct(productGid, 'needs-attribution', false);
      
      return res.status(200).json({ 
        skipped: true, 
        reason: 'no-attribution',
        productId,
        designId,
        message: 'Produit marqué pour attribution manuelle après retry'
      });
    }

    console.log('[webhook-product] ✅ Attribution trouvée:', {
      customerTag: attribution.customerTag,
      customerId: attribution.customerId,
      source: attribution.source
    });

    // Mise à jour du produit avec le tag client
    const updated = await updateProduct(productGid, attribution.customerTag, true);

    console.log('[webhook-product] 🎉 Produit tagué et renommé avec succès:', {
      productId,
      tag: attribution.customerTag,
      title: updated.title,
      source: attribution.source
    });

    return res.status(200).json({ 
      success: true, 
      productId, 
      tag: attribution.customerTag,
      source: attribution.source,
      title: updated.title
    });

  } catch (e) {
    console.error('[webhook-product] ❌ Erreur:', e);
    return res.status(500).json({ 
      error: 'server', 
      message: e.message,
      stack: process.env.NODE_ENV === 'development' ? e.stack : undefined
    });
  }
};
