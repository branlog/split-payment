// server.cjs
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const Stripe = require('stripe');

const app = express();

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN; // ex: logtek.myshopify.com
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN === '1';          // exige un email côté client
const REQUIRE_SPLIT_TAG = process.env.REQUIRE_SPLIT_TAG === '1';  // exige le tag 'split' sur le client

if (!STRIPE_SECRET_KEY || !SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN || !WEBHOOK_SECRET) {
  console.error('❌ Missing env: STRIPE_SECRET_KEY / SHOPIFY_ACCESS_TOKEN / SHOP_DOMAIN / WEBHOOK_SECRET');
  process.exit(1);
}

/* ===================== STRIPE ===================== */
const stripe = new Stripe(STRIPE_SECRET_KEY); // (tu peux épingler: { apiVersion: '2024-06-20' })

/* ===================== CORS ===================== */
app.use(cors({
  origin: [
    'https://logtek.ca',
    'https://preview-logtek.ca',     // si prévisualisation
    'https://logtek.myshopify.com'   // domaine .myshopify.com
  ],
  methods: ['GET','POST'],
  credentials: true
}));

/* ===================== STATIC ===================== */
app.use(express.static('public'));

/* ==================================================
   WEBHOOK STRIPE (⚠️ doit être AVANT bodyParser.json)
================================================== */
app.post('/stripe/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      handlePaymentSuccess(event.data.object).catch(e => console.error('handlePaymentSuccess:', e.message));
      break;
    case 'payment_intent.payment_failed':
      handlePaymentFailure(event.data.object).catch(e => console.error('handlePaymentFailure:', e.message));
      break;
    default:
      console.log(`ℹ️ Unhandled event type ${event.type}`);
  }
  res.json({ received: true, eventType: event.type, id: event.id });
});

/* ===================== JSON pour le reste ===================== */
app.use(bodyParser.json());

/* ===================== HELPERS ===================== */
function requireAuthOr403(customer) {
  const email = (customer?.email || '').trim();
  if (REQUIRE_LOGIN && !email) {
    return { ok: false, status: 403, error: 'login_required' };
  }
  return { ok: true, email };
}

async function isCustomerAllowed(email) {
  try {
    if (!email) return !REQUIRE_LOGIN && !REQUIRE_SPLIT_TAG; // si rien d'exigé, autorise; sinon refuse
    if (!REQUIRE_SPLIT_TAG) return true; // si le tag n'est pas requis, OK

    const url = `https://${SHOP_DOMAIN}/admin/api/2024-10/customers/search.json?query=${encodeURIComponent(`email:${email}`)}`;
    const r = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const customers = r.data?.customers || [];
    if (!customers.length) return false;

    const exact = customers.find(c => (c.email || '').toLowerCase() === email.toLowerCase()) || customers[0];
    const tags = (exact.tags || '').split(',').map(t => t.trim().toLowerCase());
    return tags.includes('split');
  } catch (e) {
    console.error('isCustomerAllowed error:', e.message);
    return false; // par défaut: refuse
  }
}

