// server.cjs
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const Stripe = require('stripe');

const app = express();
// au top, après app = express()
app.use(cors({
  origin: [
    'https://ton-boutique.myshopify.com',
    'https://preview-ton-boutique.myshopify.com' // si tu prévisualises
  ],
  methods: ['GET','POST'],
}));

app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY; // Pour référence, mais pas utilisé ici (côté client)
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!STRIPE_SECRET_KEY || !SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN || !WEBHOOK_SECRET) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-10-01' });

// --- CREATE PaymentIntent (Stripe) et calcule split
app.post('/checkout/create', async (req, res) => {
  try {
    const { customer = {}, shipping_address = {}, items = [] } = req.body || {};

    let card_cents = 0;
    let cod_cents = 0;

    for (const it of items) {
      const qty = Number(it.qty || 1);
      const price_cents = Number(it.price_cents || 0);
      if (isNaN(qty) || isNaN(price_cents) || price_cents < 0) {
        return res.status(400).json({ ok: false, error: 'Invalid item data' });
      }
      const subtotal = qty * price_cents;
      if (String(it.pay_method) === 'cod') cod_cents += subtotal;
      else card_cents += subtotal; // défaut: carte
    }

    let pi = null;
    let client_secret = null;

    if (card_cents > 0) {
      pi = await stripe.paymentIntents.create({
        amount: card_cents,
        currency: 'cad',
        automatic_payment_methods: { enabled: true },
        metadata: { app: 'split-checkout', cod_cents: String(cod_cents) },
      });
      client_secret = pi.client_secret;
    }

    res.json({
      ok: true,
      payment_intent_id: pi ? pi.id : null,
      client_secret,
      amounts: { card_cents, cod_cents },
      echo: { customer, shipping_address, items },
    });
  } catch (err) {
    console.error('CREATE ERROR', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- CONFIRM PaymentIntent et créer commande Shopify
app.post('/checkout/confirm', async (req, res) => {
  try {
    const { stripe_payment_intent_id, customer = {}, shipping_address = {}, items = [] } = req.body || {};

    if (!stripe_payment_intent_id) {
      return res.status(400).json({ ok: false, error: 'Missing payment id' });
    }
    if (!SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN) {
      return res.status(400).json({ ok: false, error: 'Missing Shopify credentials' });
    }

    // 1) Vérifier le PaymentIntent Stripe
    const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ ok: false, error: `PaymentIntent not succeeded (${pi.status})` });
    }

    const amount_cents = pi.amount_received || pi.amount || 0;
    const currency = (pi.currency || 'CAD').toUpperCase();

    // 2) Construire line_items Shopify
    let line_items = [];
    if (Array.isArray(items) && items.length) {
      line_items = items.map((it) => {
        const qty = it.qty ?? 1;
        if (it.variant_id) {
          return { variant_id: Number(it.variant_id), quantity: qty };
        }
        return {
          title: it.title || 'Article',
          quantity: qty,
          price: ((it.price_cents ?? 0) / 100).toFixed(2),
        };
      });
    } else {
      line_items = [{
        title: 'Paiement carte (Stripe)',
        quantity: 1,
        price: (amount_cents / 100).toFixed(2),
      }];
    }

    // 3) Mappage de l’adresse
    const ship = {
      first_name: shipping_address.first_name || 'Client',
      last_name: shipping_address.last_name || 'Stripe',
      address1: shipping_address.address1 || 'Adresse',
      address2: shipping_address.address2 || '',
      city: shipping_address.city || 'Quebec',
      province: shipping_address.province || '',
      country: shipping_address.country || 'CA',
      zip: shipping_address.zip || '',
    };

    // 4) Corps de la commande Shopify
    const orderPayload = {
      order: {
        email: customer.email || 'client@example.com',
        currency,
        financial_status: 'paid',
        line_items,
        shipping_address: ship,
        note: `Stripe PI: ${pi.id}`,
        transactions: [{
          kind: 'sale',
          status: 'success',
          amount: (amount_cents / 100).toFixed(2),
          currency,
        }],
        send_receipt: false,
        send_fulfillment_receipt: false,
      },
    };

    // 5) Appel API Shopify
    const shopifyResp = await axios.post(
      `https://${SHOP_DOMAIN}/admin/api/2024-10/orders.json`,
      orderPayload,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    res.json({
      ok: true,
      confirmed: pi.id,
      created: shopifyResp.data,
    });
  } catch (err) {
    console.error('CONFIRM ERROR', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message || 'server_error' });
  }
});

// --- COD (Cash On Delivery)
app.post('/checkout/cod', async (req, res) => {
  try {
    const { customer = {}, shipping_address = {}, items = [], total_cents = 0 } = req.body || {};

    if (!SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN) {
      return res.status(400).json({ ok: false, error: 'Missing Shopify credentials' });
    }

    const line_items = items.length
      ? items.map((it) => ({
          title: it.title || 'Article COD',
          quantity: it.qty || 1,
          price: ((it.price_cents ?? 0) / 100).toFixed(2),
        }))
      : [{
          title: 'Paiement à la livraison',
          quantity: 1,
          price: (total_cents / 100).toFixed(2),
        }];

    const orderPayload = {
      order: {
        email: customer.email || 'client@example.com',
        currency: 'CAD',
        financial_status: 'pending',
        line_items,
        shipping_address,
        note: 'Commande COD (paiement à la livraison)',
        send_receipt: false,
        send_fulfillment_receipt: false,
      },
    };

    const shopifyResp = await axios.post(
      `https://${SHOP_DOMAIN}/admin/api/2024-10/orders.json`,
      orderPayload,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    res.json({ ok: true, created: shopifyResp.data });
  } catch (err) {
    console.error('COD ERROR', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message || 'server_error' });
  }
});

// --- Webhook Stripe
app.post('/stripe/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gestion des événements
  switch (event.type) {
    case 'payment_intent.succeeded':
      const pi = event.data.object;
      handlePaymentSuccess(pi);
      break;

    case 'payment_intent.payment_failed':
      const failedPi = event.data.object;
      handlePaymentFailure(failedPi);
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Réponse réussie avec un statut 200
  res.json({ received: true, eventType: event.type, id: event.id });
});

// Fonction pour traiter un paiement réussi
async function handlePaymentSuccess(pi) {
  try {
    const paymentIntentId = pi.id;
    const amount = pi.amount;
    const currency = pi.currency;

    // Exemple : Mettre à jour une commande Shopify
    if (SHOPIFY_ACCESS_TOKEN && SHOP_DOMAIN && pi.metadata?.orderId) {
      const orderPayload = {
        order: {
          id: pi.metadata.orderId,
          financial_status: 'paid',
          transactions: [{
            kind: 'sale',
            status: 'success',
            amount: (amount / 100).toFixed(2),
            currency: currency.toUpperCase(),
          }],
        },
      };

      const response = await axios.put(
        `https://${SHOP_DOMAIN}/admin/api/2024-10/orders/${pi.metadata.orderId}.json`,
        orderPayload,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      console.log('Shopify order updated:', response.data.order.id);
    }

    console.log(`Payment succeeded: ${paymentIntentId}, Amount: ${amount / 100} ${currency}`);
  } catch (err) {
    console.error('Error handling payment success:', err.message);
  }
}

// Fonction pour traiter un paiement échoué
async function handlePaymentFailure(pi) {
  try {
    const paymentIntentId = pi.id;
    const lastPaymentError = pi.last_payment_error?.message || 'Unknown error';

    // Exemple : Log ou notifier
    console.log(`Payment failed: ${paymentIntentId}, Reason: ${lastPaymentError}`);

    // TODO: Implémenter une notification (ex. : email au client via un service externe)
  } catch (err) {
    console.error('Error handling payment failure:', err.message);
  }
}

// --- Health routes
app.get('/', (_req, res) => res.send('Split checkout server running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Start server
app.listen(PORT, () => console.log(`✅ Split server listening on port ${PORT}`));
