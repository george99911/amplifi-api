require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
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
