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

// ---- ENV
const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;

if (!STRIPE_SECRET_KEY) console.warn('⚠️ Missing STRIPE_SECRET_KEY');
if (!SHOPIFY_ACCESS_TOKEN) console.warn('⚠️ Missing SHOPIFY_ACCESS_TOKEN');
if (!SHOP_DOMAIN) console.warn('⚠️ Missing SHOP_DOMAIN');

const stripe = new Stripe(STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// ---- helpers
const toInt = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
};

const splitItems = (items = []) => {
  const normalized = items
    .filter((it) => it && it.variant_id && it.qty)
    .map((it) => ({
      variant_id: Number(it.variant_id),
      qty: Number(it.qty),
      price_cents: toInt(it.price_cents),
      pay_method: it.pay_method === 'cod' ? 'cod' : 'card',
    }));

  const card = [];
