// server.cjs
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const Stripe = require('stripe');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;

const stripe = new Stripe(STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// --- health route
app.get('/', (_req, res) => res.send('Split checkout server running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- create payment intent
app.post('/checkout/create', async (req, res) => {
  try {
    const { items = [] } = req.body;
    const card_cents = 1000;
    const cod_cents = 500;

    const pi = await stripe.paymentIntents.create({
      amount: card_cents,
      currency: 'cad',
      automatic_payment_methods: { enabled: true },
    });

    res.json({
      ok: true,
      payment_intent_id: pi.id,
      client_secret: pi.client_secret,
      amounts: { card_cents, cod_cents },
    });
  } catch (err) {
    console.error('CREATE ERROR', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- confirm
app.post('/checkout/confirm', async (req, res) => {// --- confirm & create Shopify order
app.post('/checkout/confirm', async (req, res) => {
  try {
    const {
      stripe_payment_intent_id,
      customer = {},
      shipping_address = {},
      items = [] // attendu: [{ variant_id?, qty?, price_cents?, title? }]
    } = req.body || {};

    if (!SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN) {
      return res.status(400).json({ ok: false, error: 'Missing Shopify credentials' });
    }
    if (!stripe_payment_intent_id) {
      return res.status(400).json({ ok: false, error: 'missing payment id' });
    }

    // 1) Vérifier le PaymentIntent Stripe
    const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ ok: false, error: `PaymentIntent not succeeded (${pi.status})` });
    }

    const amount_cents = pi.amount_received ?? pi.amount ?? 0;
    const currency = (pi.currency || 'cad').toUpperCase();

    // 2) Construire line_items Shopify
    //    - Si tu envoies des variant_id: Shopify les rattache à tes produits
    //    - Sinon on crée une ligne “custom item” au montant payé
    let line_items = [];
    if (Array.isArray(items) && items.length) {
      line_items = items.map((it) => {
        const qty = it.qty ?? 1;
        if (it.variant_id) {
          return { variant_id: Number(it.variant_id), quantity: qty };
        }
        // ligne “custom” si pas de variant_id
        const price = ((it.price_cents ?? 0) / 100).toFixed(2);
        return {
          title: it.title || 'Article',
          quantity: qty,
          price
        };
      });
    } else {
      // fallback: une seule ligne “custom” pour le montant Stripe
      line_items = [{
        title: 'Paiement carte (Stripe)',
        quantity: 1,
        price: (amount_cents / 100).toFixed(2)
      }];
    }

    // 3) Mappage basique de l’adresse client
    const ship = {
      first_name: shipping_address.first_name || 'Client',
      last_name: shipping_address.last_name || 'Stripe',
      address1: shipping_address.address1 || 'Adresse',
      address2: shipping_address.address2 || '',
      city: shipping_address.city || 'Quebec',
      province: shipping_address.province || '',
      country: shipping_address.country || 'CA',
      zip: shipping_address.zip || ''
    };

    // 4) Corps de la commande Shopify
    const orderPayload = {
      order: {
        email: customer.email || 'client@example.com',
        currency,
        financial_status: 'paid', // ordre créé comme payé
        line_items,
        shipping_address: ship,
        note: `Stripe PI: ${pi.id}`,
        transactions: [
          {
            kind: 'sale',
            status: 'success',
            amount: (amount_cents / 100).toFixed(2),
            currency
          }
        ],
        send_receipt: false,
        send_fulfillment_receipt: false
      }
    };

    // 5) Appel API Shopify
    const shopifyResp = await axios.post(
      `https://${SHOP_DOMAIN}/admin/api/2024-10/orders.json`,
      orderPayload,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return res.json({
      ok: true,
      confirmed: pi.id,
      created: shopifyResp.data // renvoie l’objet commande Shopify
    });
  } catch (err) {
    console.error('CONFIRM ERROR', err?.response?.data || err.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.response?.data || err.message || 'server_error'
    });
  }
});

  try {
    const { stripe_payment_intent_id } = req.body;
    if (!stripe_payment_intent_id)
      return res.status(400).json({ ok: false, error: 'missing payment id' });

    const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (pi.status !== 'succeeded')
      return res.status(400).json({ ok: false, error: 'payment not succeeded' });

    res.json({ ok: true, confirmed: pi.id });
  } catch (err) {
    console.error('CONFIRM ERROR', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- start
app.listen(PORT, () => console.log(`✅ Split server listening on port ${PORT}`));
