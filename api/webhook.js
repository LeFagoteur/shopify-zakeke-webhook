export default async function handler(req, res) {
  // Vérifier que c'est une requête POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Webhook reçu:', req.body); // Pour debug

    const product = req.body;
    
    // Vérifier si c'est un produit Zakeke
    if (isZakekeProduct(product)) {
      await processZakekeProduct(product);
      console.log(`Produit Zakeke traité: ${product.id}`);
      
      return res.status(200).json({ 
        status: 'success', 
        processed: true,
        productId: product.id,
        message: 'Produit Zakeke traité avec succès'
      });
    }

    return res.status(200).json({ 
      status: 'success', 
      processed: false,
      message: 'Produit non-Zakeke, ignoré'
    });

  } catch (error) {
    console.error('Erreur webhook:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// Vérifier si c'est un produit Zakeke
function isZakekeProduct(product) {
  return (
    product.product_type === 'zakeke-design' ||  // ← Principal
    product.vendor === 'Zakeke' ||              // ← Backup
    product.title.includes('Custom')             // ← Backup 2
  );
}

// Traiter le produit Zakeke
async function processZakekeProduct(product) {
  try {
    console.log('Traitement du produit:', product.id);
    
    // Récupérer les infos client depuis le produit
    const customerInfo = extractCustomerInfo(product);
    
    if (customerInfo.companyName) {
      console.log('Nom entreprise trouvé:', customerInfo.companyName);
      
      // Ajouter métadonnée au produit
      await addCustomerMetafield(product.id, customerInfo);
      
      // Ajouter directement le tag
      await addProductTag(product.id, customerInfo.tag);
      
      console.log('Tag ajouté:', customerInfo.tag);
    } else {
      console.log('Aucun nom d\entreprise trouvé dans le produit');
    }
  } catch (error) {
    console.error('Erreur traitement produit:', error);
    throw error;
  }
}

// Extraire les infos client depuis le produit
function extractCustomerInfo(product) {
  let companyName = '';
  
  // Méthode 1: Depuis le titre du produit
  if (product.title && product.title.includes(' - ')) {
    const titlePart = product.title.split(' - ')[0];
    if (titlePart.includes('Entreprise:')) {
      companyName = titlePart.replace('Entreprise: ', '').trim();
    }
  }
  
  // Méthode 2: Depuis la description
  if (!companyName && product.body_html && product.body_html.includes('Entreprise:')) {
    const match = product.body_html.match(/Entreprise:\s*([^<\n]+)/);
    if (match) {
      companyName = match[1].trim();
    }
  }
  
  // Méthode 3: Depuis les métadonnées existantes
  if (!companyName && product.metafields) {
    const customerMeta = product.metafields.find(
      m => m.namespace === 'zakeke' && m.key === 'customer_info'
    );
    if (customerMeta && customerMeta.value) {
      companyName = customerMeta.value.replace('Entreprise: ', '');
    }
  }
  
  // Méthode 4: Depuis les tags existants
  if (!companyName && product.tags) {
    const customerTag = product.tags.split(',').find(tag => 
      tag.trim().startsWith('customer_')
    );
    if (customerTag) {
      companyName = customerTag.replace('customer_', '').trim();
    }
  }
  
  // Méthode 5: Pattern dans le titre (ex: "Design pour Bass Test 3")
  if (!companyName && product.title) {
    const patterns = [
      /Design pour (.+)/i,
      /Custom (.+)/i,
      /Pour (.+)/i
    ];
    
    for (const pattern of patterns) {
      const match = product.title.match(pattern);
      if (match) {
        companyName = match[1].trim();
        break;
      }
    }
  }
  
  // Formater le nom pour le tag
  const formattedName = companyName
    .toLowerCase()
    .replace(/entreprise:\s*/i, '')
    .replace(/[\s\+\-\&\.\,\:]/g, '');
  
  return {
    companyName,
    tag: 'pro' + formattedName,
    customerId: null
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
    const errorText = await response.text();
    console.error('Erreur ajout métadonnée:', response.status, errorText);
    throw new Error(`Erreur ajout métadonnée: ${response.statusText}`);
  }

  const result = await response.json();
  console.log('Métadonnée ajoutée:', result);
  return result;
}

// Ajouter tag directement au produit
async function addProductTag(productId, newTag) {
  try {
    // Récupérer les tags actuels
    const productResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/products/${productId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );

    if (!productResponse.ok) {
      throw new Error(`Erreur récupération produit: ${productResponse.statusText}`);
    }

    const productData = await productResponse.json();
    const currentTags = productData.product.tags || '';
    
    // Vérifier si le tag existe déjà
    if (currentTags.includes(newTag)) {
      console.log('Tag déjà présent:', newTag);
      return productData;
    }
    
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
      const errorText = await updateResponse.text();
      console.error('Erreur ajout tag:', updateResponse.status, errorText);
      throw new Error(`Erreur ajout tag: ${updateResponse.statusText}`);
    }

    const result = await updateResponse.json();
    console.log('Tag ajouté avec succès:', newTag);
    return result;
    
  } catch (error) {
    console.error('Erreur dans addProductTag:', error);
    throw error;
  }
}
