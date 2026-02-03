/**
 * GMB Post Generator Module
 * 
 * Creates Google Business Profile posts automatically when jobs complete.
 * Generates engaging content with photos and call-to-action buttons.
 */

import { createPost } from './google-gbp.js';
import { getHeroUrl } from './photo-pipeline.js';

// Blue River Gutters constants
const PHONE_NUMBER = '(256) 616-6760';
const SCHEDULING_URL = 'https://BlueRiverGutters.as.me/';

// Service-specific post templates
const POST_TEMPLATES = {
  'Seamless Gutters': {
    intros: [
      'Just completed a seamless gutter installation',
      'Another seamless gutter project wrapped up',
      'Fresh seamless gutters installed',
      'New seamless gutter system complete',
    ],
    descriptions: [
      'Custom-fabricated on-site for a perfect fit with zero seams to leak.',
      'Built to handle North Alabama\'s heavy spring rains.',
      'Professional installation with hidden hangers for a clean look.',
      'Quality .032 gauge aluminum that\'ll last for decades.',
    ],
    hashtags: ['#SeamlessGutters', '#GutterInstallation', '#BlueRiverGutters'],
  },
  'Gutter Guards': {
    intros: [
      'Just installed gutter guards',
      'Gutter guard installation complete',
      'Another home protected with gutter guards',
      'Leaf protection system installed',
    ],
    descriptions: [
      'No more climbing ladders to clean gutters!',
      'Micro-mesh guards that stop leaves AND pine needles.',
      'Lifetime clog-free guarantee included.',
      'Say goodbye to gutter cleaning forever.',
    ],
    hashtags: ['#GutterGuards', '#LeafProtection', '#BlueRiverGutters'],
  },
  'Gutter Cleaning': {
    intros: [
      'Just finished a gutter cleaning',
      'Gutters cleaned and flowing',
      'Professional gutter cleanout complete',
      'Another gutter cleaning done right',
    ],
    descriptions: [
      'Debris removed, downspouts flushed, ready for the next rain.',
      'Protecting this home\'s foundation one cleaning at a time.',
      'Clean gutters = happy homeowner.',
      'Full service cleaning including downspout flush.',
    ],
    hashtags: ['#GutterCleaning', '#HomeMaintenance', '#BlueRiverGutters'],
  },
  'Downspouts': {
    intros: [
      'Downspout upgrade complete',
      'New downspouts installed',
      'Downspout replacement finished',
      'Fresh downspouts directing water safely away',
    ],
    descriptions: [
      'Larger capacity to handle heavy Alabama storms.',
      'Extensions added to protect the foundation.',
      'Proper water management starts with good downspouts.',
      'No more overflow during heavy rain.',
    ],
    hashtags: ['#Downspouts', '#DrainageSolutions', '#BlueRiverGutters'],
  },
  'Underground Drains': {
    intros: [
      'Underground drain system installed',
      'Drainage solution complete',
      'Underground drainage project finished',
      'Water management system in place',
    ],
    descriptions: [
      'Water now exits 30+ feet from the foundation.',
      'Pop-up emitters release water safely away from the home.',
      'No more pooling water near the foundation.',
      'Solving drainage problems the right way.',
    ],
    hashtags: ['#UndergroundDrains', '#DrainageSolutions', '#BlueRiverGutters'],
  },
  'Rotten Wood Repair': {
    intros: [
      'Fascia repair complete',
      'Rotten wood replaced and protected',
      'Fascia restoration finished',
      'Wood rot repair done right',
    ],
    descriptions: [
      'New treated lumber plus aluminum capping to prevent future rot.',
      'Stopping moisture damage in its tracks.',
      'Fresh fascia ready for new gutters.',
      'Protected against Alabama humidity.',
    ],
    hashtags: ['#FasciaRepair', '#WoodRepair', '#BlueRiverGutters'],
  },
};

/**
 * Generate a GMB post from completed job data
 */