/* ===================== HEALTH ===================== */
app.get('/', (_req, res) => res.send('Split checkout server running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ==================================================
   CREATE : calcule carte/COD + PaymentIntent
   Correctif de calcul : line_total_cents > unit_price_cents*qty > price_cents*qty
================================================== */
app.post('/checkout/create', async (req, res) => {
  try {
    const { customer = {}, shipping_address = {}, items = [] } = req.body || {};

    const auth = requireAuthOr403(customer);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    if (!(await isCustomerAllowed(auth.email))) {
      return res.status(403).json({ ok: false, error: 'not_authorized' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'no_items' });
    }

    let card_cents = 0;
    let cod_cents = 0;

    for (const it of items) {
      const qty = Number(it.qty || 1);

      // Priorité 1: total de ligne (déjà qty × unit)
      let subtotal = Number(it.line_total_cents);

      // Priorité 2: unit_price_cents × qty
      if (!Number.isFinite(subtotal)) {
        const unit = Number(it.unit_price_cents);
        if (Number.isFinite(unit)) subtotal = unit * qty;
      }

      // Priorité 3 (legacy): price_cents (unitaire) × qty
      if (!Number.isFinite(subtotal)) {
        const legacy = Number(it.price_cents);
        if (Number.isFinite(legacy)) subtotal = legacy * qty;
      }

      if (!Number.isFinite(subtotal) || subtotal < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_item' });
      }

      if (String(it.pay_method) === 'cod') cod_cents += subtotal;
      else card_cents += subtotal; // défaut: carte
    }

    let pi = null;
    let client_secret = null;

    if (card_cents > 0) {
      pi = await stripe.paymentIntents.create({
        amount: card_cents,
        currency: 'cad',
        // pour tests : carte explicite (tu peux remettre automatic_payment_methods si tu veux APM)
        payment_method_types: ['card'],
        metadata: {
          app: 'split-checkout',
          cod_cents: String(cod_cents || 0),
          customer_email: auth.email || ''
        }
      }, { timeout: 20000 });

      client_secret = pi.client_secret;
    }

    res.json({
      ok: true,
      payment_intent_id: pi ? pi.id : null,
      client_secret,
      amounts: { card_cents, cod_cents },
      echo: { customer, shipping_address, items }
    });
  } catch (err) {
    console.error('CREATE ERROR', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message || 'server_error' });
  }
});

/* ==================================================
   CONFIRM : vérifie PI Stripe + crée la commande Shopify (paid)
   Construction line_items :
   - si variant_id : Shopify calcule le prix (recommandé)
   - sinon : on passe un PRIX UNITAIRE (dérivé si besoin)
================================================== */
app.post('/checkout/confirm', async (req, res) => {
  try {
    const { stripe_payment_intent_id, customer = {}, shipping_address = {}, items = [] } = req.body || {};

    if (!stripe_payment_intent_id) {
      return res.status(400).json({ ok: false, error: 'missing_payment_id' });
    }

    const auth = requireAuthOr403(customer);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    if (!(await isCustomerAllowed(auth.email))) {
      return res.status(403).json({ ok: false, error: 'not_authorized' });
    }

    // 1) Vérifier le PaymentIntent Stripe
    const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id, { timeout: 15000 });
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ ok: false, error: `pi_not_succeeded:${pi.status}` });
    }

    const amount_cents = pi.amount_received || pi.amount || 0;
    const currency = (pi.currency || 'CAD').toUpperCase();

    // 2) Construire line_items
    let line_items = [];
    if (Array.isArray(items) && items.length) {
      line_items = items.map((it) => {
        const qty = Number(it.qty || 1);

        if (it.variant_id) {
          return { variant_id: Number(it.variant_id), quantity: qty };
        }

        // Déterminer un PRIX UNITAIRE (Shopify s'attend à unitaire)
        let unit = Number(it.unit_price_cents);

        // Si pas d'unitaire, tenter line_total_cents / qty
        if (!Number.isFinite(unit) && Number.isFinite(Number(it.line_total_cents)) && qty > 0) {
          unit = Math.round(Number(it.line_total_cents) / qty);
        }

        // Dernier recours: legacy price_cents
        if (!Number.isFinite(unit) && Number.isFinite(Number(it.price_cents))) {
          unit = Number(it.price_cents);
        }

        return {
          title: it.title || 'Article',
          quantity: qty,
          price: Number.isFinite(unit) ? (unit / 100).toFixed(2) : '0.00'
        };
      });
    } else {
      // fallback: une seule ligne "Paiement carte"
      line_items = [{
        title: 'Paiement carte (Stripe)',
        quantity: 1,
        price: (amount_cents / 100).toFixed(2)
      }];
    }

    // 3) Adresse
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

    // 4) Payload Shopify
    const orderPayload = {
      order: {
        email: auth.email || 'client@example.com',
        currency,
        financial_status: 'paid',
        line_items,
        shipping_address: ship,
        note: `Stripe PI: ${pi.id}`,
        transactions: [{
          kind: 'sale',
          status: 'success',
          amount: (amount_cents / 100).toFixed(2),
          currency
        }],
        send_receipt: false,
        send_fulfillment_receipt: false
      }
    };

    // 5) API Shopify
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

    res.json({ ok: true, confirmed: pi.id, created: shopifyResp.data });
  } catch (err) {
    console.error('CONFIRM ERROR', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message || 'server_error' });
  }
});

