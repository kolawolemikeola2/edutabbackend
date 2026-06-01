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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create checkout session endpoint
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

    console.log('Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

    // Free plan - no payment needed
    if (planType === 'free') {
      const { error } = await supabase
        .from('child_subscriptions')
        .upsert({
          child_id: childId,
          parent_id: parentId,
          plan_type: 'free',
          status: 'active',
          updated_at: new Date().toISOString(),
        });

      if (error) {
        console.error('Error updating free plan:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true, planType: 'free' });
    }

    // Price mapping (in cents)
    const prices = {
      premium: 1299,  // $12.99
      elite: 2499     // $24.99
    };

    if (!prices[planType]) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    // App scheme for deep linking
    const appScheme = isDevelopment ? 'exp' : 'edutab';

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${planType.toUpperCase()} Plan - ${childName}`,
            description: `Monthly subscription for ${childName}`,
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
        child_name: childName,
      },
    });

    console.log('Checkout session created:', session.id);
    res.json({ success: true, url: session.url });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(400).json({ error: error.message });
  }
});

// Webhook endpoint (must use raw body for Stripe signature verification)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).send('Webhook secret not configured');
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log('Webhook event type:', event.type);

    // Handle successful checkout
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { child_id, parent_id, plan_type } = session.metadata;

      console.log(`Processing successful payment for child: ${child_id}, plan: ${plan_type}`);

      // Update subscription in Supabase
      const { data, error } = await supabase
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
        })
        .select();

      if (error) {
        console.error('Supabase upsert error:', error);
        return res.status(500).json({ error: error.message });
      }

      console.log('Subscription updated successfully:', data);

      // Create notification for parent
      const { error: notifError } = await supabase
        .from('notifications')
        .insert({
          user_id: parent_id,
          title: 'Subscription Activated',
          message: `${plan_type?.toUpperCase()} plan has been activated for your child!`,
          type: 'subscription',
          created_at: new Date().toISOString(),
        });

      if (notifError) {
        console.error('Error creating notification:', notifError);
      }
    }

    // Handle subscription cancellation
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      
      console.log('Processing subscription cancellation:', subscription.id);

      const { error } = await supabase
        .from('child_subscriptions')
        .update({ 
          status: 'cancelled', 
          updated_at: new Date().toISOString() 
        })
        .eq('stripe_subscription_id', subscription.id);

      if (error) {
        console.error('Error cancelling subscription:', error);
        return res.status(500).json({ error: error.message });
      }

      console.log('Subscription cancelled successfully');
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Verify payment endpoint
app.get('/api/verify-payment/:childId', async (req, res) => {
  try {
    const { childId } = req.params;
    
    const { data, error } = await supabase
      .from('child_subscriptions')
      .select('*')
      .eq('child_id', childId)
      .single();
    
    if (error) {
      // No subscription found, return free plan
      if (error.code === 'PGRST116') {
        return res.json({ 
          success: true, 
          subscription: { plan_type: 'free', status: 'active' } 
        });
      }
      throw error;
    }
    
    res.json({ success: true, subscription: data });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get child's current subscription
app.get('/api/child-subscription/:childId', async (req, res) => {
  try {
    const { childId } = req.params;
    
    const { data, error } = await supabase
      .from('child_subscriptions')
      .select('*')
      .eq('child_id', childId)
      .maybeSingle();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      subscription: data || { plan_type: 'free', status: 'active' } 
    });
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`💳 Create checkout: http://localhost:${PORT}/api/create-checkout`);
});







// const express = require('express');
// const cors = require('cors');
// const Stripe = require('stripe');
// const { createClient } = require('@supabase/supabase-js');
// require('dotenv').config();

// const app = express();
// const PORT = process.env.PORT || 3000;

// // Initialize Stripe
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// // Initialize Supabase
// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_SERVICE_ROLE_KEY
// );

// // Middleware
// app.use(cors());
// app.use(express.json());

// // Regular endpoint for creating checkout sessions
// app.post('/api/create-checkout', async (req, res) => {
//   try {
//     const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

//     // Free plan - no payment
//     if (planType === 'free') {
//       await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: childId,
//           parent_id: parentId,
//           plan_type: 'free',
//           status: 'active',
//           updated_at: new Date().toISOString(),
//         });

//       return res.json({ success: true, planType: 'free' });
//     }

//     const prices = { premium: 1299, elite: 2499 };
//     const appScheme = isDevelopment ? 'exp' : 'edutab';

//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: {
//             name: `${planType.toUpperCase()} Plan - ${childName}`,
//           },
//           unit_amount: prices[planType],
//           recurring: { interval: 'month' },
//         },
//         quantity: 1,
//       }],
//       mode: 'subscription',
//       success_url: `${appScheme}://payment-success?child_id=${childId}&plan=${planType}`,
//       cancel_url: `${appScheme}://payment-cancelled`,
//       customer_email: parentEmail,
//       metadata: {
//         child_id: childId,
//         parent_id: parentId,
//         plan_type: planType,
//       },
//     });

//     res.json({ success: true, url: session.url });
//   } catch (error) {
//     console.error('Error:', error);
//     res.status(400).json({ error: error.message });
//   }
// });

// // Webhook endpoint (must be raw body)
// app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//   if (!webhookSecret) {
//     console.error('Missing webhook secret');
//     return res.status(500).send('Webhook secret not configured');
//   }

//   try {
//     const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
//     console.log('Event type:', event.type);

//     // Handle checkout completion
//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object;
//       const { child_id, parent_id, plan_type } = session.metadata;

//       console.log(`Processing: child ${child_id}, plan ${plan_type}`);

//       // Update subscription in Supabase
//       const { error } = await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: child_id,
//           parent_id: parent_id,
//           plan_type: plan_type,
//           status: 'active',
//           stripe_subscription_id: session.subscription,
//           stripe_customer_id: session.customer,
//           start_date: new Date().toISOString(),
//           updated_at: new Date().toISOString(),
//         });

//       if (error) {
//         console.error('Supabase error:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('Subscription updated successfully!');

//       // Create notification
//       await supabase
//         .from('notifications')
//         .insert({
//           user_id: parent_id,
//           title: 'Subscription Activated',
//           message: `${plan_type?.toUpperCase()} plan activated!`,
//           type: 'subscription',
//           created_at: new Date().toISOString(),
//         });
//     }

//     // Handle cancellation
//     if (event.type === 'customer.subscription.deleted') {
//       const subscription = event.data.object;
      
//       await supabase
//         .from('child_subscriptions')
//         .update({ status: 'cancelled', updated_at: new Date().toISOString() })
//         .eq('stripe_subscription_id', subscription.id);
      
//       console.log('Subscription cancelled');
//     }

//     res.json({ received: true });
//   } catch (err) {
//     console.error('Webhook error:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }
// });

// // Health check
// app.get('/health', (req, res) => {
//   res.json({ status: 'ok' });
// });

// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });
