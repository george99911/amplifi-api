require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

/** Stripe signature verification requires the raw request body. */
app.use('/webhook', express.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).send('Webhook secret not configured');
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing Stripe-Signature header');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    try {
      await handlePaymentIntentSucceeded(event.data.object);
    } catch (err) {
      console.error('[webhook] payment_intent.succeeded handler failed:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ received: true });
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, occasionId, guestName, childName, message } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || 'gbp',
      metadata: { occasionId, guestName, childName, message },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Amplifi API listening on port ${PORT} (v1.0.0)`);
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function supabaseHeaders(extra = {}) {
  const key = requireEnv('SUPABASE_SERVICE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabaseRest(path, options = {}) {
  const base = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const url = `${base}/rest/v1/${path}`;
  const response = await fetch(url, {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  return response;
}

async function supabaseRestOrThrow(path, options = {}) {
  const response = await supabaseRest(path, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return response;
}

async function incrementOccasionTotalRaised(occasionId, amountPounds) {
  const getRes = await supabaseRestOrThrow(
    `occasions?id=eq.${encodeURIComponent(occasionId)}&select=total_raised`,
    { method: 'GET' },
  );
  const rows = await getRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Occasion not found: ${occasionId}`);
  }

  const current = Number(rows[0].total_raised ?? 0);
  const nextTotal = current + amountPounds;

  await supabaseRestOrThrow(`occasions?id=eq.${encodeURIComponent(occasionId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ total_raised: nextTotal }),
  });

  return nextTotal;
}

async function insertContribution(record) {
  const response = await supabaseRest('contributions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(record),
  });
  if (response.status === 409) {
    return { duplicate: true };
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase POST contributions failed (${response.status}): ${text}`);
  }
  return { duplicate: false };
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  const { occasionId, guestName, childName, message } = paymentIntent.metadata || {};
  const amountPence = paymentIntent.amount;

  if (!occasionId) {
    throw new Error('payment_intent missing metadata.occasionId');
  }
  if (!amountPence || amountPence < 1) {
    throw new Error('payment_intent has invalid amount');
  }

  const amountPounds = amountPence / 100;

  console.log('[webhook] Recording contribution', {
    occasionId,
    guestName,
    childName,
    amountPounds,
    paymentIntentId: paymentIntent.id,
  });

  const insertResult = await insertContribution({
    occasion_id: occasionId,
    guest_name: guestName || null,
    child_name: childName || null,
    amount: amountPounds,
    message: message || null,
    status: 'received',
    stripe_payment_intent_id: paymentIntent.id,
  });

  if (insertResult.duplicate) {
    console.log('[webhook] Contribution already recorded', { paymentIntentId: paymentIntent.id });
    return;
  }

  const nextTotal = await incrementOccasionTotalRaised(occasionId, amountPounds);
  console.log('[webhook] Occasion total_raised updated', { occasionId, nextTotal });
}