/* ==================================================
   COD : crée une commande "pending"
   (même logique de prix pour items non-variant)
================================================== */
app.post('/checkout/cod', async (req, res) => {
  try {
    const { customer = {}, shipping_address = {}, items = [], total_cents = 0 } = req.body || {};

    const auth = requireAuthOr403(customer);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    if (!(await isCustomerAllowed(auth.email))) {
      return res.status(403).json({ ok: false, error: 'not_authorized' });
    }

    const line_items = (Array.isArray(items) && items.length)
      ? items.map((it) => {
          const qty = Number(it.qty || 1);
          if (it.variant_id) {
            return { variant_id: Number(it.variant_id), quantity: qty };
          }
          // déterminer prix unitaire
          let unit = Number(it.unit_price_cents);
          if (!Number.isFinite(unit) && Number.isFinite(Number(it.line_total_cents)) && qty > 0) {
            unit = Math.round(Number(it.line_total_cents) / qty);
          }
          if (!Number.isFinite(unit) && Number.isFinite(Number(it.price_cents))) {
            unit = Number(it.price_cents);
          }
          return {
            title: it.title || 'Article COD',
            quantity: qty,
            price: Number.isFinite(unit) ? (unit / 100).toFixed(2) : '0.00'
          };
        })
      : [{
          title: 'Paiement à la livraison',
          quantity: 1,
          price: (Number(total_cents) / 100).toFixed(2)
        }];

    const orderPayload = {
      order: {
        email: auth.email || 'client@example.com',
        currency: 'CAD',
        financial_status: 'pending',
        line_items,
        shipping_address,
        note: 'Commande COD (paiement à la livraison)',
        send_receipt: false,
        send_fulfillment_receipt: false
      }
    };

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

    res.json({ ok: true, created: shopifyResp.data });
  } catch (err) {
    console.error('COD ERROR', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message || 'server_error' });
  }
});

/* ===================== HANDLERS ===================== */
async function handlePaymentSuccess(pi) {
  try {
    console.log(`✅ Payment succeeded: ${pi.id}, Amount: ${pi.amount / 100} ${pi.currency}`);
    // Exemple d’update order si tu stockes orderId en metadata
    if (SHOPIFY_ACCESS_TOKEN && SHOP_DOMAIN && pi.metadata?.orderId) {
      const orderPayload = {
        order: {
          id: pi.metadata.orderId,
          financial_status: 'paid',
          transactions: [{
            kind: 'sale',
            status: 'success',
            amount: (pi.amount / 100).toFixed(2),
            currency: (pi.currency || '').toUpperCase()
          }]
        }
      };
      const response = await axios.put(
        `https://${SHOP_DOMAIN}/admin/api/2024-10/orders/${pi.metadata.orderId}.json`,
        orderPayload,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
      console.log('Shopify order updated:', response.data.order.id);
    }
  } catch (err) {
    console.error('Error handling payment success:', err.message);
  }
}

async function handlePaymentFailure(pi) {
  try {
    const lastPaymentError = pi.last_payment_error?.message || 'Unknown error';
    console.log(`⚠️ Payment failed: ${pi.id}, Reason: ${lastPaymentError}`);
    // TODO: notifier le client si besoin
  } catch (err) {
    console.error('Error handling payment failure:', err.message);
  }
}

/* ===================== START ===================== */
app.listen(PORT, () => console.log(`✅ Split server listening on port ${PORT}`));
