/**
 * Blue River Gutters Content Engine
 * 
 * Cloudflare Worker that receives Jobber webhooks and triggers content creation.
 * 
 * Webhook Events:
 * - visit_completed: Triggers when a job visit is marked complete in Jobber
 * 
 * Future expansion:
 * - Generate review request emails
 * - Create case study content from job photos
 * - Update internal dashboards
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route handling
    switch (url.pathname) {
      case '/':
        return handleRoot(request, env);
      
      case '/webhook/jobber':
        return handleJobberWebhook(request, env, ctx);
      
      case '/health':
        return handleHealth(env);
      
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

/**
 * Root endpoint - simple info response
 */
function handleRoot(request, env) {
  return new Response(JSON.stringify({
    service: 'Blue River Gutters Content Engine',
    version: '0.1.0',
    environment: env.ENVIRONMENT || 'unknown',
    endpoints: {
      health: '/health',
      webhook: '/webhook/jobber'
    }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Health check endpoint
 */
function handleHealth(env) {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: env.ENVIRONMENT || 'unknown'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Handle incoming Jobber webhooks
 * 
 * Jobber sends POST requests with JSON payload when events occur.
 * We need to:
 * 1. Validate it's a POST request
 * 2. Parse the JSON payload
 * 3. Return 200 OK immediately (Jobber requires fast response)
 * 4. Process the event asynchronously via ctx.waitUntil()
 */
async function handleJobberWebhook(request, env, ctx) {
  // Only accept POST requests
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  let payload;
  
  try {
    // Parse the incoming webhook payload
    payload = await request.json();
  } catch (error) {
    console.error('Failed to parse webhook payload:', error);
    return new Response(JSON.stringify({
      error: 'Invalid JSON payload'
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Log the webhook for debugging/testing
  console.log('=== Jobber Webhook Received ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Payload:', JSON.stringify(payload, null, 2));
  
  // Validate the payload has expected structure
  const validation = validatePayload(payload);
  if (!validation.valid) {
    console.error('Invalid payload structure:', validation.reason);
    return new Response(JSON.stringify({
      error: 'Invalid payload structure',
      reason: validation.reason
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Return 200 OK immediately to Jobber
  // Process the event asynchronously so we don't timeout
  ctx.waitUntil(processWebhookEvent(payload, env));
  
  return new Response(JSON.stringify({
    received: true,
    event: payload.event || 'unknown',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Validate the webhook payload structure
 * 
 * Jobber webhooks typically include:
 * - event: The event type (e.g., "visit_completed")
 * - data: The event payload with job/visit details
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Payload must be a JSON object' };
  }
  
  // For now, we're flexible on structure since we're testing
  // We'll tighten this up once we know Jobber's exact format
  
  // At minimum, we want SOMETHING in the payload
  if (Object.keys(payload).length === 0) {
    return { valid: false, reason: 'Payload is empty' };
  }
  
  return { valid: true };
}

/**
 * Process the webhook event asynchronously
 * 
 * This runs after we've already responded to Jobber.
 * Future tasks will add the actual processing logic here.
 */
async function processWebhookEvent(payload, env) {
  console.log('=== Processing Webhook Event ===');
  
  const eventType = payload.event || payload.topic || 'unknown';
  
  switch (eventType) {
    case 'visit_completed':
    case 'VISIT_COMPLETED':
      await handleVisitCompleted(payload, env);
      break;
    
    default:
      console.log(`Unhandled event type: ${eventType}`);
      // Still log it for discovery
      console.log('Full payload for unknown event:', JSON.stringify(payload));
  }
}

/**
 * Handle visit_completed events
 * 
 * When a job visit is completed in Jobber, we'll:
 * 1. Extract job details (address, service type, etc.)
 * 2. Queue content generation tasks
 * 3. Trigger follow-up workflows (review requests, etc.)
 */
async function handleVisitCompleted(payload, env) {
  console.log('=== Visit Completed Event ===');
  
  // Extract relevant data from the payload
  // Jobber's exact structure TBD - we'll adapt once we see real webhooks
  const data = payload.data || payload;
  
  console.log('Visit data:', JSON.stringify(data, null, 2));
  
  // TODO: Future tasks will implement:
  // - Store job details in KV/D1
  // - Trigger Claude API for content generation
  // - Send to email workflow for review request
  // - Create case study draft if photos included
  
  console.log('Visit completed event processed (logging only for now)');
}
