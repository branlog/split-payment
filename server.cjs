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
app.post('/checkout/confirm', async (req, res) => {
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
