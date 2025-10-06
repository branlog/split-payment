
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import Stripe from 'stripe';

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));


const {
  PORT = 3000,
  STRIPE_SECRET_KEY,
  SHOPIFY_ACCESS_TOKEN,
  SHOP_DOMAIN
} = process.env;

if (!STRIPE_SECRET_KEY) console.warn('⚠️ Missing STRIPE_SECRET_KEY');
if (!SHOPIFY_ACCESS_TOKEN) console.warn('⚠️ Missing SHOPIFY_ACCESS_TOKEN');
if (!SHOP_DOMAIN) console.warn('⚠️ Missing SHOP_DOMAIN (ex: yourstore.myshopify.com)');

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Utility: create Shopify order
async function createShopifyOrder(orderPayload) {
  const url = `https://${SHOP_DOMAIN}/admin/api/2024-10/orders.json`;
  const res = await axios.post(url, { order: orderPayload }, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

// Calculate totals helper
function calcTotals(items) {
  const subtotal = items.reduce((sum, it) => sum + (it.price_cents * it.qty), 0);
  return { subtotal, total: subtotal }; // keep simple, taxes/shipping can be added later
}

// Route: create checkout (split logic + PaymentIntent if needed)
app.post('/checkout/create', async (req, res) => {
  try {
    const { customer, shipping_address, items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }

    const cardItems = items.filter(i => i.pay_method === 'card');
    const codItems  = items.filter(i => i.pay_method === 'cod');

    const cardTotals = calcTotals(cardItems);
    const codTotals  = calcTotals(codItems);

    let clientSecret = null;
    let paymentIntentId = null;

    if (cardItems.length > 0 && cardTotals.total > 0) {
      const pi = await stripe.paymentIntents.create({
        amount: cardTotals.total,
        currency: 'cad',
        automatic_payment_methods: { enabled: true },
        metadata: { purpose: 'split_checkout_card_portion' }
      });
      clientSecret = pi.client_secret;
      paymentIntentId = pi.id;
    }

    res.json({
      ok: true,
      payment_intent_id: paymentIntentId,
      client_secret: clientSecret,
      amounts: {
        card_cents: cardTotals.total,
        cod_cents: codTotals.total
      },
      echo: { customer, shipping_address, items }
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'server_error', detail: err.response?.data || err.message });
  }
});

// Route: confirm (called after successful card payment)
// --------------------- CONFIRM: crée les commandes Shopify ---------------------
app.post("/checkout/confirm", async (req, res) => {
  try {
    const {
      stripe_payment_intent_id,   // pi_...
      customer,
      shipping_address,
      items = []
    } = req.body || {};

    // Sépare selon la méthode choisie sur le panier
    const cardItems = items.filter(i => i?.pay_method === "card" && i?.qty > 0);
    const codItems  = items.filter(i => i?.pay_method === "cod"  && i?.qty > 0);

    const toLine = (it) => ({
      variant_id: Number(it.variant_id),
      quantity: Number(it.qty)
      // (Shopify recalcule le prix selon le variant — pas besoin d'envoyer price ici)
    });

    const headers = {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json"
    };

    const base = `https://${SHOP_DOMAIN}/admin/api/2024-10`;

    const created = {};

    // --- Commande "carte" (déjà payée Stripe) ---
    if (cardItems.length) {
      const payloadPaid = {
        order: {
          email: customer?.email || "client@example.com",
          financial_status: "paid",
          line_items: cardItems.map(toLine),
          shipping_address: shipping_address || undefined,
          tags: "split-checkout, paid-part"
        }
      };
      const rPaid = await axios.post(`${base}/orders.json`, payloadPaid, { headers });
      created.paid_order = {
        id: rPaid.data?.order?.id,
        name: rPaid.data?.order?.name
      };
    }

    // --- Commande "COD" (paiement à la livraison) ---
    if (codItems.length) {
      const payloadCOD = {
        order: {
          email: customer?.email || "client@example.com",
          financial_status: "pending", // en attente / à la livraison
          line_items: codItems.map(toLine),
          shipping_address: shipping_address || undefined,
          tags: "split-checkout, cod-part"
        }
      };
      const rCod = await axios.post(`${base}/orders.json`, payloadCOD, { headers });
      created.cod_order = {
        id: rCod.data?.order?.id,
        name: rCod.data?.order?.name
      };
    }

    return res.json({ ok: true, created });
  } catch (err) {
    console.error("CONFIRM ERROR", err?.response?.data || err.message);
    return res.status(400).json({
      ok: false,
      error: err?.response?.data || err.message
    });
  }
});