export function generateGMBPost(jobData, processedPhotos = []) {
  const city = extractCity(jobData);
  const service = detectService(jobData);
  const template = POST_TEMPLATES[service] || POST_TEMPLATES['Seamless Gutters'];
  
  const intro = pickRandom(template.intros);
  const description = pickRandom(template.descriptions);
  const hashtags = template.hashtags.join(' ');
  const summary = buildPostSummary(intro, city, description, hashtags);
  
  const bestPhoto = processedPhotos.find(p => p.processed && p.cloudinaryPublicId);
  const photoUrl = bestPhoto ? getHeroUrl(bestPhoto.cloudinaryPublicId) : null;
  
  return {
    type: 'STANDARD',
    summary,
    media: photoUrl ? [{ type: 'PHOTO', url: photoUrl }] : [],
    callToAction: { type: 'BOOK', url: SCHEDULING_URL },
    _meta: {
      city,
      service,
      jobNumber: jobData.jobNumber || jobData.id,
      hasPhoto: !!photoUrl,
      generatedAt: new Date().toISOString(),
    },
  };
}

function buildPostSummary(intro, city, description, hashtags) {
  return [
    `${intro} in ${city}, AL! 🏠`,
    '',
    description,
    '',
    `Need gutters? Call ${PHONE_NUMBER} or schedule online!`,
    '',
    hashtags,
  ].join('\n');
}

/**
 * Post to GMB immediately
 */
export async function postToGMB(env, locationId, jobData, processedPhotos) {
  const postData = generateGMBPost(jobData, processedPhotos);
  
  console.log(`[GMB] Creating post for ${postData._meta.service} in ${postData._meta.city}`);
  
  try {
    const result = await createPost(env, locationId, {
      type: postData.type,
      summary: postData.summary,
      media: postData.media,
      callToAction: postData.callToAction,
    });
    
    console.log(`[GMB] Post created: ${result.name}`);
    return { success: true, postId: result.name, meta: postData._meta };
  } catch (error) {
    console.error(`[GMB] Failed: ${error.message}`);
    return { success: false, error: error.message, meta: postData._meta };
  }
}

/**
 * Preview post without posting
 */
export function previewGMBPost(jobData, processedPhotos = []) {
  const postData = generateGMBPost(jobData, processedPhotos);
  return {
    preview: true,
    summary: postData.summary,
    photoUrl: postData.media[0]?.url || null,
    ctaType: postData.callToAction.type,
    ctaUrl: postData.callToAction.url,
    meta: postData._meta,
    charCount: postData.summary.length,
    withinLimit: postData.summary.length <= 1500,
  };
}

function extractCity(jobData) {
  const address = jobData.property?.address || jobData.client?.address || {};
  return address.city?.trim() || 'North Alabama';
}

function detectService(jobData) {
  const SERVICE_KEYWORDS = {
    'Seamless Gutters': ['seamless', 'gutter', 'gutters', 'installation'],
    'Gutter Guards': ['guard', 'guards', 'leaf', 'protection', 'mesh'],
    'Gutter Cleaning': ['clean', 'cleaning', 'cleanout', 'flush'],
    'Downspouts': ['downspout', 'downspouts', 'spout'],
    'Underground Drains': ['underground', 'drain', 'drainage', 'buried', 'pipe'],
    'Rotten Wood Repair': ['fascia', 'rotten', 'wood', 'repair', 'rot'],
  };
  
  const lineItems = jobData.lineItems || jobData.line_items || [];
  for (const item of lineItems) {
    const text = (item.name || item.description || '').toLowerCase();
    for (const [service, keywords] of Object.entries(SERVICE_KEYWORDS)) {
      if (keywords.some(kw => text.includes(kw))) return service;
    }
  }
  
  const title = (jobData.title || jobData.name || '').toLowerCase();
  for (const [service, keywords] of Object.entries(SERVICE_KEYWORDS)) {
    if (keywords.some(kw => title.includes(kw))) return service;
  }
  
  return 'Seamless Gutters';
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generatePostBatch(jobs) {
  return jobs.map(({ jobData, photos }) => ({
    jobNumber: jobData.jobNumber || jobData.id,
    post: generateGMBPost(jobData, photos),
  }));
}
