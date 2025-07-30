import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  domain: SHOP,
  accessToken: TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body;
  console.log("Webhook Zakeke reçu:", body);

  if (body.eventType !== "OrderGenerated") {
    return res.status(200).send("Pas un event OrderGenerated");
  }

  const orderNumber = body.data.orderEcommerceNumber;
  const detail = body.data.orderDetails[0]; // adapter si plusieurs

  const clientTag = `client_${detail.detailCustomerCode || detail.detailVisitorId}`;
  const sku = detail.detailModelCode;

  // Récupérer le produit vierge par SKU
  const { body: pRes } = await shopify.rest.Product.list({
    query: sku,
    limit: 1,
  });

  if (!pRes.products.length) {
    console.log("Produit vierge non trouvé pour SKU", sku);
    return res.status(404).send("Produit vierge introuvable");
  }

  const template = pRes.products[0];

  // Cloner le produit
  const newProduct = {
    title: `${template.title} - personnalisé`,
    body_html: template.body_html,
    vendor: template.vendor,
    tags: [...(template.tags.split(",") || []), clientTag].join(","),
    images: template.images,
    variants: template.variants,
  };

  const { body: created } = await shopify.rest.Product.create({ product: newProduct });
  console.log("Produit personnalisé créé:", created.product.id);

  res.status(200).send("Produit tagué OK");
}
