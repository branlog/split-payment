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
app.use(express.static('public')); // sert /pay.html

const {
  PORT = process.env.PORT || 3000,
  STRIPE_SECRET_KEY,
  SHOPIFY_ACCESS_TOKEN,
  SHOP_DOMAIN
} = process.env;

if (!STRIPE_SECRET_KEY) console.warn('⚠️ Missing STRIPE_SECRET_KEY');
if (!SHOPIFY_ACCESS_TOKEN) console.warn('⚠️ Missing SHOPIFY_ACCESS_TOKEN');
if (!SHOP_DOMAIN) console.warn('⚠️ Missing SHOP_DOMAIN');

const stripe = new Stripe(STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// --- utils
const toInt = n => Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0;
const splitItems = (items=[]) => {
  const norm = items.filter(it => it && it.variant_id && it.qty).map(it => ({
    variant_id: Number(it.variant_id),
    qty: Number(it.qty),
    price_cents: toInt(it.price_cents),
    pay_method: it.pay_method === 'cod' ? 'cod' : 'card'
  }));
  const card = [], cod = [];
  for (const it of norm) (it.pay_method === 'cod' ? cod : card).push(it);
  return { card, cod, all: norm };
};
const sumCents = (lines=[]) => lines.reduce((a,l)=>a + toInt(l.price_cents)*toInt(l.qty), 0);
const toShopifyLine = it => ({ variant_id: Number(it.variant_id), quantity: Number(it.qty) });
const shopifyHeaders = () => ({ 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' });
const shopifyBase = () => `https://${SHOP_DOMAIN}/admin/api/2024-10`;

// --- health
app.get('/', (_req,res)=>res.type('text').send('Split checkout server running'));
app.get('/health', (_req,res)=>res.json({ ok:true }));

// --- create
app.post('/checkout/create', async (req,res)=>{
  try{
    const { customer={}, shipping_address={}, items=[] } = req.body || {};
    const { card, cod } = splitItems(items);
    const card_cents = sumCents(card);
    const cod_cents  = sumCents(cod);

    if (card_cents <= 0) {
      return res.json({ ok:true, payment_intent_id:null, client_secret:null,
        amounts:{ card_cents, cod_cents }, echo:{ ok:true, customer, shipping_address, items } });
    }
    if (!STRIPE_SECRET_KEY) return res.status(400).json({ ok:false, error:'Missing STRIPE_SECRET_KEY' });

    const pi = await stripe.paymentIntents.create({
      amount: card_cents,
      currency: 'cad',
      automatic_payment_methods: { enabled: true },
      metadata: { kind:'split-checkout', cod_cents:String(cod_cents) }
    });

    res.json({ ok:true, payment_intent_id: pi.id, client_secret: pi.client_secret,
      amounts:{ card_cents, cod_cents }, echo:{ ok:true, customer, shipping_address, items }});
  }catch(err){
    console.error('CREATE ERROR', err?.message || err);
    res.status(500).json({ ok:false, error: err?.message || 'server_error' });
  }
});

// --- confirm
app.post('/checkout/confirm', async (req,res)=>{
  try{
    const { stripe_payment_intent_id, customer={}, shipping_address={}, items=[] } = req.body || {};
    if (!SHOPIFY_ACCESS_TOKEN || !SHOP_DOMAIN) {
      return res.status(400).json({ ok:false, error:'Missing Shopify credentials' });
    }
    if (stripe_payment_intent_id) {
      try{
        const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
        if (pi.status !== 'succeeded') {
          return res.status(400).json({ ok:false, error:`PaymentIntent not succeeded (${pi.status})` });
        }
      }catch(e){ console.wa
