
# Split Checkout Server (Shopify + Stripe) — Card Now & COD

This boilerplate lets you:
- Let the buyer choose per line item: **pay now (card)** or **pay on delivery (COD)**
- Charge the **card** portion via Stripe
- Create **two Shopify orders**: one **paid**, one **pending/COD**

## Quick Start
1. Install Node 18+
2. `npm install`
3. Copy `.env.example` to `.env` and fill values
4. `npm run dev`
5. Use the example JSON below to call the endpoints with Postman or curl.

## Endpoints
### POST /checkout/create
Body:
{
  "customer": {"email":"buyer@example.com"},
  "shipping_address": {"first_name":"John","last_name":"Doe","address1":"123 Main","city":"Quebec","country":"CA"},
  "items": [
    {"variant_id": 123, "qty": 1, "price_cents": 2599, "pay_method": "card"},
    {"variant_id": 456, "qty": 2, "price_cents": 899,  "pay_method": "cod"}
  ]
}
Response includes `client_secret` if a card portion exists.

### POST /checkout/confirm
Body:
{
  "stripe_payment_intent_id": "pi_xxx", // optional if no card portion
  "customer": {"email":"buyer@example.com"},
  "shipping_address": {"first_name":"John","last_name":"Doe","address1":"123 Main","city":"Quebec","country":"CA"},
  "items": [
    {"variant_id": 123, "qty": 1, "price_cents": 2599, "pay_method": "card"},
    {"variant_id": 456, "qty": 2, "price_cents": 899,  "pay_method": "cod"}
  ]
}
Creates 1 or 2 Shopify orders depending on items.

## Notes
- Taxes & shipping: keep simple at first; add your logic later.
- For marketplace payouts to vendors, add Stripe Connect transfer logic.
- Secure your server and set proper webhook verification in production.
