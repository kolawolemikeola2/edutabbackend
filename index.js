const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Stripe with live key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia',
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Enable CORS
app.use(cors());

// ─── PLAN DEFINITIONS (Pricing in GBP £) ──────────────────────────────────
const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 499,      // £4.99 in pence
    currency: 'gbp',
    description: 'Games + 7-day trial for worksheets & recorded videos',
    tier: 'starter',
    requiresPayment: false,
    ageGroup: 'young',
    priceDisplay: '£4.99',
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    price: 1299,     // £12.99 in pence
    currency: 'gbp',
    description: 'Games, worksheets, recorded sessions + AI Assistant',
    tier: 'premium',
    requiresPayment: true,
    ageGroup: 'young',
    priceDisplay: '£12.99',
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    price: 3099,     // £30.99 in pence
    currency: 'gbp',
    description: 'Everything in Premium + Live sessions + Exam support + Readers Club',
    tier: 'elite',
    requiresPayment: true,
    ageGroup: 'young',
    priceDisplay: '£30.99',
  },
  premium_older: {
    id: 'premium_older',
    name: 'Premium 11+',
    price: 5000,     // £50.00 in pence
    currency: 'gbp',
    description: 'Maths, English, Science + Ethics & Values + 2 LIVE sessions/week',
    tier: 'premium',
    requiresPayment: true,
    ageGroup: 'older',
    priceDisplay: '£50.00',
  },
  elite_older: {
    id: 'elite_older',
    name: 'Elite 11+',
    price: 7000,     // £70.00 in pence
    currency: 'gbp',
    description: 'Everything in Premium 11+ + Reading groups + Discussion groups + Exam prep',
    tier: 'elite',
    requiresPayment: true,
    ageGroup: 'older',
    priceDisplay: '£70.00',
  },
};

// ─── LEGACY PLAN MAPPING ──────────────────────────────────────────────────
const LEGACY_MAP = {
  'free': 'starter',
  'premium': 'premium',
  'elite': 'elite',
};

const getPlanDetails = (planType) => {
  const mappedId = LEGACY_MAP[planType] || planType;
  return PLANS[mappedId] || null;
};

// ─── WEBHOOK ──────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  console.log('📨 Webhook received - signature present:', !!sig);
  console.log('🔐 Webhook secret present:', !!webhookSecret);

  if (!webhookSecret) {
    console.error('❌ Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).send('Webhook secret not configured');
  }

  if (!sig) {
    console.error('❌ No stripe-signature header');
    return res.status(400).send('No signature header');
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log('✅ Webhook event type:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { child_id, parent_id, plan_type, child_name, age_group } = session.metadata;

      console.log(`💰 Processing payment for child: ${child_id}, plan: ${plan_type}`);

      let ageGroup = age_group;
      if (!ageGroup) {
        const { data: child } = await supabase
          .from('children')
          .select('age')
          .eq('id', child_id)
          .single();
        ageGroup = (child?.age || 0) <= 10 ? 'young' : 'older';
      }

      const plan = getPlanDetails(plan_type);
      const planTier = plan?.tier || 'starter';

      const subscriptionData = {
        child_id: child_id,
        parent_id: parent_id,
        plan_type: plan_type,
        plan_tier: planTier,
        age_group: ageGroup,
        status: 'active',
        updated_at: new Date().toISOString(),
        stripe_subscription_id: session.subscription,
      };
      
      const { data: existing } = await supabase
        .from('child_subscriptions')
        .select('id')
        .eq('child_id', child_id)
        .maybeSingle();
        
      if (!existing) {
        subscriptionData.start_date = new Date().toISOString();
      }

      console.log('📝 Upserting subscription data:', subscriptionData);

      const { data, error } = await supabase
        .from('child_subscriptions')
        .upsert(subscriptionData)
        .select();

      if (error) {
        console.error('❌ Supabase upsert error:', error);
        return res.status(500).json({ error: error.message });
      }

      console.log('✅ Subscription updated successfully:', data);

      const planName = plan?.name || plan_type;
      const { error: notifError } = await supabase
        .from('parent_notifications')
        .insert({
          user_id: parent_id,
          title: '🎉 Subscription Activated!',
          message: `${planName} plan has been activated for ${child_name || 'your child'}!`,
          type: 'subscription',
          created_at: new Date().toISOString(),
        });

      if (notifError) {
        console.error('⚠️ Error creating notification:', notifError);
      } else {
        console.log('✅ Notification created for parent');
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      console.log(`❌ Processing subscription cancellation: ${subscription.id}`);
      
      const { error } = await supabase
        .from('child_subscriptions')
        .update({ 
          status: 'cancelled',
          updated_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscription.id);

      if (error) {
        console.error('⚠️ Error updating cancelled subscription:', error);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────
app.use(express.json());

// ─── HEALTH CHECK ──────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    stripeMode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : 'TEST',
    plans: Object.keys(PLANS),
  });
});

// ─── CREATE CHECKOUT SESSION ───────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

    console.log('🚀 Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

    if (!childId || !childName || !planType || !parentId || !parentEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data: child, error: childError } = await supabase
      .from('children')
      .select('age')
      .eq('id', childId)
      .single();

    if (childError) {
      console.error('Error fetching child age:', childError);
      return res.status(500).json({ error: 'Could not fetch child data' });
    }

    const age = child?.age || 0;
    const ageGroup = age <= 10 ? 'young' : 'older';

    const plan = getPlanDetails(planType);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    const isAgeAppropriate = 
      (ageGroup === 'young' && ['starter', 'premium', 'elite'].includes(planType)) ||
      (ageGroup === 'older' && ['premium_older', 'elite_older'].includes(planType));

    if (!isAgeAppropriate) {
      return res.status(400).json({ 
        error: `This plan is not available for age group ${ageGroup}` 
      });
    }

    // Starter plan - free trial
    if (!plan.requiresPayment || planType === 'starter') {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + 7);

      const { error } = await supabase
        .from('child_subscriptions')
        .upsert({
          child_id: childId,
          parent_id: parentId,
          plan_type: planType,
          plan_tier: plan.tier,
          age_group: ageGroup,
          status: 'trial',
          trial_start_date: new Date().toISOString(),
          trial_end_date: trialEnd.toISOString(),
          workbook_trial_active: true,
          start_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (error) {
        console.error('Error updating starter plan:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true, planType: 'starter' });
    }

    // ─── STRIPE LIVE MODE CHECK ──────────────────────────────────────
    const isLiveMode = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live');
    console.log(`🔑 Stripe mode: ${isLiveMode ? 'LIVE' : 'TEST'}`);

    if (!isLiveMode) {
      console.warn('⚠️ WARNING: Running in TEST mode. Set STRIPE_SECRET_KEY to live key for production.');
    }

    // App scheme for deep linking
    const appScheme = isDevelopment ? 'exp' : 'edutab';

    // ─── CREATE STRIPE CHECKOUT SESSION ──────────────────────────────
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: plan.currency || 'gbp',
          product_data: {
            name: `${plan.name} - ${childName}`,
            description: `${plan.description} for ${childName} (${ageGroup === 'young' ? 'Ages 3-10' : 'Ages 11+'})`,
          },
          unit_amount: plan.price,
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
        age_group: ageGroup,
        plan_tier: plan.tier,
      },
      // Force live mode
      payment_intent_data: {
        capture_method: 'automatic',
      },
    });

    console.log(`✅ Checkout session created: ${session.id} (${isLiveMode ? 'LIVE' : 'TEST'})`);
    console.log(`🔗 Checkout URL: ${session.url}`);

    res.json({ 
      success: true, 
      url: session.url,
      mode: isLiveMode ? 'live' : 'test',
    });

  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(400).json({ error: error.message });
  }
});

