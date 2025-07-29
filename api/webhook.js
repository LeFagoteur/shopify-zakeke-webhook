import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Webhook reçu:', req.body); // Pour debug

    const product = req.body;
    
    if (isZakekeProduct(product)) {
      await processZakekeProduct(product);
      console.log(`Produit Zakeke traité: ${product.id}`);
    }

    return res.status(200).json({ 
      status: 'success', 
      processed: isZakekeProduct(product),
      productId: product.id
    });

  } catch (error) {
    console.error('Erreur webhook:', error);
    return res.status(500).json({ error: error.message });
  }
}

// Vérifier si c'est un produit Zakeke
function isZakekeProduct(product) {
  return (
    product.vendor === 'Zakeke' ||
    product.product_type === 'zakeke-design' ||
    product.title.includes('Custom') ||
    product.tags?.includes('zakeke')
  );
}

// Traiter le produit Zakeke
async function processZakekeProduct(product) {
  try {
    // Récupérer le client connecté depuis les métadonnées ou autres sources
    const customerInfo = await extractCustomerInfo(product);
    
    if (customerInfo.companyName) {
      // Ajouter métadonnée au produit
      await addCustomerMetafield(product.id, customerInfo);
      
      // Optionnel: Ajouter directement le tag
      await addProductTag(product.id, customerInfo.tag);
    }
  } catch (error) {
    console.error('Erreur traitement produit:', error);
    throw error;
  }
}

// Extraire les infos client (à adapter selon tes besoins)
async function extractCustomerInfo(product) {
  let companyName = '';
  
  // Méthode 1: Depuis le titre du produit
  if (product.title.includes(' - ')) {
    const titlePart = product.title.split(' - ')[0];
    if (titlePart.includes('Entreprise:')) {
      companyName = titlePart.replace('Entreprise: ', '').trim();
    }
  }
  
  // Méthode 2: Depuis les métadonnées existantes
  if (product.metafields) {
    const customerMeta = product.metafields.find(
      m => m.namespace === 'zakeke' && m.key === 'customer_info'
    );
    if (customerMeta) {
      companyName = customerMeta.value.replace('Entreprise: ', '');
    }
  }
  
  // Méthode 3: Depuis les tags existants
  if (product.tags) {
    const customerTag = product.tags.split(',').find(tag => 
      tag.trim().startsWith('customer_')
    );
    if (customerTag) {
      companyName = customerTag.replace('customer_', '').trim();
    }
  }
  
  // Formater le nom pour le tag
  const formattedName = companyName
    .toLowerCase()
    .replace(/[\s\+\-\&\.\,]/g, '');
  
  return {
    companyName,
    tag: 'pro' + formattedName,
    customerId: null // À implémenter si nécessaire
  };
}

// Ajouter métadonnée au produit
async function addCustomerMetafield(productId, customerInfo) {
  const metafieldData = {
    metafield: {
      namespace: 'customer_info',
      key: 'company_name',
      value: customerInfo.companyName,
      type: 'single_line_text_field'
    }
  };

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}/metafields.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify(metafieldData)
    }
  );

  if (!response.ok) {
    throw new Error(`Erreur ajout métadonnée: ${response.statusText}`);
  }

  return response.json();
}

// Ajouter tag directement au produit
async function addProductTag(productId, newTag) {
  // Récupérer les tags actuels
  const productResponse = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`,
    {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      }
    }
  );

  const productData = await productResponse.json();
  const currentTags = productData.product.tags || '';
  
  // Ajouter le nouveau tag
  const updatedTags = currentTags 
    ? `${currentTags}, ${newTag}`
    : newTag;

  // Mettre à jour le produit
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
    throw new Error(`Erreur ajout tag: ${updateResponse.statusText}`);
  }

  return updateResponse.json();
}
