const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  console.log('🌍 Domaine Shopify chargé :', process.env.SHOPIFY_SHOP_DOMAIN);

  // 👉 Gérer CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://studio.lefagoteur.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Si requête OPTIONS (pré-vol), répondre direct
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Log complet des données reçues
  console.log('📦 Données complètes reçues:', JSON.stringify(req.body, null, 2));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🎯 Webhook Zakeke reçu !');

    const product = req.body;
    
    if (isZakekeProduct(product)) {
      console.log('✅ Produit Zakeke détecté !');
      
      // NOUVELLE MÉTHODE PRIORITAIRE: Chercher dans les checkouts récents
      const checkoutTag = await getCustomerTagFromRecentCheckouts();
      if (checkoutTag.found) {
        console.log('🎯 Tag trouvé dans checkout:', checkoutTag.tag);
        
        // Ajouter le tag au produit
        await addProductTag(product.id, checkoutTag.tag);
        
        return res.status(200).json({ 
          status: 'success', 
          processed: true,
          productId: product.id,
          customerInfo: checkoutTag,
          message: 'Tag client ajouté avec succès (via checkout)'
        });
      }
      
      // MÉTHODE 2: Chercher dans la map globale (si vous utilisez link-design-customer)
      const designId = extractDesignIdFromProduct(product);
      if (designId && global.designCustomerMap?.[designId]) {
        const customerData = global.designCustomerMap[designId];
        console.log('🎯 Association trouvée dans la map:', customerData);
        
        await addProductTag(product.id, customerData.customerTag);
        delete global.designCustomerMap[designId];
        
        return res.status(200).json({ 
          status: 'success', 
          processed: true,
          productId: product.id,
          customerInfo: {
            found: true,
            customerId: customerData.customerId,
            tag: customerData.customerTag,
            source: 'design_map'
          },
          message: 'Tag client ajouté avec succès (via map)'
        });
      }
      
      // MÉTHODE 3: Méthodes originales
      const customerInfo = await extractCustomerFromZakeke(product);
      
      if (customerInfo.found) {
        console.log('🏷️ Tag à ajouter:', customerInfo.tag);
        await addProductTag(product.id, customerInfo.tag);
        
        return res.status(200).json({ 
          status: 'success', 
          processed: true,
          productId: product.id,
          customerInfo: customerInfo,
          message: 'Tag client ajouté avec succès'
        });
      } else {
        console.log('❌ Impossible de trouver le client pour ce produit');
        return res.status(200).json({ 
          status: 'success', 
          processed: false,
          message: 'Client non trouvé'
        });
      }
    }

    return res.status(200).json({ 
      status: 'success', 
      processed: false,
      message: 'Produit non-Zakeke'
    });

  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// NOUVELLE FONCTION: Récupérer le tag depuis les checkouts récents
