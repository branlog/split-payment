
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
app.post('/checkout/confirm', async (req, res) => {
  try {
    const { customer, shipping_address, items, stripe_payment_intent_id } = req.body;

    if (stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
      if (pi.status !== 'succeeded') {
        return res.status(400).json({ error: 'payment_not_succeeded', status: pi.status });
      }
    }

    const cardItems = items.filter(i => i.pay_method === 'card');
    const codItems  = items.filter(i => i.pay_method === 'cod');

    const toLineItems = (arr) => arr.map(i => ({
      variant_id: i.variant_id,
      quantity: i.qty
    }));

    let created = {};

    if (cardItems.length > 0) {
      const paidPayload = {
        line_items: toLineItems(cardItems),
        financial_status: 'paid',
        transactions: [{
          kind: 'sale',
          status: 'success',
          amount: (cardItems.reduce((s,i)=>s + (i.price_cents*i.qty),0) / 100).toFixed(2),
          gateway: 'stripe'
        }],
        shipping_address,
        customer,
        note_attributes: [{ name: 'split_group', value: 'card' }]
      };
      const paidOrder = await createShopifyOrder(paidPayload);
      created.paid_order = paidOrder;
    }

    if (codItems.length > 0) {
      const codPayload = {
        line_items: toLineItems(codItems),
        financial_status: 'pending',
        transactions: [{
          kind: 'authorization',
          status: 'pending',
          amount: (codItems.reduce((s,i)=>s + (i.price_cents*i.qty),0) / 100).toFixed(2),
          gateway: 'cash_on_delivery'
        }],
        shipping_address,
        customer,
        note_attributes: [{ name: 'split_group', value: 'cod' }]
      };
      const codOrder = await createShopifyOrder(codPayload);
      created.cod_order = codOrder;
    }

    res.json({ ok: true, created });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'server_error', detail: err.response?.data || err.message });
  }
});

app.get('/', (req, res) => res.send('Split checkout server running'));
app.listen(process.env.PORT || 3000, () => console.log(`✅ Server on http://localhost:${process.env.PORT || 3000}`));
