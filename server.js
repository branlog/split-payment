// server.js  (ESM)
// DÉPENDANCES: express, cors, body-parser, axios, stripe, dotenv
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import Stripe from 'stripe';

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // sert /pay.html

const {
  PORT = 3000,
  STRIPE_SECRET_KEY,
  SHOPIFY_ACCESS_TOKEN,
  SHOP_DOMAIN, // ex: yourstore.myshopify.com
} = process.env;

// Sanity logs (non bloquant en prod)
if (!STRIPE_SECRET_KEY) console.warn('⚠️ Missing STRIPE_SECRET_KEY');
if (!SHOPIFY_ACCESS_TOKEN) console.warn('⚠️ Missing SHOPIFY_ACCESS_TOKEN');
if (!SHOP_DOMAIN) console.warn('⚠️ Missing SHOP_DOMAIN (ex: yourstore.myshopify.com)');

const stripe = new Stripe(STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });

/* ------------------------------- Utils ---------------------------------- */

function toInt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

function splitItems(items = []) {
  const norm = items
    .filter((it) => it && it.variant_id && it.qty) // garde les lignes valides
    .map((it) => ({
      variant_id: Number(it.variant_id),
      qty: Number(it.qty),
      // ATTENTION: prix unitaire en CENTS
      price_cents: toInt(it.price_cents),
      pay_method: (it.pay_method === 'cod' ? 'cod' : 'card'),
    }));

  const card = [];
  const cod = [];
  for (const it of norm) {
    if (it.pay_method === 'cod') cod.push(it);
    else card.push(it);
  }
  return { card, cod, all: norm };
}

function sumCents(lines = []) {
  return lines.reduce((acc, l) => acc + toInt(l.price_cents) * toInt(l.qty), 0);
}

function toShopifyLine(it) {
  return {
    variant_id: Number(it.variant_id),
    quantity: Number(it.qty),
  };
}

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };
}

function shopifyBase() {
  return `https://${SHOP_DOMAIN}/admin/api/2024-10`;
}

/* ------------------------------- Routes --------------------------------- */

// Health / status
app.get('/', (_req, res) => {
  res.type('text').send('Split checkout server running');
});
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /checkout/create
 * body: { customer, shipping_address, items:[{variant_id, qty, price_cents, pay_method}] }
 * -> crée PaymentIntent pour la portion "card"
 */
app.post('/checkout/create', async (req, res) => {
  try {
    const { customer = {}, shipping_address = {}, items = [] } = req.body || {};
    const { card, cod } = splitItems(items);

    const card_cents = sumCents(card);
    const cod_cents = sumCents(cod);

    // Si aucune portion carte, on ne crée PAS de PI Stripe
    if (card_cents <= 0) {
      return res.json({
        ok: true,
        payment_intent_id: null,
        client_secret: null,
        amounts: { card_cents, cod_cents },
        echo: { ok: true, customer, shipping_address, items },
      });
    }

    if (!STRIPE_SECRET_KEY) {
      return res.status(400).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });
    }

    const pi = await stripe.paymentIntents.create({
      amount: card_cents,
      currency: 'cad', // adapte si besoin
      capture_method: 'automatic',
      automatic_payment_methods: { enabled: true },
      metadata: {
        kind: 'split-checkout',
        cod_cents: String(cod_cents),
      },
    });

    return res.json({
      ok: true,
      payment_intent_id: pi.id,
      client_secret: pi.client_secret,
      amounts: { card_cents, cod_cents },
      echo: { ok: true, customer, shipping_address, items },
    });
  } catch (err) {
    console.error('CREATE ERROR', err?.message, err?.stack);
    return res.status(500).json({ ok: false, error: err?.message || 'server_error' });
  }
});

/**
 * POST /checkout/confirm
 * body: { stripe_payment_intent_id, customer, shipping_address, items:[...] }
 * -> crée 2 orders Shopify (paid + pending COD)
 */
app.post('/checkout/confirm', async (req, res) => {
  try {
    const {
      stripe_payment_intent_id, // pi_...
      customer = {},
      shipping_address = {},
      items = [],
    } = req.body || {};

    if (!SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN) {
      return res.status(400).json({ ok: false, error: 'Missing Shopify credentials' });
    }

    // (Optionnel) Vérifier que le PI est bien succeeded côté Stripe
    if (stripe_payment_intent_id) {
      try {
        const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
        if (pi.status !== 'succeeded') {
          return res.status(400).json({ ok: false, error: `PaymentIntent not succeeded (${pi.status})` });
        }
      } catch (e) {
        // on n’échoue pas si absence de PI (cas full COD), on log seulement
        console.warn('PI retrieve warn:', e?.message);
      }
    }

    const { card, cod } = splitItems(items);

    const created = {};
    const base = shopifyBase();
    const headers = shopifyHeaders();

    // ----- Commande "carte" (déjà payée Stripe) -----
    if (card.length) {
      const payloadPaid = {
        order: {
          email: customer?.email || 'client@example.com',
          financial_status: 'paid',
          line_items: card.map(toShopifyLine),
          shipping_address: Object.keys(shipping_address || {}).length ? shipping_address : undefined,
          tags: 'split-checkout, paid-part',
        },
      };

      const rPaid = await axios.post(`${base}/orders.json`, payloadPaid, { headers });
      created.paid_order = {
        id: rPaid.data?.order?.id,
        name: rPaid.data?.order?.name,
      };
    }

    // ----- Commande "COD" (paiement à la livraison) -----
    if (cod.length) {
      const payloadCOD = {
        order: {
          email: customer?.email || 'client@example.com',
          financial_status: 'pending', // à la livraison
          line_items: cod.map(toShopifyLine),
          shipping_address: Object.keys(shipping_address || {}).length ? shipping_address : undefined,
          tags: 'split-checkout, cod-part',
        },
      };

      const rCod = await axios.post(`${base}/orders.json`, payloadCOD, { headers });
      created.cod_order = {
        id: rCod.data?.order?.id,
        name: rCod.data?.order?.name,
      };
    }

    return res.json({ ok: true, created });
  } catch (err) {
    // Essaye d’extraire l’erreur Shopify lisible
    const shopifyErr = err?.response?.data || err?.message || 'confirm_error';
    console.error('CONFIRM ERROR', shopifyErr);
    return res.status(400).json({ ok: false, error: shopifyErr });
  }
});

/* ------------------------------ Start*
