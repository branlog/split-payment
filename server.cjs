// server.js — Split Payment (Express + Stripe Live) — CommonJS

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const bodyParser = require("body-parser");

// ==== ENV ====
require("dotenv").config();
const {
  PORT = 10000,
  NODE_ENV = "production",
  APP_URL = "",
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  WEBHOOK_SECRET, // whsec_...
  ALLOWED_ORIGINS = "https://logtek.ca,https://2uvcbu-ci.myshopify.com,https://split-payment-uymv.onrender.com",
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY manquant.");
  process.exit(1);
}
if (!STRIPE_PUBLISHABLE_KEY) {
  console.error("❌ STRIPE_PUBLISHABLE_KEY manquant.");
  process.exit(1);
}

const stripe = require("stripe")(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ==== APP ====
const app = express();

// Trust proxy (Render)
app.set("trust proxy", true);

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // on simplifie pour la démo
  })
);

// Logs
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

// CORS strict
const allowList = ALLOWED_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // autorise aussi les requêtes server-to-server (no origin)
      if (!origin || allowList.includes(origin)) return cb(null, true);
      return cb(new Error("CORS bloque: " + origin));
    },
    credentials: false,
  })
);

// JSON pour toutes les routes SAUF webhook (ci-dessous on utilisera raw)
app.use((req, res, next) => {
  if (req.path === "/stripe/webhook") return next(); // on saute (raw plus bas)
  bodyParser.json({ limit: "1mb" })(req, res, next);
});

// ==== ROUTES ====

app.get("/health", (req, res) => {
  res.json({ ok: true, env: NODE_ENV, url: APP_URL || "n/a" });
});

/**
 * Expose la publishable key au front
 */
app.get("/api/config", (_req, res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

/**
 * Crée un PaymentIntent
 * body: { amount, currency, description, metadata, customer_email }
 * - amount en cents (ex: 3998 pour 39.98 CAD)
 * - currency par défaut: 'cad'
 */
app.post("/api/payment-intents", async (req, res) => {
  try {
    const {
      amount, // integer en cents
      currency = "cad",
      description,
      metadata = {},
      customer_email,
      // si tu veux autoriser "capture later", ajoute capture_method:'manual'
    } = req.body || {};

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "amount (cents) requis > 0" });
    }

    const params = {
      amount,
      currency,
      description,
      metadata,
      automatic_payment_methods: { enabled: true },
    };

    // Si tu veux attacher un customer_email en "receipt_email"
    if (customer_email) params.receipt_email = customer_email;

    const pi = await stripe.paymentIntents.create(params);
    return res.json({
      id: pi.id,
      client_secret: pi.client_secret,
      status: pi.status,
      next_action: pi.next_action,
    });
  } catch (err) {
    console.error("PI create error:", err);
    res.status(500).json({ error: err.message || "Stripe error" });
  }
});

/**
 * Webhook Stripe — body RAW + vérification signature
 * Configure dans Stripe:
 *  - endpoint: https://<ton-service>.onrender.com/stripe/webhook
 *  - events: payment_intent.succeeded, payment_intent.payment_failed, ...
 */
app.post(
  "/stripe/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!WEBHOOK_SECRET) {
      console.warn("⚠️ WEBHOOK_SECRET non configuré, on ignore la vérification.");
    }

    let event;
    try {
      event = WEBHOOK_SECRET
        ? stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET)
        : JSON.parse(req.body.toString()); // non recommandé en prod
    } catch (err) {
      console.error("❌ Webhook signature invalide:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Traite les événements utiles
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        console.log("✅ PI Succeeded:", pi.id, pi.amount, pi.currency);
        // TODO: marquer la commande "payée", envoyer email, etc.
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        console.log("❌ PI Failed:", pi.id, pi.last_payment_error?.message);
        // TODO: notifier échec
        break;
      }
      default:
        console.log("ℹ️ Webhook reçu:", event.type);
    }

    res.json({ received: true });
  }
);

