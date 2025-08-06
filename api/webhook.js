const fetch = require('node-fetch');

const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

module.exports = async function handler(req, res) {
  console.log('🌍 Domaine Shopify chargé :', process.env.SHOPIFY_SHOP_DOMAIN);

  res.setHeader('Access-Control-Allow-Origin', 'https://studio.lefagoteur.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('📦 Données complètes reçues:', JSON.stringify(req.body, null, 2));

  try {
    console.log('🎯 Webhook Zakeke reçu !');
    const product = req.body;

    if (!isZakekeProduct(product)) {
      return res.status(200).json({ status: 'success', processed: false, message: 'Produit non-Zakeke' });
    }

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
      return res.status(200).json({ status: 'success', processed: true, productId: product.id, customerInfo, message: 'Tag client ajouté avec succès' });
    } else {
      console.log('❌ Impossible de trouver le client pour ce produit');
      return res.status(200).json({ status: 'success', processed: false, message: 'Client non trouvé' });
    }
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

function isZakekeProduct(product) {
  return product.product_type === 'zakeke-design' || product.vendor === 'Zakeke' || (product.tags && product.tags.includes('zakeke'));
}

function extractDesignIdFromProduct(product) {
  try {
    if (product.metafields) {
      const designMeta = product.metafields.find(m => m.namespace === 'zakeke' && m.key === 'design_id');
      if (designMeta) return designMeta.value;
    }
    if (product.body_html) {
      const match = product.body_html.match(/data-design="([^"]+)"/);
      if (match) return match[1];
    }
    if (product.title && product.title.includes('Design:')) {
      const match = product.title.match(/Design:\s*([^\s,]+)/);
      if (match) return match[1];
    }
    return null;
  } catch (error) {
    console.error('Erreur extraction design ID:', error);
    return null;
  }
}

async function getCustomerTagFromRecentCheckouts() {
  try {
    const checkoutsResponse = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/checkouts.json?limit=10&created_at_min=${new Date(Date.now() - 3600000).toISOString()}`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
    });

    if (checkoutsResponse.ok) {
      const data = await checkoutsResponse.json();
      for (const checkout of data.checkouts || []) {
        const attributes = checkout.attributes || checkout.note_attributes || [];
        const customerTag = attributes.find(attr => attr.name === 'customer_tag' || attr.key === 'customer_tag')?.value;
        if (customerTag && !BLACKLISTED_TAGS.includes(customerTag)) {
          return { found: true, tag: customerTag, source: 'checkout_attributes', checkoutId: checkout.id };
        }
      }
    }

    const draftOrdersResponse = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/draft_orders.json?limit=5&status=open`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
    });

    if (draftOrdersResponse.ok) {
      const draftData = await draftOrdersResponse.json();
      for (const draft of draftData.draft_orders || []) {
        const attributes = draft.note_attributes || [];
        const customerTag = attributes.find(attr => attr.name === 'customer_tag')?.value;
        if (customerTag && !BLACKLISTED_TAGS.includes(customerTag)) {
          return { found: true, tag: customerTag, source: 'draft_order_attributes' };
        }
      }
    }
  } catch (error) {
    console.error('❌ Erreur recherche checkouts:', error);
  }

  return { found: false, reason: 'No customer tag in recent checkouts' };
}

async function extractCustomerFromZakeke(product) {
  try {
    if (product.metafields) {
      const tagMeta = product.metafields.find(m => m.namespace === 'zakeke' && m.key === 'customer_tag');
      if (tagMeta && tagMeta.value && !BLACKLISTED_TAGS.includes(tagMeta.value)) {
        return { found: true, tag: tagMeta.value, source: 'product_metafield' };
      }
    }

    if (product.properties) {
      const tagProp = product.properties.find(p => p.name === 'customer_tag');
      if (tagProp && tagProp.value && !BLACKLISTED_TAGS.includes(tagProp.value)) {
        return { found: true, tag: tagProp.value, source: 'product_properties' };
      }
    }

    if (product.metafields) {
      const customerMeta = product.metafields.find(m => m.namespace === 'zakeke' && (m.key === 'customer_id' || m.key === 'customer_info'));
      if (customerMeta) {
        return await getCustomerData(customerMeta.value);
      }
    }

    return await getRecentCustomerWithTags();
  } catch (error) {
    console.error('❌ Erreur extraction client:', error);
    return { found: false, error: error.message };
  }
}

async function getCustomerData(customerId) {
  try {
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers/${customerId}.json`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
    });

    if (response.ok) {
      const customerData = await response.json();
      const customer = customerData.customer;

      if (customer.tags) {
        const tags = customer.tags.split(',').map(t => t.trim());
        const proTag = tags.find(tag => tag.startsWith('pro') && !BLACKLISTED_TAGS.includes(tag));
        if (proTag) return { found: true, customerId: customer.id, tag: proTag, source: 'customer_tags' };
      }
    }
    return { found: false, reason: 'Customer not found or no pro tag' };
  } catch (error) {
    console.error('❌ Erreur récupération client:', error);
    return { found: false, error: error.message };
  }
}

async function getRecentCustomerWithTags() {
  try {
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers.json?limit=10&updated_at_min=${new Date(Date.now() - 600000).toISOString()}`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
    });

    if (response.ok) {
      const data = await response.json();
      for (const customer of data.customers) {
        if (customer.tags) {
          const tags = customer.tags.split(',').map(t => t.trim());
          const proTag = tags.find(tag => tag.startsWith('pro') && !BLACKLISTED_TAGS.includes(tag));
          if (proTag) return { found: true, customerId: customer.id, tag: proTag, source: 'recent_customer_tags' };
        }
      }
    }
    return { found: false, reason: 'No recent customers with pro tag' };
  } catch (error) {
    console.error('❌ Erreur recherche clients récents:', error);
    return { found: false, error: error.message };
  }
}

async function addProductTag(productId, newTag) {
  try {
    console.log('🏷️ Ajout du tag au produit ID:', productId, 'Tag:', newTag);
    const getResponse = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`, {
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
    });

    if (!getResponse.ok) throw new Error(`Erreur récupération produit: ${getResponse.statusText}`);
    const productData = await getResponse.json();
    const currentTags = productData.product.tags || '';
    const updatedTags = currentTags ? `${currentTags}, ${newTag}` : newTag;

    const originalTitle = productData.product.title || 'Zakeke Produit';
    const cleanedName = newTag.replace(/^pro/, '').replace(/-/g, ' ').trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const expectedPrefix = `${cleanedName} - `;
    const updatedTitle = originalTitle.startsWith(expectedPrefix) ? originalTitle : `${expectedPrefix}${originalTitle}`;

    const updateResponse = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ product: { id: productId, tags: updatedTags, title: updatedTitle } })
    });

    if (!updateResponse.ok) throw new Error(`Erreur ajout tag: ${updateResponse.statusText}`);
    const result = await updateResponse.json();
    console.log('✅ Tag ajouté avec succès:', newTag);
    console.log('🧾 Réponse Shopify après update:', result);
    return result;
  } catch (error) {
    console.error('❌ Erreur addProductTag:', error);
    throw error;
  }
}
