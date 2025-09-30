// api/webhook-product.js
// Webhook Principal - Attribution des produits Zakeke aux clients Pro

const fetch = require('node-fetch');

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_API_VERSION = '2025-07';

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  
  const data = await response.json();
  if (data.errors) {
    console.error('❌ Erreur GraphQL:', data.errors);
    throw new Error(data.errors[0].message);
  }
  
  return data.data;
}

function isZakekeProduct(webhookData) {
  // Vérifications multiples pour identifier un produit Zakeke
  const checks = [
    webhookData.vendor === 'zakeke',
    webhookData.vendor === 'Zakeke',
    webhookData.product_type === 'zakeke-design',
    webhookData.title && webhookData.title.toLowerCase().includes('custom'),
    webhookData.title && webhookData.title.includes('Mug'),
    webhookData.tags && webhookData.tags.includes('zakeke'),
    webhookData.tags && webhookData.tags.includes('customized'),
    webhookData.body_html && webhookData.body_html.includes('data-zakeke'),
    webhookData.body_html && webhookData.body_html.includes('data-design'),
    webhookData.body_html && webhookData.body_html.includes('customization')
  ];
  
  const isZakeke = checks.some(check => check === true);
  
  console.log('🔍 Vérification Zakeke:', {
    vendor: webhookData.vendor,
    product_type: webhookData.product_type,
    title: webhookData.title,
    isZakeke: isZakeke
  });
  
  return isZakeke;
}

