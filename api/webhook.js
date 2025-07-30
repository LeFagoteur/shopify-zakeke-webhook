export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🎯 Webhook Zakeke reçu !');
    console.log('📦 Produit:', JSON.stringify(req.body, null, 2));

    const product = req.body;
    
    // Vérifier si c'est un produit Zakeke
    if (isZakekeProduct(product)) {
      console.log('✅ Produit Zakeke détecté !');
      
      const customerInfo = extractCustomerInfo(product);
      console.log('🔍 Info client extraite:', customerInfo);
      
      if (customerInfo.companyName) {
        console.log('🏢 Entreprise trouvée:', customerInfo.companyName);
        console.log('🏷️ Tag à ajouter:', customerInfo.tag);
        
        // Pour l'instant, juste logger (on testera l'ajout de tag après)
        console.log('📝 Simulation ajout tag:', customerInfo.tag);
        
        return res.status(200).json({ 
          status: 'success', 
          processed: true,
          productId: product.id,
          customerInfo: customerInfo,
          message: 'Produit Zakeke traité (simulation)'
        });
      } else {
        console.log('❌ Aucune entreprise trouvée');
        return res.status(200).json({ 
          status: 'success', 
          processed: false,
          message: 'Aucune info client trouvée'
        });
      }
    }

    console.log('❌ Produit non-Zakeke, ignoré');
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

// Vérifier si c'est un produit Zakeke
function isZakekeProduct(product) {
  console.log('🔍 Vérification produit type:', product.product_type);
  return product.product_type === 'zakeke-design';
}

// Extraire info client depuis le produit
function extractCustomerInfo(product) {
  let companyName = '';
  
  console.log('🔍 Analyse titre:', product.title);
  console.log('🔍 Analyse description:', product.body_html?.substring(0, 200));
  
  // Méthode 1: Depuis le titre
  if (product.title && product.title.includes('Entreprise:')) {
    const match = product.title.match(/Entreprise:\s*([^-\n,]+)/);
    if (match) {
      companyName = match[1].trim();
      console.log('✅ Entreprise trouvée dans titre:', companyName);
    }
  }
  
  // Méthode 2: Depuis la description
  if (!companyName && product.body_html && product.body_html.includes('Entreprise:')) {
    const match = product.body_html.match(/Entreprise:\s*([^<\n,]+)/);
    if (match) {
      companyName = match[1].trim();
      console.log('✅ Entreprise trouvée dans description:', companyName);
    }
  }
  
  // Méthode 3: Pattern générique dans le titre
  if (!companyName && product.title) {
    // Chercher des patterns comme "Pour [Entreprise]", "Design [Entreprise]", etc.
    const patterns = [
      /pour\s+(.+)/i,
      /design\s+(.+)/i,
      /custom\s+(.+)/i,
      /-\s*(.+)$/
    ];
    
    for (const pattern of patterns) {
      const match = product.title.match(pattern);
      if (match && match[1]) {
        companyName = match[1].trim();
        console.log('✅ Entreprise trouvée via pattern:', companyName);
        break;
      }
    }
  }
  
  // Formater pour le tag
  const formattedName = companyName
    .toLowerCase()
    .replace(/entreprise:\s*/i, '')
    .replace(/[\s\+\-\&\.\,\:]/g, '');
  
  return {
    companyName,
    tag: 'pro' + formattedName
  };
}