// ==== Page de test : /pay.html ====
// Petite page Stripe Elements qui:
// - lit ?secret=... (client_secret) ou appelle /api/payment-intents si amount fourni
// - lit ?pk= pour override la publishable key (sinon /api/config)
app.get("/pay.html", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Paiement test (carte / COD / Split)</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
    .row { margin-bottom: 12px; }
    #card-element { padding: 10px; border: 1px solid #ddd; border-radius: 6px; }
    button { padding: 10px 14px; border-radius: 6px; border: none; background: #111; color: #fff; cursor: pointer; }
    button[disabled] { opacity: .5; cursor: not-allowed; }
    .muted { color: #666; font-size: 12px; }
    pre { background:#f6f6f6; padding:10px; border-radius:6px; }
  </style>
  <script src="https://js.stripe.com/v3/"></script>
</head>
<body>
  <h2>Paiement test (carte / COD / Split)</h2>

  <div class="row">
    <label>Client Secret :</label><br/>
    <input id="client_secret" style="width:100%" placeholder="pi_xxx_secret_xxx" />
  </div>

  <div class="row">
    <label>Stripe Publishable Key :</label><br/>
    <input id="pk" style="width:100%" placeholder="pk_live_xxx (ou laissé vide)" />
    <div class="muted">Si vide, la page appelle /api/config pour récupérer la clé publique.</div>
  </div>

  <div class="row">
    <button id="prefill">Prérremplir via l'URL</button>
  </div>

  <div class="row">
    <div id="card-element"></div>
  </div>

  <div class="row">
    <button id="payNow">Payer maintenant</button>
    <button id="cod" style="margin-left:8px; background:#2b6cb0;">Paiement à la livraison</button>
  </div>

  <p class="muted">Carte test: 4242 4242 4242 4242 · date future · CVC 123 (en mode test seulement)</p>

  <h3>Résultat</h3>
  <pre id="out">{ "hint": "Si tu n'as pas de client_secret, crée d'abord un PaymentIntent côté serveur (POST /api/payment-intents) et colle-le ici, ou ajoute ?secret=...&pk=..." }</pre>

<script>
const out = (x) => {
  const el = document.getElementById('out');
  el.textContent = (typeof x === 'string') ? x : JSON.stringify(x, null, 2);
};

// helpers query
const params = new URLSearchParams(location.search);
const qsSecret = params.get('secret');
const qsPk = params.get('pk');

const elSecret = document.getElementById('client_secret');
const elPk = document.getElementById('pk');
const btnPrefill = document.getElementById('prefill');
const btnPay = document.getElementById('payNow');
const btnCOD = document.getElementById('cod');

btnPrefill.onclick = () => {
  if (qsSecret) elSecret.value = qsSecret;
  if (qsPk) elPk.value = qsPk;
};

let stripe, elements, card;

(async function init(){
  try {
    let pk = qsPk || (elPk.value || null);
    if (!pk) {
      const r = await fetch('/api/config');
      const j = await r.json();
      pk = j.publishableKey;
    }
    if (!pk) { out({error:'Aucune publishable key'}); return; }

    // init Stripe
    stripe = Stripe(pk);
    elements = stripe.elements();
    card = elements.create('card');
    card.mount('#card-element');

    out('Stripe initialisé. Entre le client_secret puis clique "Payer maintenant".');
  } catch (e) {
    out(e);
  }
})();

btnPay.onclick = async () => {
  try {
    const clientSecret = elSecret.value || qsSecret;
    if (!clientSecret) {
      out({error:'client_secret manquant. Crée PI => /api/payment-intents'});
      return;
    }
    const { paymentIntent, error } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card,
      },
    });
    if (error) return out({ error: error.message });
    out(paymentIntent);
  } catch (e) {
    out(e);
  }
};

btnCOD.onclick = () => {
  out({ ok:true, mode:'COD', note:'Ici tu ferais ton flux paiement à la livraison (sans Stripe) / ou création d’un PI 0€ + capture plus tard.' });
};
</script>
</body>
</html>`);
});

// ==== LANCEMENT ====
app.listen(PORT, () => {
  console.log(`✅ Server up on port ${PORT}`);
  if (APP_URL) console.log(`   Health: ${APP_URL}/health`);
});
