export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🎯 Webhook Zakeke reçu !');
    console.log('📦 Produit:', req.body);

    const product = req.body;
    
    // Vérifier si c'est un produit Zakeke
    if (isZakekeProduct(product)) {
      console.log('✅ Produit Zakeke détecté !');
      await processZakekeProduct(product);
      
      return res.status(200).json({ 
        status: 'success', 
        processed: true,
        productId: product.id,
        message: 'Produit Zakeke traité avec succès'
      });
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
  return product.product_type === 'zakeke-design';
}

// Traiter le produit Zakeke
async function processZakekeProduct(product) {
  try {
    console.log('🔄 Traitement du produit:', product.id);
    
    // Extraire nom entreprise depuis le titre/description
    const customerInfo = extractCustomerInfo(product);
    
    if (customerInfo.companyName) {
      console.log('🏢 Entreprise trouvée:', customerInfo.companyName);
      console.log('🏷️ Tag à ajouter:', customerInfo.tag);
      
      // Ajouter le tag au produit
      await addProductTag(product.id, customerInfo.tag);
      
      console.log('✅ Tag ajouté avec succès !');
    } else {
      console.log('❌ Aucune entreprise trouvée dans le produit');
    }
  } catch (error) {
    console.error('❌ Erreur traitement:', error);
    throw error;
  }
}

// Extraire info client depuis le produit
function extractCustomerInfo(product) {
  let companyName = '';
  
  // Méthode 1: Depuis le titre
  if (product.title && product.title.includes('Entreprise:')) {
    const match = product.title.match(/Entreprise:\s*([^-\n]+)/);
    if (match) {
      companyName = match[1].trim();
    }
  }
  
  // Méthode 2: Depuis la description
  if (!companyName && product.body_html && product.body_html.includes('Entreprise:')) {
    const match = product.body_html.match(/Entreprise:\s*([^<\n]+)/);
    if (match) {
      companyName = match[1].trim();
