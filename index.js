const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// Regular endpoint for creating checkout sessions
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

    // Free plan - no payment
    if (planType === 'free') {
      await supabase
        .from('child_subscriptions')
        .upsert({
          child_id: childId,
          parent_id: parentId,
          plan_type: 'free',
          status: 'active',
          updated_at: new Date().toISOString(),
        });

      return res.json({ success: true, planType: 'free' });
    }

    const prices = { premium: 1299, elite: 2499 };
    const appScheme = isDevelopment ? 'exp' : 'edutab';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${planType.toUpperCase()} Plan - ${childName}`,
          },
          unit_amount: prices[planType],
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${appScheme}://payment-success?child_id=${childId}&plan=${planType}`,
      cancel_url: `${appScheme}://payment-cancelled`,
      customer_email: parentEmail,
      metadata: {
        child_id: childId,
        parent_id: parentId,
        plan_type: planType,
      },
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('Error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Webhook endpoint (must be raw body)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('Missing webhook secret');
    return res.status(500).send('Webhook secret not configured');
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log('Event type:', event.type);

    // Handle checkout completion
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { child_id, parent_id, plan_type } = session.metadata;

      console.log(`Processing: child ${child_id}, plan ${plan_type}`);

      // Update subscription in Supabase
      const { error } = await supabase
        .from('child_subscriptions')
        .upsert({
          child_id: child_id,
          parent_id: parent_id,
          plan_type: plan_type,
          status: 'active',
          stripe_subscription_id: session.subscription,
          stripe_customer_id: session.customer,
          start_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (error) {
        console.error('Supabase error:', error);
        return res.status(500).json({ error: error.message });
      }

      console.log('Subscription updated successfully!');

      // Create notification
      await supabase
        .from('notifications')
        .insert({
          user_id: parent_id,
          title: 'Subscription Activated',
          message: `${plan_type?.toUpperCase()} plan activated!`,
          type: 'subscription',
          created_at: new Date().toISOString(),
        });
    }

    // Handle cancellation
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      
      await supabase
        .from('child_subscriptions')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', subscription.id);
      
      console.log('Subscription cancelled');
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});