// ─── VERIFY PAYMENT ──────────────────────────────────────────────────────
app.get('/api/verify-payment/:childId', async (req, res) => {
  try {
    const { childId } = req.params;
    
    const { data, error } = await supabase
      .from('child_subscriptions')
      .select('*')
      .eq('child_id', childId)
      .maybeSingle();
    
    if (error && error.code !== 'PGRST116') {
      throw error;
    }
    
    const subscription = data || { 
      plan_type: 'starter', 
      status: 'active',
      child_id: childId,
      age_group: 'young',
      plan_tier: 'starter',
    };
    
    let isTrial = false;
    let trialDaysLeft = 0;
    
    if (subscription.trial_end_date && subscription.workbook_trial_active) {
      const now = new Date();
      const end = new Date(subscription.trial_end_date);
      const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      
      if (daysLeft > 0) {
        isTrial = true;
        trialDaysLeft = daysLeft;
      } else {
        await supabase
          .from('child_subscriptions')
          .update({ 
            workbook_trial_active: false,
            status: 'active'
          })
          .eq('child_id', childId);
      }
    }
    
    const plan = getPlanDetails(subscription.plan_type);
    
    res.json({ 
      success: true, 
      subscription: {
        ...subscription,
        isTrial,
        trialDaysLeft,
        planDetails: plan,
      }
    });
  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── GET CHILD SUBSCRIPTION ────────────────────────────────────────────
app.get('/api/child-subscription/:childId', async (req, res) => {
  try {
    const { childId } = req.params;
    
    const { data, error } = await supabase
      .from('child_subscriptions')
      .select('*')
      .eq('child_id', childId)
      .maybeSingle();
    
    if (error && error.code !== 'PGRST116') {
      throw error;
    }
    
    let subscription = data || { plan_type: 'starter', status: 'active' };
    if (LEGACY_MAP[subscription.plan_type]) {
      subscription.plan_type = LEGACY_MAP[subscription.plan_type];
    }
    
    res.json({ 
      success: true, 
      subscription: subscription 
    });
  } catch (error) {
    console.error('❌ Error fetching subscription:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── GET PARENT SUBSCRIPTIONS ──────────────────────────────────────────
app.get('/api/parent-subscriptions/:parentId', async (req, res) => {
  try {
    const { parentId } = req.params;
    
    const { data, error } = await supabase
      .from('child_subscriptions')
      .select('*')
      .eq('parent_id', parentId);
    
    if (error) throw error;
    
    const subscriptions = (data || []).map(sub => {
      if (LEGACY_MAP[sub.plan_type]) {
        return { ...sub, plan_type: LEGACY_MAP[sub.plan_type] };
      }
      return sub;
    });
    
    res.json({ success: true, subscriptions: subscriptions || [] });
  } catch (error) {
    console.error('❌ Error fetching parent subscriptions:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── GET ALL PLANS ──────────────────────────────────────────────────────
app.get('/api/plans', (req, res) => {
  res.json({ 
    success: true, 
    plans: Object.values(PLANS),
    legacyMapping: LEGACY_MAP,
    currency: 'GBP (£)',
  });
});

// ─── GET PLANS FOR AGE GROUP ───────────────────────────────────────────
app.get('/api/plans/:ageGroup', (req, res) => {
  const { ageGroup } = req.params;
  
  const filteredPlans = Object.values(PLANS).filter(
    plan => plan.ageGroup === ageGroup
  );
  
  res.json({ 
    success: true, 
    ageGroup,
    plans: filteredPlans,
    currency: 'GBP (£)',
  });
});

// ─── 404 HANDLER ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── ERROR HANDLER ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START SERVER ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  const isLive = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live');
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`💰 Stripe mode: ${isLive ? '🔴 LIVE' : '🧪 TEST'}`);
  console.log(`💷 Currency: GBP (£)`);
  console.log(`📡 Webhook endpoint: https://edutabbackend.onrender.com/webhook`);
  console.log(`💳 Create checkout: https://edutabbackend.onrender.com/api/create-checkout`);
  console.log(`✅ Health check: https://edutabbackend.onrender.com/health`);
  console.log(`📋 Plans: https://edutabbackend.onrender.com/api/plans\n`);
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

// // Enable CORS
// app.use(cors());

// // ─── PLAN DEFINITIONS ──────────────────────────────────────────────────────
// const PLANS = {
//   starter: {
//     id: 'starter',
//     name: 'Starter',
//     price: 499,      // $4.99 in cents
//     currency: 'usd',
//     description: 'Games + 7-day trial for worksheets & recorded videos',
//     tier: 'starter',
//     requiresPayment: false,
//     ageGroup: 'young',
//   },
//   premium: {
//     id: 'premium',
//     name: 'Premium',
//     price: 1299,     // $12.99 in cents
//     currency: 'usd',
//     description: 'Games, worksheets, recorded sessions + AI Assistant',
//     tier: 'premium',
//     requiresPayment: true,
//     ageGroup: 'young',
//   },
//   elite: {
//     id: 'elite',
//     name: 'Elite',
//     price: 3099,     // $30.99 in cents
//     currency: 'usd',
//     description: 'Everything in Premium + Live sessions + Exam support + Readers Club',
//     tier: 'elite',
//     requiresPayment: true,
//     ageGroup: 'young',
//   },
//   premium_older: {
//     id: 'premium_older',
//     name: 'Premium 11+',
//     price: 5000,     // $50.00 in cents
//     currency: 'usd',
//     description: 'Maths, English, Science + Ethics & Values + 2 LIVE sessions/week',
//     tier: 'premium',
//     requiresPayment: true,
//     ageGroup: 'older',
//   },
//   elite_older: {
//     id: 'elite_older',
//     name: 'Elite 11+',
//     price: 7000,     // $70.00 in cents
//     currency: 'usd',
//     description: 'Everything in Premium 11+ + Reading groups + Discussion groups + Exam prep',
//     tier: 'elite',
//     requiresPayment: true,
//     ageGroup: 'older',
//   },
// };

// // ─── LEGACY PLAN MAPPING ──────────────────────────────────────────────────
// const LEGACY_MAP = {
//   'free': 'starter',
//   'premium': 'premium',
//   'elite': 'elite',
// };

// const getPlanDetails = (planType) => {
//   // Check if it's a legacy plan
//   const mappedId = LEGACY_MAP[planType] || planType;
//   return PLANS[mappedId] || null;
// };

// // ─── WEBHOOK ──────────────────────────────────────────────────────────────
// app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//   console.log('📨 Webhook received - signature present:', !!sig);
//   console.log('🔐 Webhook secret present:', !!webhookSecret);

//   if (!webhookSecret) {
//     console.error('❌ Missing STRIPE_WEBHOOK_SECRET');
//     return res.status(500).send('Webhook secret not configured');
//   }

//   if (!sig) {
//     console.error('❌ No stripe-signature header');
//     return res.status(400).send('No signature header');
//   }

//   try {
//     const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
//     console.log('✅ Webhook event type:', event.type);

//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object;
//       const { child_id, parent_id, plan_type, child_name, age_group } = session.metadata;

//       console.log(`💰 Processing payment for child: ${child_id}, plan: ${plan_type}`);

//       // Get child's age to determine age group if not provided
//       let ageGroup = age_group;
//       if (!ageGroup) {
//         const { data: child } = await supabase
//           .from('children')
//           .select('age')
//           .eq('id', child_id)
//           .single();
//         ageGroup = (child?.age || 0) <= 10 ? 'young' : 'older';
//       }

//       // Get plan details
//       const plan = getPlanDetails(plan_type);
//       const planTier = plan?.tier || 'starter';

//       // Prepare subscription data
//       const subscriptionData = {
//         child_id: child_id,
//         parent_id: parent_id,
//         plan_type: plan_type,
//         plan_tier: planTier,
//         age_group: ageGroup,
//         status: 'active',
//         updated_at: new Date().toISOString(),
//       };
      
//       // Check if subscription exists
//       const { data: existing } = await supabase
//         .from('child_subscriptions')
//         .select('id')
//         .eq('child_id', child_id)
//         .maybeSingle();
        
//       if (!existing) {
//         subscriptionData.start_date = new Date().toISOString();
//       }

//       console.log('📝 Upserting subscription data:', subscriptionData);

//       // Update or insert subscription
//       const { data, error } = await supabase
//         .from('child_subscriptions')
//         .upsert(subscriptionData)
//         .select();

//       if (error) {
//         console.error('❌ Supabase upsert error:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('✅ Subscription updated successfully:', data);

//       // Create notification for parent
//       const planName = plan?.name || plan_type;
//       const { error: notifError } = await supabase
//         .from('parent_notifications')
//         .insert({
//           user_id: parent_id,
//           title: '🎉 Subscription Activated!',
//           message: `${planName} plan has been activated for ${child_name || 'your child'}!`,
//           type: 'subscription',
//           created_at: new Date().toISOString(),
//         });

//       if (notifError) {
//         console.error('⚠️ Error creating notification:', notifError);
//       } else {
//         console.log('✅ Notification created for parent');
//       }
//     }

//     if (event.type === 'customer.subscription.deleted') {
//       const subscription = event.data.object;
//       console.log(`❌ Processing subscription cancellation: ${subscription.id}`);
      
//       // Update the subscription status in Supabase
//       const { error } = await supabase
//         .from('child_subscriptions')
//         .update({ 
//           status: 'cancelled',
//           updated_at: new Date().toISOString()
//         })
//         .eq('stripe_subscription_id', subscription.id);

//       if (error) {
//         console.error('⚠️ Error updating cancelled subscription:', error);
//       }
//     }

//     res.json({ received: true });
//   } catch (err) {
//     console.error('❌ Webhook error:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }
// });

// // ─── MIDDLEWARE ──────────────────────────────────────────────────────────
// app.use(express.json());

// // ─── HEALTH CHECK ──────────────────────────────────────────────────────
// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'ok', 
//     timestamp: new Date().toISOString(),
//     environment: process.env.NODE_ENV || 'development',
//     plans: Object.keys(PLANS),
//   });
// });

// // ─── CREATE CHECKOUT SESSION ───────────────────────────────────────────
// app.post('/api/create-checkout', async (req, res) => {
//   try {
//     const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

//     console.log('🚀 Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

//     if (!childId || !childName || !planType || !parentId || !parentEmail) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }

//     // Get child's age to determine age group
//     const { data: child, error: childError } = await supabase
//       .from('children')
//       .select('age')
//       .eq('id', childId)
//       .single();

//     if (childError) {
//       console.error('Error fetching child age:', childError);
//       return res.status(500).json({ error: 'Could not fetch child data' });
//     }

//     const age = child?.age || 0;
//     const ageGroup = age <= 10 ? 'young' : 'older';

//     // Get plan details
//     const plan = getPlanDetails(planType);
//     if (!plan) {
//       return res.status(400).json({ error: 'Invalid plan type' });
//     }

//     // Check if plan is age-appropriate
//     const isAgeAppropriate = 
//       (ageGroup === 'young' && ['starter', 'premium', 'elite'].includes(planType)) ||
//       (ageGroup === 'older' && ['premium_older', 'elite_older'].includes(planType));

//     if (!isAgeAppropriate) {
//       return res.status(400).json({ 
//         error: `This plan is not available for age group ${ageGroup}` 
//       });
//     }

//     // Starter plan - free, no payment needed
//     if (!plan.requiresPayment || planType === 'starter') {
//       const trialEnd = new Date();
//       trialEnd.setDate(trialEnd.getDate() + 7);

//       const { error } = await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: childId,
//           parent_id: parentId,
//           plan_type: planType,
//           plan_tier: plan.tier,
//           age_group: ageGroup,
//           status: 'trial',
//           trial_start_date: new Date().toISOString(),
//           trial_end_date: trialEnd.toISOString(),
//           workbook_trial_active: true,
//           start_date: new Date().toISOString(),
//           updated_at: new Date().toISOString(),
//         });

//       if (error) {
//         console.error('Error updating starter plan:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       return res.json({ success: true, planType: 'starter' });
//     }

//     // App scheme for deep linking
//     const appScheme = isDevelopment ? 'exp' : 'edutab';

//     // Create Stripe checkout session
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: plan.currency || 'usd',
//           product_data: {
//             name: `${plan.name} - ${childName}`,
//             description: `${plan.description} for ${childName} (${ageGroup === 'young' ? 'Ages 3-10' : 'Ages 11+'})`,
//           },
//           unit_amount: plan.price,
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
//         child_name: childName,
//         age_group: ageGroup,
//         plan_tier: plan.tier,
//       },
//     });

//     console.log('✅ Checkout session created:', session.id);
//     res.json({ success: true, url: session.url });

//   } catch (error) {
//     console.error('❌ Error creating checkout session:', error);
//     res.status(400).json({ error: error.message });
//   }
// });

// // ─── VERIFY PAYMENT ──────────────────────────────────────────────────────
// app.get('/api/verify-payment/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error && error.code !== 'PGRST116') {
//       throw error;
//     }
    
//     // Check if subscription exists or return default
//     const subscription = data || { 
//       plan_type: 'starter', 
//       status: 'active',
//       child_id: childId,
//       age_group: 'young',
//       plan_tier: 'starter',
//     };
    
//     // Check if trial is still valid
//     let isTrial = false;
//     let trialDaysLeft = 0;
    
//     if (subscription.trial_end_date && subscription.workbook_trial_active) {
//       const now = new Date();
//       const end = new Date(subscription.trial_end_date);
//       const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      
//       if (daysLeft > 0) {
//         isTrial = true;
//         trialDaysLeft = daysLeft;
//       } else {
//         // Trial expired - update status
//         await supabase
//           .from('child_subscriptions')
//           .update({ 
//             workbook_trial_active: false,
//             status: 'active'
//           })
//           .eq('child_id', childId);
//       }
//     }
    
//     const plan = getPlanDetails(subscription.plan_type);
    
//     res.json({ 
//       success: true, 
//       subscription: {
//         ...subscription,
//         isTrial,
//         trialDaysLeft,
//         planDetails: plan,
//       }
//     });
//   } catch (error) {
//     console.error('❌ Verify payment error:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // ─── GET CHILD SUBSCRIPTION ────────────────────────────────────────────
// app.get('/api/child-subscription/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error && error.code !== 'PGRST116') {
//       throw error;
//     }
    
//     // Map legacy plan types
//     let subscription = data || { plan_type: 'starter', status: 'active' };
//     if (LEGACY_MAP[subscription.plan_type]) {
//       subscription.plan_type = LEGACY_MAP[subscription.plan_type];
//     }
    
//     res.json({ 
//       success: true, 
//       subscription: subscription 
//     });
//   } catch (error) {
//     console.error('❌ Error fetching subscription:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // ─── GET PARENT SUBSCRIPTIONS ──────────────────────────────────────────
// app.get('/api/parent-subscriptions/:parentId', async (req, res) => {
//   try {
//     const { parentId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('parent_id', parentId);
    
//     if (error) throw error;
    
//     // Map legacy plan types
//     const subscriptions = (data || []).map(sub => {
//       if (LEGACY_MAP[sub.plan_type]) {
//         return { ...sub, plan_type: LEGACY_MAP[sub.plan_type] };
//       }
//       return sub;
//     });
    
//     res.json({ success: true, subscriptions: subscriptions || [] });
//   } catch (error) {
//     console.error('❌ Error fetching parent subscriptions:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // ─── GET ALL PLANS ──────────────────────────────────────────────────────
// app.get('/api/plans', (req, res) => {
//   res.json({ 
//     success: true, 
//     plans: Object.values(PLANS),
//     legacyMapping: LEGACY_MAP,
//   });
// });

// // ─── GET PLANS FOR AGE GROUP ───────────────────────────────────────────
// app.get('/api/plans/:ageGroup', (req, res) => {
//   const { ageGroup } = req.params;
  
//   const filteredPlans = Object.values(PLANS).filter(
//     plan => plan.ageGroup === ageGroup
//   );
  
//   res.json({ 
//     success: true, 
//     ageGroup,
//     plans: filteredPlans,
//   });
// });

// // ─── 404 HANDLER ────────────────────────────────────────────────────────
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // ─── ERROR HANDLER ──────────────────────────────────────────────────────
// app.use((err, req, res, next) => {
//   console.error('❌ Server error:', err);
//   res.status(500).json({ error: 'Internal server error' });
// });

// // ─── START SERVER ──────────────────────────────────────────────────────
// app.listen(PORT, () => {
//   console.log(`\n🚀 Server running on port ${PORT}`);
//   console.log(`📡 Webhook endpoint: https://edutabbackend.onrender.com/webhook`);
//   console.log(`💳 Create checkout: https://edutabbackend.onrender.com/api/create-checkout`);
//   console.log(`✅ Health check: https://edutabbackend.onrender.com/health`);
//   console.log(`📋 Plans: https://edutabbackend.onrender.com/api/plans\n`);
// });






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

// // Enable CORS
// app.use(cors());

// // IMPORTANT: Webhook endpoint MUST come before express.json()
// app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//   console.log('📨 Webhook received - signature present:', !!sig);
//   console.log('🔐 Webhook secret present:', !!webhookSecret);

//   if (!webhookSecret) {
//     console.error('❌ Missing STRIPE_WEBHOOK_SECRET');
//     return res.status(500).send('Webhook secret not configured');
//   }

//   if (!sig) {
//     console.error('❌ No stripe-signature header');
//     return res.status(400).send('No signature header');
//   }

//   try {
//     const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
//     console.log('✅ Webhook event type:', event.type);

//     // Handle successful checkout
//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object;
//       const { child_id, parent_id, plan_type, child_name } = session.metadata;

//       console.log(`💰 Processing payment for child: ${child_id}, plan: ${plan_type}`);

//       // Prepare subscription data - ONLY columns that exist in your table
//       const subscriptionData = {
//         child_id: child_id,
//         parent_id: parent_id,
//         plan_type: plan_type,
//         status: 'active',
//         updated_at: new Date().toISOString(),
//       };
      
//       // Add start_date if this is a new subscription
//       const { data: existing } = await supabase
//         .from('child_subscriptions')
//         .select('id')
//         .eq('child_id', child_id)
//         .maybeSingle();
        
//       if (!existing) {
//         subscriptionData.start_date = new Date().toISOString();
//       }

//       console.log('📝 Upserting subscription data:', subscriptionData);

//       // Update or insert subscription
//       const { data, error } = await supabase
//         .from('child_subscriptions')
//         .upsert(subscriptionData)
//         .select();

//       if (error) {
//         console.error('❌ Supabase upsert error:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('✅ Subscription updated successfully:', data);

//       // Create notification for parent using parent_notifications table
//       const { error: notifError } = await supabase
//         .from('parent_notifications')
//         .insert({
//           user_id: parent_id,
//           title: '🎉 Subscription Activated!',
//           message: `${plan_type?.toUpperCase()} plan has been activated for ${child_name || 'your child'}!`,
//           type: 'subscription',
//           created_at: new Date().toISOString(),
//         });

//       if (notifError) {
//         console.error('⚠️ Error creating notification:', notifError);
//       } else {
//         console.log('✅ Notification created for parent');
//       }
//     }

//     // Handle subscription cancellation
//     if (event.type === 'customer.subscription.deleted') {
//       const subscription = event.data.object;
      
//       console.log(`❌ Processing subscription cancellation: ${subscription.id}`);
//       console.log('⚠️ Subscription cancelled in Stripe');
//     }

//     res.json({ received: true });
//   } catch (err) {
//     console.error('❌ Webhook error:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }
// });

// // Then add express.json() for all other routes
// app.use(express.json());

// // Health check endpoint
// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'ok', 
//     timestamp: new Date().toISOString(),
//     environment: process.env.NODE_ENV || 'development'
//   });
// });

// // Create checkout session endpoint
// app.post('/api/create-checkout', async (req, res) => {
//   try {
//     const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

//     console.log('🚀 Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

//     // Validate required fields
//     if (!childId || !childName || !planType || !parentId || !parentEmail) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }

//     // Free plan - no payment needed
//     if (planType === 'free') {
//       const { error } = await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: childId,
//           parent_id: parentId,
//           plan_type: 'free',
//           status: 'active',
//           updated_at: new Date().toISOString(),
//         });

//       if (error) {
//         console.error('Error updating free plan:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       return res.json({ success: true, planType: 'free' });
//     }

//     // Price mapping (in cents)
//     const prices = {
//       premium: 1299,  // $12.99
//       elite: 2499     // $24.99
//     };

//     if (!prices[planType]) {
//       return res.status(400).json({ error: 'Invalid plan type' });
//     }

//     // App scheme for deep linking
//     const appScheme = isDevelopment ? 'exp' : 'edutab';

//     // Log the redirect URLs for debugging
//     const successUrl = `${appScheme}://payment-success?child_id=${childId}&plan=${planType}`;
//     const cancelUrl = `${appScheme}://payment-cancelled`;
    
//     console.log('🔗 Success URL:', successUrl);
//     console.log('🔗 Cancel URL:', cancelUrl);

//     // Create Stripe checkout session
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: {
//             name: `${planType.toUpperCase()} Plan - ${childName}`,
//             description: `Monthly subscription for ${childName} - Full access to all ${planType} content`,
//           },
//           unit_amount: prices[planType],
//           recurring: { interval: 'month' },
//         },
//         quantity: 1,
//       }],
//       mode: 'subscription',
//       success_url: successUrl,
//       cancel_url: cancelUrl,
//       customer_email: parentEmail,
//       metadata: {
//         child_id: childId,
//         parent_id: parentId,
//         plan_type: planType,
//         child_name: childName,
//       },
//     });

//     console.log('✅ Checkout session created:', session.id);
//     res.json({ success: true, url: session.url });

//   } catch (error) {
//     console.error('❌ Error creating checkout session:', error);
//     res.status(400).json({ error: error.message });
//   }
// });

// // Verify payment endpoint
// app.get('/api/verify-payment/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error && error.code !== 'PGRST116') {
//       throw error;
//     }
    
//     // Return subscription or default free plan
//     const subscription = data || { 
//       plan_type: 'free', 
//       status: 'active',
//       child_id: childId
//     };
    
//     res.json({ success: true, subscription });
//   } catch (error) {
//     console.error('❌ Verify payment error:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Get child's current subscription
// app.get('/api/child-subscription/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error && error.code !== 'PGRST116') {
//       throw error;
//     }
    
//     res.json({ 
//       success: true, 
//       subscription: data || { plan_type: 'free', status: 'active' } 
//     });
//   } catch (error) {
//     console.error('❌ Error fetching subscription:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Get all children subscriptions for a parent
// app.get('/api/parent-subscriptions/:parentId', async (req, res) => {
//   try {
//     const { parentId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('parent_id', parentId);
    
//     if (error) throw error;
    
//     res.json({ success: true, subscriptions: data || [] });
//   } catch (error) {
//     console.error('❌ Error fetching parent subscriptions:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // 404 handler for undefined routes
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Error handler
// app.use((err, req, res, next) => {
//   console.error('❌ Server error:', err);
//   res.status(500).json({ error: 'Internal server error' });
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`\n🚀 Server running on port ${PORT}`);
//   console.log(`📡 Webhook endpoint: https://edutabbackend.onrender.com/webhook`);
//   console.log(`💳 Create checkout: https://edutabbackend.onrender.com/api/create-checkout`);
//   console.log(`✅ Health check: https://edutabbackend.onrender.com/health\n`);
// });










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

// // Enable CORS
// app.use(cors());

// // IMPORTANT: Webhook endpoint MUST come before express.json()
// app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//   console.log('📨 Webhook received - signature present:', !!sig);
//   console.log('🔐 Webhook secret present:', !!webhookSecret);

//   if (!webhookSecret) {
//     console.error('❌ Missing STRIPE_WEBHOOK_SECRET');
//     return res.status(500).send('Webhook secret not configured');
//   }

//   if (!sig) {
//     console.error('❌ No stripe-signature header');
//     return res.status(400).send('No signature header');
//   }

//   try {
//     const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
//     console.log('✅ Webhook event type:', event.type);

//     // Handle successful checkout
//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object;
//       const { child_id, parent_id, plan_type, child_name } = session.metadata;

//       console.log(`💰 Processing payment for child: ${child_id}, plan: ${plan_type}`);

//       // Prepare subscription data - ONLY columns that exist in your table
//       const subscriptionData = {
//         child_id: child_id,
//         parent_id: parent_id,
//         plan_type: plan_type,
//         status: 'active',
//         updated_at: new Date().toISOString(),
//       };
      
//       // Add start_date if this is a new subscription
//       const { data: existing } = await supabase
//         .from('child_subscriptions')
//         .select('id')
//         .eq('child_id', child_id)
//         .maybeSingle();
        
//       if (!existing) {
//         subscriptionData.start_date = new Date().toISOString();
//       }

//       console.log('📝 Upserting subscription data:', subscriptionData);

//       // Update or insert subscription (without Stripe-specific columns)
//       const { data, error } = await supabase
//         .from('child_subscriptions')
//         .upsert(subscriptionData)
//         .select();

//       if (error) {
//         console.error('❌ Supabase upsert error:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('✅ Subscription updated successfully:', data);

//       // Create notification for parent
//       const { error: notifError } = await supabase
//         .from('notifications')
//         .insert({
//           user_id: parent_id,
//           title: '🎉 Subscription Activated!',
//           message: `${plan_type?.toUpperCase()} plan has been activated for ${child_name || 'your child'}!`,
//           type: 'subscription',
//           created_at: new Date().toISOString(),
//         });

//       if (notifError) {
//         console.error('⚠️ Error creating notification:', notifError);
//       } else {
//         console.log('✅ Notification created for parent');
//       }
//     }

//     // Handle subscription cancellation
//     if (event.type === 'customer.subscription.deleted') {
//       const subscription = event.data.object;
      
//       console.log(`❌ Processing subscription cancellation: ${subscription.id}`);

//       // Note: Since you don't have stripe_subscription_id in your table,
//       // you might want to find by child_id or add the column
//       // For now, we'll log it
//       console.log('⚠️ Subscription cancelled in Stripe but database not updated (missing stripe_subscription_id column)');
      
//       // You could update by child_id if you have it in metadata, but we don't here
//     }

//     res.json({ received: true });
//   } catch (err) {
//     console.error('❌ Webhook error:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }
// });

// // Then add express.json() for all other routes
// app.use(express.json());

// // Health check endpoint
// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'ok', 
//     timestamp: new Date().toISOString(),
//     environment: process.env.NODE_ENV || 'development'
//   });
// });

// // Create checkout session endpoint
// app.post('/api/create-checkout', async (req, res) => {
//   try {
//     const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

//     console.log('🚀 Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

//     // Validate required fields
//     if (!childId || !childName || !planType || !parentId || !parentEmail) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }

//     // Free plan - no payment needed
//     if (planType === 'free') {
//       const { error } = await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: childId,
//           parent_id: parentId,
//           plan_type: 'free',
//           status: 'active',
//           updated_at: new Date().toISOString(),
//         });

//       if (error) {
//         console.error('Error updating free plan:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       return res.json({ success: true, planType: 'free' });
//     }

//     // Price mapping (in cents)
//     const prices = {
//       premium: 1299,  // $12.99
//       elite: 2499     // $24.99
//     };

//     if (!prices[planType]) {
//       return res.status(400).json({ error: 'Invalid plan type' });
//     }

//     // App scheme for deep linking
//     const appScheme = isDevelopment ? 'exp' : 'edutab';

//     // Create Stripe checkout session
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: {
//             name: `${planType.toUpperCase()} Plan - ${childName}`,
//             description: `Monthly subscription for ${childName} - Full access to all ${planType} content`,
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
//         child_name: childName,
//       },
//     });

//     console.log('✅ Checkout session created:', session.id);
//     res.json({ success: true, url: session.url });

//   } catch (error) {
//     console.error('❌ Error creating checkout session:', error);
//     res.status(400).json({ error: error.message });
//   }
// });

// // Verify payment endpoint
// app.get('/api/verify-payment/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error && error.code !== 'PGRST116') {
//       throw error;
//     }
    
//     // Return subscription or default free plan
//     const subscription = data || { 
//       plan_type: 'free', 
//       status: 'active',
//       child_id: childId
//     };
    
//     res.json({ success: true, subscription });
//   } catch (error) {
//     console.error('❌ Verify payment error:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Get child's current subscription
// app.get('/api/child-subscription/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error && error.code !== 'PGRST116') {
//       throw error;
//     }
    
//     res.json({ 
//       success: true, 
//       subscription: data || { plan_type: 'free', status: 'active' } 
//     });
//   } catch (error) {
//     console.error('❌ Error fetching subscription:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Get all children subscriptions for a parent
// app.get('/api/parent-subscriptions/:parentId', async (req, res) => {
//   try {
//     const { parentId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('parent_id', parentId);
    
//     if (error) throw error;
    
//     res.json({ success: true, subscriptions: data || [] });
//   } catch (error) {
//     console.error('❌ Error fetching parent subscriptions:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // 404 handler for undefined routes
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Error handler
// app.use((err, req, res, next) => {
//   console.error('❌ Server error:', err);
//   res.status(500).json({ error: 'Internal server error' });
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`\n🚀 Server running on port ${PORT}`);
//   console.log(`📡 Webhook endpoint: https://edutabbackend.onrender.com/webhook`);
//   console.log(`💳 Create checkout: https://edutabbackend.onrender.com/api/create-checkout`);
//   console.log(`✅ Health check: https://edutabbackend.onrender.com/health\n`);
// });




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

// // IMPORTANT: Enable CORS first
// app.use(cors());

// // IMPORTANT: Webhook endpoint MUST come BEFORE express.json()
// // Webhook endpoint (uses raw body for signature verification)
// app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//   console.log('Webhook received - signature present:', !!sig);
//   console.log('Webhook secret present:', !!webhookSecret);

//   if (!webhookSecret) {
//     console.error('Missing STRIPE_WEBHOOK_SECRET');
//     return res.status(500).send('Webhook secret not configured');
//   }

//   if (!sig) {
//     console.error('No stripe-signature header');
//     return res.status(400).send('No signature header');
//   }

//   try {
//     // req.body is already the raw buffer from express.raw()
//     const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
//     console.log('Webhook event type:', event.type);

//     // Handle successful checkout
//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object;
//       const { child_id, parent_id, plan_type } = session.metadata;

//       console.log(`Processing successful payment for child: ${child_id}, plan: ${plan_type}`);

//       // Update subscription in Supabase
//       const { data, error } = await supabase
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
//         })
//         .select();

//       if (error) {
//         console.error('Supabase upsert error:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('Subscription updated successfully:', data);

//       // Create notification for parent
//       const { error: notifError } = await supabase
//         .from('notifications')
//         .insert({
//           user_id: parent_id,
//           title: 'Subscription Activated',
//           message: `${plan_type?.toUpperCase()} plan has been activated for your child!`,
//           type: 'subscription',
//           created_at: new Date().toISOString(),
//         });

//       if (notifError) {
//         console.error('Error creating notification:', notifError);
//       }
//     }

//     // Handle subscription cancellation
//     if (event.type === 'customer.subscription.deleted') {
//       const subscription = event.data.object;
      
//       console.log('Processing subscription cancellation:', subscription.id);

//       const { error } = await supabase
//         .from('child_subscriptions')
//         .update({ 
//           status: 'cancelled', 
//           updated_at: new Date().toISOString() 
//         })
//         .eq('stripe_subscription_id', subscription.id);

//       if (error) {
//         console.error('Error cancelling subscription:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('Subscription cancelled successfully');
//     }

//     res.json({ received: true });
//   } catch (err) {
//     console.error('Webhook error:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }
// });

// // THEN add express.json() for all other routes
// app.use(express.json());

// // Health check endpoint
// app.get('/health', (req, res) => {
//   res.json({ status: 'ok', timestamp: new Date().toISOString() });
// });

// // Create checkout session endpoint
// app.post('/api/create-checkout', async (req, res) => {
//   try {
//     const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

//     console.log('Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

//     // Free plan - no payment needed
//     if (planType === 'free') {
//       const { error } = await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: childId,
//           parent_id: parentId,
//           plan_type: 'free',
//           status: 'active',
//           updated_at: new Date().toISOString(),
//         });

//       if (error) {
//         console.error('Error updating free plan:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       return res.json({ success: true, planType: 'free' });
//     }

//     // Price mapping (in cents)
//     const prices = {
//       premium: 1299,  // $12.99
//       elite: 2499     // $24.99
//     };

//     if (!prices[planType]) {
//       return res.status(400).json({ error: 'Invalid plan type' });
//     }

//     // App scheme for deep linking
//     const appScheme = isDevelopment ? 'exp' : 'edutab';

//     // Create Stripe checkout session
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: {
//             name: `${planType.toUpperCase()} Plan - ${childName}`,
//             description: `Monthly subscription for ${childName}`,
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
//         child_name: childName,
//       },
//     });

//     console.log('Checkout session created:', session.id);
//     res.json({ success: true, url: session.url });

//   } catch (error) {
//     console.error('Error creating checkout session:', error);
//     res.status(400).json({ error: error.message });
//   }
// });

// // Verify payment endpoint
// app.get('/api/verify-payment/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .single();
    
//     if (error) {
//       // No subscription found, return free plan
//       if (error.code === 'PGRST116') {
//         return res.json({ 
//           success: true, 
//           subscription: { plan_type: 'free', status: 'active' } 
//         });
//       }
//       throw error;
//     }
    
//     res.json({ success: true, subscription: data });
//   } catch (error) {
//     console.error('Verify payment error:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Get child's current subscription
// app.get('/api/child-subscription/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error) throw error;
    
//     res.json({ 
//       success: true, 
//       subscription: data || { plan_type: 'free', status: 'active' } 
//     });
//   } catch (error) {
//     console.error('Error fetching subscription:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
//   console.log(`💳 Create checkout: http://localhost:${PORT}/api/create-checkout`);
// });






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

// // Health check endpoint
// app.get('/health', (req, res) => {
//   res.json({ status: 'ok', timestamp: new Date().toISOString() });
// });

// // Create checkout session endpoint
// app.post('/api/create-checkout', async (req, res) => {
//   try {
//     const { childId, childName, planType, parentId, parentEmail, isDevelopment } = req.body;

//     console.log('Creating checkout session for:', { childId, childName, planType, parentId, parentEmail });

//     // Free plan - no payment needed
//     if (planType === 'free') {
//       const { error } = await supabase
//         .from('child_subscriptions')
//         .upsert({
//           child_id: childId,
//           parent_id: parentId,
//           plan_type: 'free',
//           status: 'active',
//           updated_at: new Date().toISOString(),
//         });

//       if (error) {
//         console.error('Error updating free plan:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       return res.json({ success: true, planType: 'free' });
//     }

//     // Price mapping (in cents)
//     const prices = {
//       premium: 1299,  // $12.99
//       elite: 2499     // $24.99
//     };

//     if (!prices[planType]) {
//       return res.status(400).json({ error: 'Invalid plan type' });
//     }

//     // App scheme for deep linking
//     const appScheme = isDevelopment ? 'exp' : 'edutab';

//     // Create Stripe checkout session
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: {
//             name: `${planType.toUpperCase()} Plan - ${childName}`,
//             description: `Monthly subscription for ${childName}`,
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
//         child_name: childName,
//       },
//     });

//     console.log('Checkout session created:', session.id);
//     res.json({ success: true, url: session.url });

//   } catch (error) {
//     console.error('Error creating checkout session:', error);
//     res.status(400).json({ error: error.message });
//   }
// });

// // Webhook endpoint (must use raw body for Stripe signature verification)
// app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//   if (!webhookSecret) {
//     console.error('Missing STRIPE_WEBHOOK_SECRET');
//     return res.status(500).send('Webhook secret not configured');
//   }

//   try {
//     const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
//     console.log('Webhook event type:', event.type);

//     // Handle successful checkout
//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object;
//       const { child_id, parent_id, plan_type } = session.metadata;

//       console.log(`Processing successful payment for child: ${child_id}, plan: ${plan_type}`);

//       // Update subscription in Supabase
//       const { data, error } = await supabase
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
//         })
//         .select();

//       if (error) {
//         console.error('Supabase upsert error:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('Subscription updated successfully:', data);

//       // Create notification for parent
//       const { error: notifError } = await supabase
//         .from('notifications')
//         .insert({
//           user_id: parent_id,
//           title: 'Subscription Activated',
//           message: `${plan_type?.toUpperCase()} plan has been activated for your child!`,
//           type: 'subscription',
//           created_at: new Date().toISOString(),
//         });

//       if (notifError) {
//         console.error('Error creating notification:', notifError);
//       }
//     }

//     // Handle subscription cancellation
//     if (event.type === 'customer.subscription.deleted') {
//       const subscription = event.data.object;
      
//       console.log('Processing subscription cancellation:', subscription.id);

//       const { error } = await supabase
//         .from('child_subscriptions')
//         .update({ 
//           status: 'cancelled', 
//           updated_at: new Date().toISOString() 
//         })
//         .eq('stripe_subscription_id', subscription.id);

//       if (error) {
//         console.error('Error cancelling subscription:', error);
//         return res.status(500).json({ error: error.message });
//       }

//       console.log('Subscription cancelled successfully');
//     }

//     res.json({ received: true });
//   } catch (err) {
//     console.error('Webhook error:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }
// });

// // Verify payment endpoint
// app.get('/api/verify-payment/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .single();
    
//     if (error) {
//       // No subscription found, return free plan
//       if (error.code === 'PGRST116') {
//         return res.json({ 
//           success: true, 
//           subscription: { plan_type: 'free', status: 'active' } 
//         });
//       }
//       throw error;
//     }
    
//     res.json({ success: true, subscription: data });
//   } catch (error) {
//     console.error('Verify payment error:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Get child's current subscription
// app.get('/api/child-subscription/:childId', async (req, res) => {
//   try {
//     const { childId } = req.params;
    
//     const { data, error } = await supabase
//       .from('child_subscriptions')
//       .select('*')
//       .eq('child_id', childId)
//       .maybeSingle();
    
//     if (error) throw error;
    
//     res.json({ 
//       success: true, 
//       subscription: data || { plan_type: 'free', status: 'active' } 
//     });
//   } catch (error) {
//     console.error('Error fetching subscription:', error);
//     res.status(400).json({ success: false, error: error.message });
//   }
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
//   console.log(`💳 Create checkout: http://localhost:${PORT}/api/create-checkout`);
// });







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
