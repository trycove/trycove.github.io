Stripe Worker Setup

This worker provides:
- POST /create-checkout-session
- POST /create-portal-session
- POST /stripe-webhook
- GET /health

1) Configure worker
- Copy wrangler.toml.example to wrangler.toml
- Fill vars for Supabase URL/anon key/table and Stripe price IDs (monthly/yearly, plus optional unplugged bundle price)
- Set secrets:
  - wrangler secret put STRIPE_SECRET_KEY
  - wrangler secret put STRIPE_WEBHOOK_SECRET
  - wrangler secret put SUPABASE_SERVICE_ROLE_KEY

2) Deploy
- wrangler deploy

3) Stripe webhook
- In Stripe Dashboard, add endpoint:
  https://YOUR_WORKER_DOMAIN/stripe-webhook
- Listen to events:
  - checkout.session.completed
  - invoice.paid
    - customer.subscription.updated
    - customer.subscription.deleted
- Copy webhook secret into STRIPE_WEBHOOK_SECRET

4) Frontend config in index.html runtime
Set before app script loads:
window.STRIPE_PUBLISHABLE_KEY = 'pk_live_xxx';
window.STRIPE_CHECKOUT_ENDPOINT = 'https://YOUR_WORKER_DOMAIN/create-checkout-session';
window.STRIPE_PORTAL_ENDPOINT = 'https://YOUR_WORKER_DOMAIN/create-portal-session';
window.STRIPE_PRICE_MONTHLY = 'price_xxx_monthly';
window.STRIPE_PRICE_YEARLY = 'price_xxx_yearly';
window.STRIPE_PRICE_UNPLUGGED = 'price_xxx_unplugged';

5) Supabase expectation
- Table dream_sync_state should have columns:
  - user_id (text/uuid, unique)
  - payload (json/jsonb)
  - plan (text)
  - updated_at (timestamptz)
- Worker upserts plan='paid' for matching user_id after successful Stripe events.

Notes
- This worker keeps CORS allowlist strict via ALLOWED_ORIGINS.
- It updates plan to paid/free from Stripe subscription lifecycle events.
