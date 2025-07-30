export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🎯 Webhook Zakeke reçu !');

    const product = req.body;
    
    if (isZakekeProduct(product)) {
      console.log('✅ Produit Zakeke détecté !');
      
      // Méthode 1: Chercher l'ID client dans les métadonnées Zakeke
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
      if (customer.note && customer