function extractDesignIdFromProduct(webhookData) {
  let designId = null;
  
  // Méthode 1: Depuis le HTML
  if (webhookData.body_html) {
    // Pattern: data-design="xxx"
    const match1 = webhookData.body_html.match(/data-design="([^"]+)"/);
    if (match1) {
      designId = match1[1];
      console.log('✅ DesignId trouvé dans data-design:', designId);
      return designId;
    }
    
    // Pattern: designDocID=xxx
    const match2 = webhookData.body_html.match(/designDocID=([^&\s"]+)/);
    if (match2) {
      designId = match2[1];
      console.log('✅ DesignId trouvé dans designDocID:', designId);
      return designId;
    }
    
    // Pattern: design_id ou designId
    const match3 = webhookData.body_html.match(/design[_-]?[iI]d["\s:=]+([a-zA-Z0-9-]+)/);
    if (match3) {
      designId = match3[1];
      console.log('✅ DesignId trouvé avec pattern flexible:', designId);
      return designId;
    }
  }
  
  // Méthode 2: Depuis les variantes
  if (webhookData.variants && webhookData.variants.length > 0) {
    const variant = webhookData.variants[0];
    if (variant.sku && variant.sku.includes('design-')) {
      designId = variant.sku;
      console.log('✅ DesignId trouvé dans SKU:', designId);
      return designId;
    }
  }
  
  console.log('⚠️ Aucun designId trouvé dans le produit');
  return null;
}

function findCustomerAttribution(designId) {
  console.log('🔎 Recherche attribution pour designId:', designId);
  
  // Méthode 1: Mapping direct design → customer
  if (designId && global.designCustomerMap && global.designCustomerMap[designId]) {
    const mapping = global.designCustomerMap[designId];
    const age = Date.now() - mapping.timestamp;
    
    // Vérifier que le mapping n'est pas trop vieux (max 15 minutes)
    if (age < 15 * 60 * 1000) {
      console.log('✅ Attribution trouvée via designId (age:', Math.floor(age/1000), 'secondes)');
      return {
        ...mapping,
        method: 'design_mapping',
        confidence: 'high'
      };
    } else {
      console.log('⚠️ Mapping trop vieux, ignoré (age:', Math.floor(age/1000), 'secondes)');
    }
  }
  
  // Méthode 2: Session Pro active la plus récente
  if (global.activeProSessions && global.activeProSessions.size > 0) {
    const now = Date.now();
    let mostRecent = null;
    let mostRecentTime = 0;
    
    // Convertir Map en Array pour parcourir
    const sessions = Array.from(global.activeProSessions.values());
    
    for (const session of sessions) {
      const sessionAge = now - session.lastActivity;
      
      // Session active dans les 5 dernières minutes
      if (sessionAge < 5 * 60 * 1000) {
        if (session.lastActivity > mostRecentTime) {
          mostRecentTime = session.lastActivity;
          mostRecent = session;
        }
      }
    }
    
    if (mostRecent) {
      console.log('✅ Attribution via session active:', mostRecent.customerEmail);
      return {
        customerId: mostRecent.customerId,
        customerEmail: mostRecent.customerEmail,
        customerTag: mostRecent.customerTag,
        companyName: mostRecent.companyName,
        method: 'active_session',
        confidence: 'medium'
      };
    }
  }
  
  // Méthode 3: Dernière activité de design (backup)
  if (global.recentDesignActivity && global.recentDesignActivity.length > 0) {
    const recentActivity = global.recentDesignActivity[global.recentDesignActivity.length - 1];
    const age = Date.now() - recentActivity.timestamp;
    
    // Activité dans les 10 dernières minutes
    if (age < 10 * 60 * 1000) {
      console.log('⚠️ Attribution via activité récente (moins précis)');
      return {
        ...recentActivity,
        method: 'recent_activity',
        confidence: 'low'
      };
    }
  }
  
  console.log('❌ Aucune attribution trouvée');
  return null;
}

async function updateProduct(productId, customerTag, companyName) {
  console.log('📝 Mise à jour du produit', productId, 'avec tag:', customerTag);
  
  try {
    // Récupérer le produit actuel
    const getProductQuery = `
      query getProduct($id: ID!) {
        product(id: $id) {
          title
          tags
        }
      }
    `;
    
    const productGid = `gid://shopify/Product/${productId}`;
    const productData = await shopifyGraphQL(getProductQuery, { id: productGid });
    
    if (!productData.product) {
      throw new Error('Produit non trouvé');
    }
    
    // Préparer les nouveaux tags (éviter les doublons)
    const existingTags = productData.product.tags || [];
    const newTags = Array.from(new Set([...existingTags, customerTag, 'zakeke-attributed']));
    
    // Modifier le titre (optionnel - ajouter le nom de l'entreprise)
    const currentTitle = productData.product.title;
    let newTitle = currentTitle;
    
    if (companyName && !currentTitle.includes(companyName)) {
      // Ajouter le nom de l'entreprise au titre
      newTitle = `${currentTitle} - ${companyName}`;
    }
    
    // Mettre à jour le produit
    const updateQuery = `
      mutation updateProduct($id: ID!, $input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    
    const result = await shopifyGraphQL(updateQuery, {
      id: productGid,
      input: {
        id: productGid,
        tags: newTags,
        title: newTitle
      }
    });
    
    if (result.productUpdate.userErrors && result.productUpdate.userErrors.length > 0) {
      throw new Error(result.productUpdate.userErrors[0].message);
    }
    
    console.log('✅ Produit mis à jour:', {
      id: productId,
      title: newTitle,
      tags: newTags
    });
    
    // Ajouter des métadonnées pour traçabilité
    try {
      const metafieldQuery = `
        mutation addMetafields($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      await shopifyGraphQL(metafieldQuery, {
        input: {
          id: productGid,
          metafields: [
            {
              namespace: "attribution",
              key: "customer_tag",
              value: customerTag,
              type: "single_line_text_field"
            },
            {
              namespace: "attribution",
              key: "company_name",
              value: companyName || "",
              type: "single_line_text_field"
            },
            {
              namespace: "attribution",
              key: "attribution_date",
              value: new Date().toISOString(),
              type: "single_line_text_field"
            }
          ]
        }
      });
      
      console.log('✅ Métadonnées ajoutées');
    } catch (metaError) {
      console.error('⚠️ Erreur métadonnées (non bloquant):', metaError.message);
    }
    
    return result.productUpdate.product;
    
  } catch (error) {
    console.error('❌ Erreur mise à jour produit:', error);
    throw error;
  }
}

// Handler principal
module.exports = async function handler(req, res) {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('🎯 WEBHOOK CRÉATION PRODUIT REÇU');
  console.log('═══════════════════════════════════════');
  console.log('🕒 Timestamp:', new Date().toISOString());
  
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const webhookData = req.body;
    
    console.log('📦 Produit reçu:', {
      id: webhookData.id,
      title: webhookData.title,
      vendor: webhookData.vendor,
      type: webhookData.product_type
    });
    
    // Vérifier si c'est un produit Zakeke
    if (!isZakekeProduct(webhookData)) {
      console.log('❌ Pas un produit Zakeke → Ignoré');
      return res.status(200).json({ 
        message: 'Not a Zakeke product',
        skipped: true 
      });
    }
    
    console.log('✅ Produit Zakeke confirmé');
    
    // Essayer d'extraire le designId
    const designId = extractDesignIdFromProduct(webhookData);
    
    // Afficher l'état du système pour debug
    console.log('📊 État du système:', {
      designMappings: global.designCustomerMap ? Object.keys(global.designCustomerMap).length : 0,
      activeSessions: global.activeProSessions ? global.activeProSessions.size : 0,
      recentActivity: global.recentDesignActivity ? global.recentDesignActivity.length : 0
    });
    
    // Trouver l'attribution client
    const attribution = findCustomerAttribution(designId);
    
    if (!attribution) {
      console.error('⚠️ AUCUNE ATTRIBUTION POSSIBLE');
      
      // Marquer le produit pour review manuel
      try {
        await updateProduct(webhookData.id, 'needs-attribution', '');
        console.log('📌 Produit marqué pour review manuel');
      } catch (e) {
        console.error('❌ Impossible de marquer le produit:', e.message);
      }
      
      return res.status(200).json({
        warning: 'No attribution found',
        productId: webhookData.id,
        flagged: true,
        designId: designId || 'not_found'
      });
    }
    
    console.log('👤 ATTRIBUTION RÉUSSIE:', {
      customer: attribution.customerEmail,
      company: attribution.companyName,
      method: attribution.method,
      confidence: attribution.confidence
    });
    
    // Appliquer le tag et mettre à jour le produit
    const updatedProduct = await updateProduct(
      webhookData.id,
      attribution.customerTag,
      attribution.companyName
    );
    
    console.log('🎉 SUCCÈS - Produit attribué et tagué');
    
    // Nettoyer le mapping utilisé (si c'était via designId)
    if (designId && global.designCustomerMap && global.designCustomerMap[designId]) {
      delete global.designCustomerMap[designId];
      console.log('🧹 Mapping design nettoyé');
    }
    
    console.log('═══════════════════════════════════════');
    console.log('');
    
    return res.status(200).json({
      success: true,
      product: {
        id: updatedProduct.id,
        title: updatedProduct.title,
        tags: updatedProduct.tags
      },
      attribution: {
        customer: attribution.customerEmail,
        company: attribution.companyName,
        method: attribution.method,
        confidence: attribution.confidence
      }
    });
    
  } catch (error) {
    console.error('❌ ERREUR WEBHOOK:', error);
    console.log('═══════════════════════════════════════');
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
};