async function getCustomerTagFromRecentCheckouts() {
  try {
    console.log('🔍 Recherche dans les checkouts récents...');
    
    // Essayer d'abord les checkouts abandonnés
    const checkoutsResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/checkouts.json?limit=10&created_at_min=${new Date(Date.now() - 3600000).toISOString()}`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    if (checkoutsResponse.ok) {
      const data = await checkoutsResponse.json();
      console.log('🛒 Checkouts trouvés:', data.checkouts?.length || 0);
      
      // Chercher le checkout le plus récent avec un customer_tag
      for (const checkout of (data.checkouts || [])) {
        console.log('📋 Analyse checkout:', checkout.id);
        
        // Vérifier les attributs
        const attributes = checkout.attributes || checkout.note_attributes || [];
        console.log('📌 Attributs trouvés:', attributes);
        
        const customerTag = attributes.find(attr => 
          attr.name === 'customer_tag' || attr.key === 'customer_tag'
        )?.value;
        
        if (customerTag) {
          console.log('✅ Tag trouvé dans checkout:', customerTag);
          return {
            found: true,
            tag: customerTag,
            source: 'checkout_attributes',
            checkoutId: checkout.id
          };
        }
      }
    }
    
    // Essayer aussi avec les commandes draft récentes
    console.log('🔍 Recherche dans les draft orders...');
    const draftOrdersResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/draft_orders.json?limit=5&status=open`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    if (draftOrdersResponse.ok) {
      const draftData = await draftOrdersResponse.json();
      console.log('📑 Draft orders trouvés:', draftData.draft_orders?.length || 0);
      
      for (const draft of (draftData.draft_orders || [])) {
        const attributes = draft.note_attributes || [];
        const customerTag = attributes.find(attr => 
          attr.name === 'customer_tag'
        )?.value;
        
        if (customerTag) {
          console.log('✅ Tag trouvé dans draft order:', customerTag);
          return {
            found: true,
            tag: customerTag,
            source: 'draft_order_attributes'
          };
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur recherche checkouts:', error);
  }
  
  return { found: false, reason: 'No customer tag in recent checkouts' };
}

// Fonction pour vérifier si c'est un produit Zakeke
function isZakekeProduct(product) {
  return product.product_type === 'zakeke-design' || 
         product.vendor === 'Zakeke' ||
         (product.tags && product.tags.includes('zakeke'));
}

// Extraire le design ID du produit
function extractDesignIdFromProduct(product) {
  try {
    // Méthode 1: Depuis les métadonnées
    if (product.metafields) {
      const designMeta = product.metafields.find(m => 
        m.namespace === 'zakeke' && m.key === 'design_id'
      );
      if (designMeta) return designMeta.value;
    }
    
    // Méthode 2: Depuis le HTML (data-design attribute)
    if (product.body_html) {
      const match = product.body_html.match(/data-design="([^"]+)"/);
      if (match) return match[1];
    }
    
    // Méthode 3: Depuis le titre ou SKU
    if (product.title && product.title.includes('Design:')) {
      const match = product.title.match(/Design:\s*([^\s,]+)/);
      if (match) return match[1];
    }
    
    console.log('⚠️ Design ID non trouvé dans le produit');
    return null;
  } catch (error) {
    console.error('Erreur extraction design ID:', error);
    return null;
  }
}

// Extraire le client depuis les données Zakeke (méthodes de fallback)
async function extractCustomerFromZakeke(product) {
  try {
    console.log('🔍 Recherche du client dans les métadonnées Zakeke...');
        // Méthode rapide : lire directement le tag depuis les métadonnées
    if (product.metafields) {
      const tagMeta = product.metafields.find(m =>
        m.namespace === 'zakeke' && m.key === 'customer_tag'
      );
      if (tagMeta && tagMeta.value) {
        console.log('✅ Tag trouvé dans metafield:', tagMeta.value);
        return {
          found: true,
          tag: tagMeta.value,
          source: 'product_metafield'
        };
      }
    }

    
    // Méthode 0: Vérifier les propriétés du produit
    if (product.properties) {
      console.log('🛒 Propriétés du produit trouvées:', product.properties);
      const tagProp = product.properties.find(p => p.name === 'customer_tag');
      if (tagProp && tagProp.value) {
        console.log('✅ Tag trouvé dans les propriétés:', tagProp.value);
        return {
          found: true,
          tag: tagProp.value,
          source: 'product_properties'
        };
      }
    }
    
    // Méthode 1: Depuis les métadonnées du produit
    if (product.metafields) {
      console.log('📊 Métadonnées trouvées:', product.metafields.length);
      
      const customerMeta = product.metafields.find(m => 
        m.namespace === 'zakeke' && (m.key === 'customer_id' || m.key === 'customer_info')
      );
      
      if (customerMeta) {
        console.log('✅ Métadonnée client trouvée:', customerMeta);
        const customerId = customerMeta.value;
        return await getCustomerData(customerId);
      }
    }
    
    // Méthode 2: Depuis le HTML (data attributes Zakeke)
    if (product.body_html) {
      console.log('🔍 Analyse du HTML Zakeke...');
      
      const zaKekeMatches = product.body_html.match(/data-[^=]*="[^"]*"/g);
      if (zaKekeMatches) {
        console.log('📊 Data attributes Zakeke trouvés:', zaKekeMatches);
      }
    }
    
    // Méthode 3: Chercher le client le plus récent
    console.log('🔍 Recherche du client le plus récent...');
    return await getRecentCustomerWithTags();
    
  } catch (error) {
    console.error('❌ Erreur extraction client:', error);
    return { found: false, error: error.message };
  }
}

// Récupérer les données d'un client spécifique
async function getCustomerData(customerId) {
  try {
    console.log('🔍 Récupération client ID:', customerId);
    
    const response = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers/${customerId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    if (response.ok) {
      const customerData = await response.json();
      const customer = customerData.customer;
      
      console.log('✅ Client trouvé:', customer.email);
      console.log('🏷️ Tags client:', customer.tags);
      
      // Chercher un tag qui commence par 'pro'
      if (customer.tags) {
        const tags = customer.tags.split(',').map(t => t.trim());
        const proTag = tags.find(tag => tag.startsWith('pro'));
        
        if (proTag) {
          return {
            found: true,
            customerId: customer.id,
            tag: proTag,
            source: 'customer_tags'
          };
        }
      }
    }
    
    return { found: false, reason: 'Customer not found or no pro tag' };
    
  } catch (error) {
    console.error('❌ Erreur récupération client:', error);
    return { found: false, error: error.message };
  }
}

// Récupérer le client le plus récent avec des tags 'pro'
async function getRecentCustomerWithTags() {
  try {
    console.log('🔍 Recherche client récent avec tags...');
    
    const response = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers.json?limit=10&updated_at_min=${new Date(Date.now() - 600000).toISOString()}`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    if (response.ok) {
      const data = await response.json();
      console.log('👥 Clients récents trouvés:', data.customers.length);
      
      for (const customer of data.customers) {
        if (customer.tags && customer.tags.includes('pro')) {
          const tags = customer.tags.split(',').map(t => t.trim());
          const proTag = tags.find(tag => tag.startsWith('pro'));
          
          if (proTag) {
            console.log('✅ Client avec tag trouvé:', proTag);
            return {
              found: true,
              customerId: customer.id,
              tag: proTag,
              source: 'recent_customer_tags'
            };
          }
        }
      }
    }
    
    return { found: false, reason: 'No recent customers with pro tag' };
    
  } catch (error) {
    console.error('❌ Erreur recherche clients récents:', error);
    return { found: false, error: error.message };
  }
}

// Ajouter tag au produit
async function addProductTag(productId, newTag) {
  try {
    console.log('🏷️ Ajout du tag au produit ID:', productId, 'Tag:', newTag);
    
    // Récupérer produit actuel
    const getResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );

    if (!getResponse.ok) {
      throw new Error(`Erreur récupération produit: ${getResponse.statusText}`);
    }

    const productData = await getResponse.json();
    const currentTags = productData.product.tags || '';
    
    // Vérifier si le tag existe déjà
    if (currentTags.includes(newTag)) {
      console.log('ℹ️ Tag déjà présent:', newTag);
      return productData;
    }
    
    // Ajouter nouveau tag
    const updatedTags = currentTags 
      ? `${currentTags}, ${newTag}`
      : newTag;

    // Mettre à jour produit
    const updateResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({
          product: {
            id: productId,
            tags: updatedTags
          }
        })
      }
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('❌ Erreur ajout tag:', updateResponse.status, errorText);
      throw new Error(`Erreur ajout tag: ${updateResponse.statusText}`);
    }

    console.log('✅ Tag ajouté avec succès:', newTag);
const result = await updateResponse.json();
console.log('🧾 Réponse Shopify après update:', result);
return result;
    
  } catch (error) {
    console.error('❌ Erreur addProductTag:', error);
    throw error;
  }
}
