/**
 * Social Media Draft Generator
 * 
 * Creates ready-to-post Facebook and Instagram captions from job data,
 * then emails them to Adam with photos attached for easy copy/paste posting.
 * 
 * Input: contentData from jobber-api.js extractContentData() + processedPhotos
 * Output: Email sent via Courier with captions and photo links
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Email recipient
  recipientEmail: 'adambussey1@gmail.com',
  recipientName: 'Adam',
  
  // Courier integration
  courierEndpoint: 'https://email-bot-server.micaiah-tasks.workers.dev/api/send',
  
  // Branding
  businessName: 'Blue River Gutters',
  phone: '(256) 616-6760',
  website: 'bluerivergutters.com',
  
  // Social handles
  facebookPage: 'bluerivergutters',
  instagramHandle: 'bluerivergutter',
};

// =============================================================================
// HASHTAG LIBRARY
// =============================================================================

/**
 * Curated hashtag sets for Instagram
 * Mix of local, industry, and engagement hashtags
 */
const HASHTAGS = {
  // Always include these
  core: [
    '#BlueRiverGutters',
    '#NorthAlabama',
    '#HuntsvilleAL',
  ],
  
  // Location-specific (pick based on city)
  locations: {
    'Huntsville': ['#Huntsville', '#HuntsvilleAlabama', '#RocketCity', '#HSV'],
    'Madison': ['#MadisonAL', '#MadisonAlabama', '#MadisonCity'],
    'Decatur': ['#DecaturAL', '#DecaturAlabama', '#CityOfOpportunity'],
    'Athens': ['#AthensAL', '#AthensAlabama', '#LimestoneCounty'],
    'Hartselle': ['#HartselleAL', '#HartselleAlabama', '#MorganCounty'],
    'Hampton Cove': ['#HamptonCove', '#HamptonCoveAL'],
    'Meridianville': ['#Meridianville', '#MeridianvilleAL'],
    'Owens Cross Roads': ['#OwensCrossRoads'],
    'default': ['#Alabama', '#SouthernLiving'],
  },
  
  // Service-specific
  services: {
    'Seamless Gutters': ['#SeamlessGutters', '#GutterInstallation', '#NewGutters', '#AluminumGutters'],
    'Gutter Guards': ['#GutterGuards', '#LeafGuards', '#NeverCleanGuttersAgain', '#GutterProtection'],
    'Gutter Cleaning': ['#GutterCleaning', '#CleanGutters', '#GutterMaintenance'],
    'Downspouts': ['#Downspouts', '#DrainageSystem', '#WaterManagement'],
    'Underground Drains': ['#UndergroundDrainage', '#FrenchDrain', '#DrainageSolutions', '#FoundationProtection'],
    'Rotten Wood Repair': ['#FasciaRepair', '#WoodRot', '#HomeRepair', '#WaterDamage'],
    'default': ['#Gutters', '#HomeImprovement'],
  },
  
  // General engagement (rotate these)
  engagement: [
    '#HomeExterior',
    '#CurbAppeal',
    '#HomeOwner',
    '#HomeMaintenance',
    '#ContractorLife',
    '#SmallBusiness',
    '#LocalBusiness',
    '#SupportLocal',
    '#BeforeAndAfter',
    '#TransformationTuesday',
    '#ProjectComplete',
    '#SatisfiedCustomer',
  ],
};

// =============================================================================
// CAPTION GENERATION
// =============================================================================

/**
 * Generate a Facebook caption for the completed job
 * Facebook style: conversational, can be longer, focus on story
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @param {object} project - Generated project object from project-generator.js
 * @returns {string} - Facebook caption
 */
export function generateFacebookCaption(contentData, project) {
  const city = contentData.city || 'North Alabama';
  const service = project.service;
  const customerType = contentData.customerType || 'residential';
  
  // Opening hook variations
  const hooks = {
    'Seamless Gutters': [
      `Just wrapped up a beautiful gutter installation in ${city}! 🏠`,
      `Another ${city} home protected with brand new seamless gutters! ✨`,
      `Fresh seamless gutters going up in ${city} today! 💪`,
    ],
    'Gutter Guards': [
      `This ${city} homeowner will never clean gutters again! 🍂`,
      `Gutter guards installed in ${city} — no more ladder climbing! 🙌`,
      `Another ${city} home protected with our micro-mesh guards! 🛡️`,
    ],
    'Gutter Cleaning': [
      `Spring cleaning in ${city}! These gutters were FULL. 🍃`,
      `Before and after from today's gutter cleaning in ${city}! ✨`,
      `Got these ${city} gutters flowing like new again! 💧`,
    ],
    'Downspouts': [
      `Upgraded the drainage system on this ${city} home today! 💧`,
      `New downspouts keeping water away from the foundation in ${city}! 🏠`,
      `Better water management for this ${city} property! 👍`,
    ],
    'Underground Drains': [
      `Solved a major drainage problem in ${city} today! 💧`,
      `Underground drainage going in — no more standing water! 🙌`,
      `This ${city} homeowner won't have puddles anymore! ✨`,
    ],
    'Rotten Wood Repair': [
      `Saved this ${city} home from water damage today! 🔧`,
      `Fascia repair complete in ${city} — good as new! ✨`,
      `Fixed the rot, installed new gutters — this ${city} home is protected! 💪`,
    ],
  };
  
  // Pick a random hook
  const serviceHooks = hooks[service] || hooks['Seamless Gutters'];
  const hook = serviceHooks[Math.floor(Math.random() * serviceHooks.length)];
  
  // Build the caption
  let caption = hook + '\n\n';
  
  // Add details if we have them
  if (project.specs) {
    const specs = project.specs;
    const specLines = [];
    
    if (specs.gutterSize) specLines.push(`✅ ${specs.gutterSize} seamless aluminum`);
    if (specs.linearFeet) specLines.push(`✅ ${specs.linearFeet} linear feet`);
    if (specs.color) specLines.push(`✅ ${specs.color} color match`);
    if (specs.downspouts) specLines.push(`✅ ${specs.downspouts} downspouts`);
    if (specs.guardType) specLines.push(`✅ ${specs.guardType}`);
    
    if (specLines.length > 0) {
      caption += specLines.join('\n') + '\n\n';
    }
  }
  
  // Add CTA
  caption += `Need gutters? We serve all of North Alabama! 📍\n`;
  caption += `📞 ${CONFIG.phone}\n`;
  caption += `🌐 ${CONFIG.website}`;
  
  return caption;
}

/**
 * Generate an Instagram caption with hashtags
 * Instagram style: shorter, emoji-heavy, hashtag-focused
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @param {object} project - Generated project object from project-generator.js
 * @returns {string} - Instagram caption with hashtags
 */
export function generateInstagramCaption(contentData, project) {
  const city = contentData.city || 'North Alabama';
  const service = project.service;
  
  // Shorter, punchier hooks for Instagram
  const hooks = {
    'Seamless Gutters': [
      `Fresh gutters in ${city}! ✨🏠`,
      `New seamless gutters looking 👌`,
      `Another happy homeowner in ${city}! 🙌`,
    ],
    'Gutter Guards': [
      `No more gutter cleaning for this ${city} home! 🍂✌️`,
      `Gutter guards = freedom 🙌`,
      `Protected ✅ ${city} home complete!`,
    ],
    'Gutter Cleaning': [
      `Before ➡️ After in ${city}! 🍃✨`,
      `Clean gutters, happy home! 💧`,
      `That satisfying clean 👌`,
    ],
    'Downspouts': [
      `Drainage upgrade in ${city}! 💧`,
      `Water flowing where it should! ✅`,
      `Protecting foundations one downspout at a time 🏠`,
    ],
    'Underground Drains': [
      `Drainage problems? Solved! 💪`,
      `Underground drains = no more puddles 💧`,
      `${city} home protected from water damage ✅`,
    ],
    'Rotten Wood Repair': [
      `Saved from rot! ${city} fascia repair ✨`,
      `Before the damage spreads — fix it right! 🔧`,
      `Good as new! 💪`,
    ],
  };
  
  // Pick a random hook
  const serviceHooks = hooks[service] || hooks['Seamless Gutters'];
  const hook = serviceHooks[Math.floor(Math.random() * serviceHooks.length)];
  
  // Build caption
  let caption = hook + '\n\n';
  caption += `📍 ${city}, Alabama\n`;
  caption += `📞 Link in bio for free estimates!\n\n`;
  
  // Build hashtags
  const hashtags = buildHashtags(city, service);
  caption += hashtags;
  
  return caption;
}

/**
 * Build a curated hashtag string
 * Aims for ~20-25 hashtags (Instagram sweet spot)
 * 
 * @param {string} city - City name
 * @param {string} service - Service type
 * @returns {string} - Hashtag string
 */
function buildHashtags(city, service) {
  const tags = new Set();
  
  // Add core hashtags
  HASHTAGS.core.forEach(tag => tags.add(tag));
  
  // Add location hashtags
  const locationTags = HASHTAGS.locations[city] || HASHTAGS.locations['default'];
  locationTags.forEach(tag => tags.add(tag));
  
  // Add service hashtags
  const serviceTags = HASHTAGS.services[service] || HASHTAGS.services['default'];
  serviceTags.forEach(tag => tags.add(tag));
  
  // Add random engagement hashtags to fill out to ~20
  const shuffledEngagement = [...HASHTAGS.engagement].sort(() => Math.random() - 0.5);
  let i = 0;
  while (tags.size < 20 && i < shuffledEngagement.length) {
    tags.add(shuffledEngagement[i]);
    i++;
  }
  
  return Array.from(tags).join(' ');
}

// =============================================================================
// EMAIL GENERATION
// =============================================================================

/**
 * Generate the email HTML for Adam
 * Clean, simple format that's easy to copy/paste from
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @param {object} project - Generated project object
 * @param {string} facebookCaption - Generated Facebook caption
 * @param {string} instagramCaption - Generated Instagram caption
 * @returns {object} - Email object with subject and html
 */
