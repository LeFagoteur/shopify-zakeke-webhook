module.exports = async function handler(req, res) {
  // DÉSACTIVÉ TEMPORAIREMENT POUR TESTS
  // console.log('⏸️ Webhook Zakeke désactivé pour tests');
  // return res.status(200).send('OK - Désactivé');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🎯 Webhook Zakeke reçu !');

    const product = req.body;
    
    if (isZakekeProduct(product)) {
      console.log('✅ Produit Zakeke détecté !');
      
      // NOUVELLE MÉTHODE: Chercher d'abord dans la map globale
      const designId = extractDesignIdFromProduct(product);
      if (designId && global.designCustomerMap?.[designId]) {
        const customerData = global.designCustomerMap[designId];
        console.log('🎯 Association trouvée dans la map:', customerData);
        
        // Ajouter le tag
        await addProductTag(product.id, customerData.customerTag);
        
        // Nettoyer la map
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
      
      // Méthode originale: Chercher l'ID client dans les métadonnées Zakeke
      const customerInfo = await extractCustomerFromZakeke(product);
      
      if (customerInfo.found) {
        console.log('🏢 Client trouvé:', customerInfo.companyName);
        console.log('🏷️ Tag à ajouter:', customerInfo.tag);
        
        // Ajouter le tag
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

// NOUVELLE FONCTION: Extraire le design ID du produit
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

function isZakekeProduct(product) {
  return product.product_type === 'zakeke-design';
}

// Extraire le client depuis les données Zakeke
async function extractCustomerFromZakeke(product) {
  try {
    console.log('🔍 Recherche du client dans les métadonnées Zakeke...');
    
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
    if (product.body_html && product.body_html.includes('zakeke-product-tag')) {
      console.log('🔍 Analyse du HTML Zakeke...');
      
      // Extraire les data attributes Zakeke
      const zaKekeMatches = product.body_html.match(/data-[^=]*="[^"]*"/g);
      if (zaKekeMatches) {
        console.log('📊 Data attributes Zakeke trouvés:', zaKekeMatches);
        
        // Chercher un ID de session ou customer
        for (const match of zaKekeMatches) {
          if (match.includes('customer') || match.includes('session') || match.includes('user')) {
            console.log('🎯 Attribut client potentiel:', match);
            // Extraire la valeur et chercher le client
            const value = match.match(/"([^"]*)"/)[1];
            const customerData = await getCustomerData(value);
            if (customerData.found) return customerData;
          }
        }
      }
    }
    
    // Méthode 3: Chercher le client le plus récemment modifié avec des tags
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
      console.log('📝 Note client:', customer.note);
      console.log('🏷️ Tags client:', customer.tags);
      
      // Priorité 1: Tags existants du client
      if (customer.tags && customer.tags.includes('pro')) {
        const existingTag = customer.tags.split(',').find(tag => tag.trim().startsWith('pro'));
        if (existingTag) {
          return {
            found: true,
            customerId: customer.id,
            companyName: existingTag.trim(),
            tag: existingTag.trim(),
            source: 'customer_tags'
          };
        }
      }
      
      // Priorité 2: Note du client
      if (customer.note && customer.note.includes('Entreprise:')) {
        const match = customer.note.match(/Entreprise:\s*([^,\n]+)/);
        if (match) {
          const companyName = match[1].trim();
          const tag = 'pro' + companyName.toLowerCase().replace(/[\s\+\-\&\.\,\:]/g, '');
          
          return {
            found: true,
            customerId: customer.id,
            companyName: companyName,
            tag: tag,
            source: 'customer_note'
          };
        }
      }
    }
    
    return { found: false, reason: 'Customer not found or no company info' };
    
  } catch (error) {
    console.error('❌ Erreur récupération client:', error);
    return { found: false, error: error.message };
  }
}

// Récupérer le client le plus récemment modifié avec des tags 'pro'
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
      
      // Chercher un client avec tag 'pro' ou note 'Entreprise:'
      for (const customer of data.customers) {
        console.log(`🔍 Analyse client: ${customer.email}`);
        
        // Tags existants
        if (customer.tags && customer.tags.includes('pro')) {
          const existingTag = customer.tags.split(',').find(tag => tag.trim().startsWith('pro'));
          if (existingTag) {
            console.log('✅ Client avec tag trouvé:', existingTag.trim());
            return {
              found: true,
              customerId: customer.id,
              companyName: existingTag.trim(),
              tag: existingTag.trim(),
              source: 'recent_customer_tags'
            };
          }
        }
        
        // Notes client
        if (customer.note && customer.note.includes('Entreprise:')) {
          const match = customer.note.match(/Entreprise:\s*([^,\n]+)/);
          if (match) {
            const companyName = match[1].trim();
            const tag = 'pro' + companyName.toLowerCase().replace(/[\s\+\-\&\.\,\:]/g, '');
            
            console.log('✅ Client avec note trouvé:', companyName);
            return {
              found: true,
              customerId: customer.id,
              companyName: companyName,
              tag: tag,
              source: 'recent_customer_note'
            };
          }
        }
      }
    }
    
    return { found: false, reason: 'No recent customers with company info' };
    
  } catch (error) {
    console.error('❌ Erreur recherche clients récents:', error);
    return { found: false, error: error.message };
  }
}

// Ajouter tag au produit
async function addProductTag(productId, newTag) {
  try {
    console.log('🏷️ Ajout du tag:', newTag);
    
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
      throw new Error(`Erreur récupération: ${getResponse.statusText}`);
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
    return await updateResponse.json();
    
  } catch (error) {
    console.error('❌ Erreur addProductTag:', error);
    throw error;
  }
}
