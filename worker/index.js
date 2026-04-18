const DEFAULT_ALLOWED_ORIGINS = [
  'https://trycove.app',
  'https://www.trycove.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

function getAllowedOrigins(env) {
  const fromEnv = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
}

function withCorsHeaders(req, env, headers = {}) {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigins = getAllowedOrigins(env);
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...headers
  };
}

function toFormBody(obj) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    params.set(k, String(v));
  });
  return params;
}

function normalizePlan(input) {
  return String(input || '').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
}

function normalizeCloudPlan(input) {
  return String(input || '').toLowerCase() === 'paid' ? 'paid' : 'free';
}

function mustEnv(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function isHttpsUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function createStripeCheckoutSession(req, env) {
  const monthlyPrice = String(env.STRIPE_PRICE_MONTHLY || '').trim();
  const yearlyPrice = String(env.STRIPE_PRICE_YEARLY || '').trim();
  const unpluggedPrice = String(env.STRIPE_PRICE_UNPLUGGED || '').trim();

  const payload = await req.json().catch(() => ({}));
  const plan = normalizePlan(payload.plan);
  const fallbackPriceId = plan === 'yearly' ? yearlyPrice : monthlyPrice;
  const requestedPriceId = String(payload.priceId || '').trim();
  const selectedPriceId = requestedPriceId || fallbackPriceId;
  const requireShippingAddress = Boolean(payload.requireShippingAddress);

  if (!selectedPriceId) {
    return json({ error: 'No Stripe price id configured for selected plan.' }, 400, withCorsHeaders(req, env));
  }

  const allowedRequestedPrices = [monthlyPrice, yearlyPrice, unpluggedPrice].filter(Boolean);
  if (requestedPriceId && !allowedRequestedPrices.includes(requestedPriceId)) {
    return json({ error: 'Invalid price id.' }, 400, withCorsHeaders(req, env));
  }

  const shouldCollectShipping = requireShippingAddress || (Boolean(unpluggedPrice) && selectedPriceId === unpluggedPrice);

  const successUrl = String(payload.successUrl || '').trim();
  const cancelUrl = String(payload.cancelUrl || '').trim();
  if (!isHttpsUrl(successUrl) || !isHttpsUrl(cancelUrl)) {
    return json({ error: 'Invalid success/cancel url. HTTPS required.' }, 400, withCorsHeaders(req, env));
  }

  const userId = String(payload.userId || '').trim();
  const email = String(payload.customerEmail || '').trim();
  const customerId = email ? await getOrCreateStripeCustomer({ email, userId }, env) : '';

  const body = toFormBody({
    mode: 'subscription',
    'line_items[0][price]': selectedPriceId,
    'line_items[0][quantity]': 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(userId ? {
      client_reference_id: userId,
      'metadata[user_id]': userId,
      'subscription_data[metadata][user_id]': userId
    } : {}),
    ...(shouldCollectShipping ? {
      'shipping_address_collection[allowed_countries][0]': 'US',
      'shipping_address_collection[allowed_countries][1]': 'CA'
    } : {}),
    ...(customerId ? { customer: customerId } : {}),
    ...(!customerId && email ? { customer_email: email } : {})
  });

  const stripeRes = await stripeRequest(env, 'POST', '/v1/checkout/sessions', body);
  const stripeJson = await stripeRes.json().catch(() => ({}));
  if (!stripeRes.ok) {
    return json(
      { error: stripeJson?.error?.message || `Stripe error (${stripeRes.status})` },
      stripeRes.status,
      withCorsHeaders(req, env)
    );
  }

  return json(
    { sessionId: stripeJson.id, url: stripeJson.url || '' },
    200,
    withCorsHeaders(req, env)
  );
}

async function stripeRequest(env, method, path, bodyParams = null) {
  const stripeSecret = mustEnv(env, 'STRIPE_SECRET_KEY');
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${stripeSecret}`
    }
  };
  if (bodyParams instanceof URLSearchParams) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = bodyParams;
  }
  return fetch(`https://api.stripe.com${path}`, init);
}

async function getOrCreateStripeCustomer({ email = '', userId = '' }, env) {
  const safeEmail = String(email || '').trim().toLowerCase();
  const safeUserId = String(userId || '').trim();
  if (!safeEmail) return '';

  const listRes = await stripeRequest(env, 'GET', `/v1/customers?email=${encodeURIComponent(safeEmail)}&limit=10`);
  const listJson = await listRes.json().catch(() => ({}));
  if (listRes.ok && Array.isArray(listJson?.data) && listJson.data.length) {
    const exact = listJson.data.find(customer => String(customer?.metadata?.user_id || '').trim() === safeUserId);
    if (exact?.id) return String(exact.id);
    const first = listJson.data[0];
    if (first?.id) {
      if (safeUserId && String(first?.metadata?.user_id || '').trim() !== safeUserId) {
        const updateBody = toFormBody({ 'metadata[user_id]': safeUserId });
        await stripeRequest(env, 'POST', `/v1/customers/${encodeURIComponent(first.id)}`, updateBody);
      }
      return String(first.id);
    }
  }

  const createBody = toFormBody({
    email: safeEmail,
    ...(safeUserId ? { 'metadata[user_id]': safeUserId } : {})
  });
  const createRes = await stripeRequest(env, 'POST', '/v1/customers', createBody);
  const createJson = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createJson?.id) {
    throw new Error(createJson?.error?.message || 'Could not create Stripe customer.');
  }
  return String(createJson.id);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyStripeWebhook(req, env, rawBody) {
  const secret = mustEnv(env, 'STRIPE_WEBHOOK_SECRET');
  const header = String(req.headers.get('Stripe-Signature') || '');
  const parts = header.split(',').map(v => v.trim());
  const tPart = parts.find(v => v.startsWith('t='));
  const v1Part = parts.find(v => v.startsWith('v1='));
  if (!tPart || !v1Part) return false;

  const timestamp = tPart.slice(2);
  const sigHex = v1Part.slice(3);
  if (!timestamp || !sigHex) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = new Uint8Array(digest);
  const given = hexToBytes(sigHex);
  return timingSafeEqual(expected, given);
}

async function upsertUserPlan(userId, env, plan = 'free') {
  const supabaseUrl = mustEnv(env, 'SUPABASE_URL');
  const serviceRole = mustEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const table = String(env.SUPABASE_SYNC_TABLE || 'dream_sync_state').trim();
  const nextPlan = normalizeCloudPlan(plan);

  const upsertUrl = `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}?on_conflict=user_id`;
  const now = new Date().toISOString();
  const payload = [
    {
      user_id: userId,
      payload: {},
      plan: nextPlan,
      updated_at: now
    }
  ];

  const res = await fetch(upsertUrl, {
    method: 'POST',
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Supabase upsert failed (${res.status})`);
  }
}

function extractUserIdFromStripeObject(obj = {}) {
  return String(
    obj?.metadata?.user_id ||
    obj?.client_reference_id ||
    obj?.subscription_details?.metadata?.user_id ||
    ''
  ).trim();
}

async function verifySupabaseUserFromToken(req, env) {
  const authHeader = String(req.headers.get('Authorization') || '').trim();
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) throw new Error('Missing bearer token.');
  const supabaseUrl = mustEnv(env, 'SUPABASE_URL');
  const supabaseAnon = mustEnv(env, 'SUPABASE_ANON_KEY');

  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnon,
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error('Could not verify session token.');
  const user = await res.json().catch(() => null);
  if (!user?.id) throw new Error('Invalid user session.');
  return user;
}

async function createPortalSession(req, env) {
  const user = await verifySupabaseUserFromToken(req, env);
  const payload = await req.json().catch(() => ({}));
  const returnUrl = String(payload?.returnUrl || '').trim();
  if (!isHttpsUrl(returnUrl)) {
    return json({ error: 'Invalid return url. HTTPS required.' }, 400, withCorsHeaders(req, env));
  }

  const email = String(user?.email || '').trim();
  const userId = String(user?.id || '').trim();
  const customerId = await getOrCreateStripeCustomer({ email, userId }, env);
  if (!customerId) {
    return json({ error: 'No Stripe customer found for this account.' }, 404, withCorsHeaders(req, env));
  }

  const body = toFormBody({ customer: customerId, return_url: returnUrl });
  const stripeRes = await stripeRequest(env, 'POST', '/v1/billing_portal/sessions', body);
  const stripeJson = await stripeRes.json().catch(() => ({}));
  if (!stripeRes.ok || !stripeJson?.url) {
    return json(
      { error: stripeJson?.error?.message || `Stripe portal error (${stripeRes.status})` },
      stripeRes.status,
      withCorsHeaders(req, env)
    );
  }

  return json({ url: String(stripeJson.url) }, 200, withCorsHeaders(req, env));
}

async function handleStripeWebhook(req, env) {
  const rawBody = await req.text();
  const verified = await verifyStripeWebhook(req, env, rawBody);
  if (!verified) return json({ error: 'Invalid Stripe signature.' }, 400);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON payload.' }, 400);
  }

  const type = String(event?.type || '');
  const obj = event?.data?.object || {};
  const userId = extractUserIdFromStripeObject(obj);

  if (userId) {
    if (type === 'checkout.session.completed' || type === 'invoice.paid') {
      await upsertUserPlan(userId, env, 'paid');
    }

    if (type === 'customer.subscription.deleted') {
      await upsertUserPlan(userId, env, 'free');
    }

    if (type === 'customer.subscription.updated') {
      const status = String(obj?.status || '').toLowerCase();
      const isPaidLike = ['active', 'trialing', 'past_due', 'incomplete'].includes(status);
      await upsertUserPlan(userId, env, isPaidLike ? 'paid' : 'free');
    }
  }

  return json({ received: true }, 200);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCorsHeaders(req, env) });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return json({ ok: true, service: 'stripe-checkout-worker' }, 200, withCorsHeaders(req, env));
    }

    if (url.pathname === '/create-checkout-session' && req.method === 'POST') {
      try {
        return await createStripeCheckoutSession(req, env);
      } catch (err) {
        return json({ error: err?.message || 'Checkout session creation failed.' }, 500, withCorsHeaders(req, env));
      }
    }

    if (url.pathname === '/create-portal-session' && req.method === 'POST') {
      try {
        return await createPortalSession(req, env);
      } catch (err) {
        return json({ error: err?.message || 'Portal session creation failed.' }, 500, withCorsHeaders(req, env));
      }
    }

    if (url.pathname === '/stripe-webhook' && req.method === 'POST') {
      try {
        return await handleStripeWebhook(req, env);
      } catch (err) {
        return json({ error: err?.message || 'Webhook processing failed.' }, 500);
      }
    }

    return json({ error: 'Not found' }, 404, withCorsHeaders(req, env));
  }
};