export function generateEmail(contentData, project, facebookCaption, instagramCaption) {
  const city = contentData.city || 'North Alabama';
  const service = project.service;
  
  // Build photo gallery HTML
  let photoGalleryHtml = '';
  if (project.images && project.images.length > 0) {
    photoGalleryHtml = `
      <div style="margin: 20px 0;">
        <h3 style="color: #1e3a5f; margin-bottom: 10px;">📸 Photos (click to open full size)</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 10px;">
          ${project.images.map((url, i) => `
            <a href="${url}" target="_blank" style="display: block;">
              <img src="${url.replace('/upload/', '/upload/c_fill,w_200,h_200/')}" 
                   alt="Project photo ${i + 1}" 
                   style="width: 200px; height: 200px; object-fit: cover; border-radius: 8px;">
            </a>
          `).join('')}
        </div>
        <p style="color: #666; font-size: 14px; margin-top: 10px;">
          Right-click → Save Image, or click to open full size and download
        </p>
      </div>
    `;
  }
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .section { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .section h2 { color: #1e3a5f; margin-top: 0; font-size: 18px; }
    .caption { background: white; border: 1px solid #e0e0e0; border-radius: 4px; padding: 15px; white-space: pre-wrap; font-family: inherit; }
    .copy-hint { color: #666; font-size: 12px; margin-top: 8px; }
    h1 { color: #1e3a5f; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <h1>🎉 New Project Ready to Post!</h1>
  <p><strong>${service}</strong> in <strong>${city}</strong></p>
  <p>Here's everything you need to post on social media. Just copy, paste, and post!</p>
  
  ${photoGalleryHtml}
  
  <div class="section">
    <h2>📘 Facebook Caption</h2>
    <div class="caption">${escapeHtml(facebookCaption)}</div>
    <p class="copy-hint">Select all → Copy → Paste into Facebook</p>
  </div>
  
  <div class="section">
    <h2>📸 Instagram Caption</h2>
    <div class="caption">${escapeHtml(instagramCaption)}</div>
    <p class="copy-hint">Select all → Copy → Paste into Instagram (hashtags included!)</p>
  </div>
  
  <div class="footer">
    <p>This email was auto-generated by your Content Engine when job #${project._meta?.jobNumber || 'N/A'} was completed.</p>
    <p>Questions? Reply to this email.</p>
  </div>
</body>
</html>
  `;
  
  return {
    subject: `📱 New project ready to post! (${city} ${service.toLowerCase()})`,
    html: html.trim(),
  };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

// =============================================================================
// COURIER INTEGRATION
// =============================================================================

/**
 * Send the social media drafts email via Courier
 * 
 * @param {object} emailData - Email object with subject and html
 * @param {object} env - Worker environment with secrets
 * @returns {Promise<object>} - Send result
 */
export async function sendViaCourier(emailData, env) {
  const payload = {
    to: CONFIG.recipientEmail,
    subject: emailData.subject,
    html: emailData.html,
    from_name: 'Blue River Content Engine',
    reply_to: 'service@bluerivergutters.com',
  };
  
  try {
    const response = await fetch(CONFIG.courierEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Courier send failed:', response.status, errorText);
      throw new Error(`Courier send failed: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('Email sent via Courier:', result);
    
    return {
      success: true,
      messageId: result.messageId || result.id,
    };
  } catch (error) {
    console.error('Error sending via Courier:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// =============================================================================
// MAIN GENERATOR
// =============================================================================

/**
 * Generate social media drafts and email them to Adam
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @param {object} project - Generated project from project-generator.js
 * @param {object} env - Worker environment
 * @returns {Promise<object>} - Result with captions and send status
 */
export async function generateAndSendSocialDrafts(contentData, project, env) {
  console.log('Generating social media drafts...');
  
  // Generate captions
  const facebookCaption = generateFacebookCaption(contentData, project);
  const instagramCaption = generateInstagramCaption(contentData, project);
  
  console.log('Facebook caption:', facebookCaption.substring(0, 100) + '...');
  console.log('Instagram caption:', instagramCaption.substring(0, 100) + '...');
  
  // Generate email
  const emailData = generateEmail(contentData, project, facebookCaption, instagramCaption);
  
  // Send via Courier
  const sendResult = await sendViaCourier(emailData, env);
  
  return {
    facebookCaption,
    instagramCaption,
    emailSent: sendResult.success,
    emailError: sendResult.error || null,
    messageId: sendResult.messageId || null,
  };
}

/**
 * Generate social drafts without sending (for testing/preview)
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @param {object} project - Generated project from project-generator.js
 * @returns {object} - Generated captions and email preview
 */
export function generateSocialDraftsPreview(contentData, project) {
  const facebookCaption = generateFacebookCaption(contentData, project);
  const instagramCaption = generateInstagramCaption(contentData, project);
  const emailData = generateEmail(contentData, project, facebookCaption, instagramCaption);
  
  return {
    facebookCaption,
    instagramCaption,
    emailSubject: emailData.subject,
    emailHtml: emailData.html,
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  generateFacebookCaption,
  generateInstagramCaption,
  buildHashtags,
  generateEmail,
  sendViaCourier,
  generateAndSendSocialDrafts,
  generateSocialDraftsPreview,
  CONFIG,
  HASHTAGS,
};
