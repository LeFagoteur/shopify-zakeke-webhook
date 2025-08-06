const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  console.log('🌍 Domaine Shopify chargé :', process.env.SHOPIFY_SHOP_DOMAIN);

  // 👉 Gérer CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://studio.lefagoteur.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('📦 Données complètes reçues:', JSON.stringify(req.body, null, 2));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🎯 Webhook Zakeke reçu !');
    const product = req.body;

    if (isZakekeProduct(product)) {
      console.log('✅ Produit Zakeke détecté !');

      const checkoutTag = await getCustomerTagFromRecentCheckouts();
      if (checkoutTag.found) {
        console.log('🎯 Tag trouvé dans checkout:', checkoutTag.tag);
        await addProductTag(product.id, checkoutTag.tag);
        return res.status(200).json({ status: 'success', processed: true, productId: product.id, customerInfo: checkoutTag, message: 'Tag client ajouté avec succès (via checkout)' });
      }

      const designId = extractDesignIdFromProduct(product);
      if (designId && global.designCustomerMap?.[designId]) {
        const customerData = global.designCustomerMap[designId];
        console.log('🎯 Association trouvée dans la map:', customerData);
        await addProductTag(product.id, customerData.customerTag);
        delete global.designCustomerMap[designId];
        return res.status(200).json({ status: 'success', processed: true, productId: product.id, customerInfo: { found: true, customerId: customerData.customerId, tag: customerData.customerTag, source: 'design_map' }, message: 'Tag client ajouté avec succès (via map)' });
      }

      const customerInfo = await extractCustomerFromZakeke(product);
      if (customerInfo.found) {
        console.log('🏷️ Tag à ajouter:', customerInfo.tag);
        await addProductTag(product.id, customerInfo.tag);
        return res.status(200).json({ status: 'success', processed: true, productId: product.id, customerInfo: customerInfo, message: 'Tag client ajouté avec succès' });
      } else {
        console.log('❌ Impossible de trouver le client pour ce produit');
        return res.status(200).json({ status: 'success', processed: false, message: 'Client non trouvé' });
      }
    }

    return res.status(200).json({ status: 'success', processed: false, message: 'Produit non-Zakeke' });

  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

// ... reste inchangé ...

// Récupérer les données d'un client spécifique
async function getCustomerData(customerId) {
  try {
    console.log('🔍 Récupération client ID:', customerId);
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers/${customerId}.json`, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      }
    });

    if (response.ok) {
      const customerData = await response.json();
      const customer = customerData.customer;

      console.log('✅ Client trouvé:', customer.email);
      console.log('🏷️ Tags client:', customer.tags);

      if (customer.tags) {
        const tags = customer.tags.split(',').map(t => t.trim());
        const proTag = tags.find(tag => tag.startsWith('pro') && !BLACKLISTED_TAGS.includes(tag));
        if (proTag) {
          return { found: true, customerId: customer.id, tag: proTag, source: 'customer_tags' };
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
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers.json?limit=10&updated_at_min=${new Date(Date.now() - 600000).toISOString()}`, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      }
    });

    if (response.ok) {
      const data = await response.json();
      console.log('👥 Clients récents trouvés:', data.customers.length);

      for (const customer of data.customers) {
        if (customer.tags) {
          const tags = customer.tags.split(',').map(t => t.trim());
          const proTag = tags.find(tag => tag.startsWith('pro') && !BLACKLISTED_TAGS.includes(tag));
          if (proTag) {
            console.log('✅ Client avec tag trouvé:', proTag);
            return { found: true, customerId: customer.id, tag: proTag, source: 'recent_customer_tags' };
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
    const getResponse = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      }
    });

    if (!getResponse.ok) throw new Error(`Erreur récupération produit: ${getResponse.statusText}`);

    const productData = await getResponse.json();
    const currentTags = productData.product.tags || '';
    const updatedTags = currentTags ? `${currentTags}, ${newTag}` : newTag;

    const originalTitle = productData.product.title || 'Zakeke Produit';
    const cleanedName = newTag.replace(/^pro/, '').replace(/-/g, ' ').trim().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    const expectedPrefix = `${cleanedName} - `;
    const titleAlreadyCustomized = originalTitle.startsWith(expectedPrefix);
    const updatedTitle = titleAlreadyCustomized ? originalTitle : `${expectedPrefix}${originalTitle}`;

    const updateResponse = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({
        product: {
          id: productId,
          tags: updatedTags,
          title: updatedTitle
        }
      })
    });

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
