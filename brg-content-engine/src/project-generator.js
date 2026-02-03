/**
 * Project Page Generator
 * 
 * Transforms processed Jobber job data into Eleventy-compatible project format.
 * Outputs JSON structure matching src/_data/projects.json schema.
 * 
 * Input: contentData from jobber-api.js extractContentData()
 * Output: Project object ready for projects.json
 */

// =============================================================================
// SERVICE MAPPING
// =============================================================================

/**
 * Map Jobber line item names to standardized service categories
 * These match the services defined on the Blue River Gutters site
 */
const SERVICE_MAPPING = {
  // Seamless Gutters variations
  'seamless gutter': 'Seamless Gutters',
  'seamless gutters': 'Seamless Gutters',
  'gutter installation': 'Seamless Gutters',
  'gutter replacement': 'Seamless Gutters',
  'new gutters': 'Seamless Gutters',
  '5 inch gutter': 'Seamless Gutters',
  '6 inch gutter': 'Seamless Gutters',
  '5" gutter': 'Seamless Gutters',
  '6" gutter': 'Seamless Gutters',
  'k-style gutter': 'Seamless Gutters',
  'half-round gutter': 'Seamless Gutters',
  
  // Gutter Guards variations
  'gutter guard': 'Gutter Guards',
  'gutter guards': 'Gutter Guards',
  'leaf guard': 'Gutter Guards',
  'leaf guards': 'Gutter Guards',
  'gutter protection': 'Gutter Guards',
  'micro-mesh': 'Gutter Guards',
  'micromesh': 'Gutter Guards',
  'gutter screen': 'Gutter Guards',
  'gutter cover': 'Gutter Guards',
  
  // Gutter Cleaning variations
  'gutter cleaning': 'Gutter Cleaning',
  'gutter clean': 'Gutter Cleaning',
  'clean gutters': 'Gutter Cleaning',
  'gutter flush': 'Gutter Cleaning',
  'debris removal': 'Gutter Cleaning',
  
  // Downspouts variations
  'downspout': 'Downspouts',
  'downspouts': 'Downspouts',
  'downspout installation': 'Downspouts',
  'downspout replacement': 'Downspouts',
  'downspout extension': 'Downspouts',
  
  // Underground Drains variations
  'underground drain': 'Underground Drains',
  'underground drains': 'Underground Drains',
  'underground drainage': 'Underground Drains',
  'french drain': 'Underground Drains',
  'drain pipe': 'Underground Drains',
  'drainage': 'Underground Drains',
  'pop-up emitter': 'Underground Drains',
  'catch basin': 'Underground Drains',
  
  // Rotten Wood Repair variations
  'fascia': 'Rotten Wood Repair',
  'fascia repair': 'Rotten Wood Repair',
  'fascia replacement': 'Rotten Wood Repair',
  'fascia board': 'Rotten Wood Repair',
  'rotten wood': 'Rotten Wood Repair',
  'wood repair': 'Rotten Wood Repair',
  'soffit': 'Rotten Wood Repair',
  'soffit repair': 'Rotten Wood Repair',
  'fascia capping': 'Rotten Wood Repair',
  'wood replacement': 'Rotten Wood Repair',
};

/**
 * Determine the primary service from a list of line items
 * @param {string[]} services - Array of service/line item names
 * @returns {string} - Standardized service name
 */
export function determinePrimaryService(services) {
  if (!services || services.length === 0) {
    return 'Gutter Service';
  }
  
  // Check each service against our mapping
  for (const service of services) {
    const normalized = service.toLowerCase().trim();
    
    // Direct match
    if (SERVICE_MAPPING[normalized]) {
      return SERVICE_MAPPING[normalized];
    }
    
    // Partial match - check if any mapping key is contained in the service name
    for (const [key, value] of Object.entries(SERVICE_MAPPING)) {
      if (normalized.includes(key)) {
        return value;
      }
    }
  }
  
  // Default fallback
  return 'Seamless Gutters';
}

// =============================================================================
// SLUG GENERATION
// =============================================================================

/**
 * Generate a URL-safe slug from job data
 * Format: [service-type]-[city]-[month]-[year]
 * Example: seamless-gutters-madison-feb-2026
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @returns {string} - URL-safe slug
 */
export function generateSlug(contentData) {
  const service = determinePrimaryService(contentData.services)
    .toLowerCase()
    .replace(/\s+/g, '-');
  
  const city = (contentData.city || 'north-alabama')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  const date = new Date(contentData.completedAt || Date.now());
  const month = date.toLocaleString('en-US', { month: 'short' }).toLowerCase();
  const year = date.getFullYear();
  
  return `${service}-${city}-${month}-${year}`;
}

// =============================================================================
// TITLE GENERATION
// =============================================================================

/**
 * Generate a human-readable title for the project
 * Format: "[Service] in [City], AL"
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @returns {string} - Project title
 */
export function generateTitle(contentData) {
  const service = determinePrimaryService(contentData.services);
  const city = contentData.city || 'North Alabama';
  
  // Use "Installation" for new work, omit for repairs/cleaning
  const needsInstallation = ['Seamless Gutters', 'Gutter Guards', 'Downspouts', 'Underground Drains']
    .includes(service);
  
  if (needsInstallation) {
    return `${service} Installation - ${city}`;
  }
  
  return `${service} - ${city}`;
}

// =============================================================================
// DESCRIPTION GENERATION
// =============================================================================

/**
 * Generate a short description (1-2 sentences) for the project card
 * Uses technician notes if available, otherwise generates generic description
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @returns {string} - Short description
 */
export function generateDescription(contentData) {
  const service = determinePrimaryService(contentData.services);
  const customerType = contentData.customerType || 'residential';
  const city = contentData.city || 'North Alabama';
  
  // Try to extract something useful from technician notes
  const notes = contentData.technicianNotes || '';
  if (notes.length > 50) {
    // Take first sentence or first 150 chars
    const firstSentence = notes.split(/[.!?]/)[0]?.trim();
    if (firstSentence && firstSentence.length >= 30 && firstSentence.length <= 150) {
      return firstSentence + '.';
    }
  }
  
  // Generate based on service type
  const descriptions = {
    'Seamless Gutters': customerType === 'commercial' 
      ? `Commercial seamless gutter installation for a ${city} business.`
      : `Complete seamless gutter system installation for a ${city} homeowner.`,
    
    'Gutter Guards': `Professional gutter guard installation to protect against ${city}'s heavy tree coverage.`,
    
    'Gutter Cleaning': `Thorough gutter cleaning and debris removal for a ${city} home.`,
    
    'Downspouts': `Downspout installation and drainage improvement for better water management in ${city}.`,
    
    'Underground Drains': `Underground drainage system to address water pooling issues in ${city}.`,
    
    'Rotten Wood Repair': `Fascia and wood repair to fix water damage on a ${city} home.`,
  };
  
  return descriptions[service] || `Professional gutter service completed in ${city}.`;
}

/**
 * Generate detailed description (2-4 sentences) for the project page
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @returns {string} - Detailed description
 */
export function generateDetails(contentData) {
  const service = determinePrimaryService(contentData.services);
  const customerType = contentData.customerType || 'residential';
  const city = contentData.city || 'North Alabama';
  
  // Use technician notes if substantial
  const notes = contentData.technicianNotes || '';
  if (notes.length > 100) {
    // Clean up notes: remove internal jargon, ensure it reads well
    const cleaned = notes
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (cleaned.length <= 500) {
      return cleaned;
    }
    // Truncate to ~500 chars at sentence boundary
    const truncated = cleaned.substring(0, 500);
    const lastSentence = truncated.lastIndexOf('.');
    if (lastSentence > 200) {
      return truncated.substring(0, lastSentence + 1);
    }
  }
  
  // Generate based on service type and local context
  const localHooks = {
    drainage: "North Alabama's red clay soil doesn't absorb water well, causing drainage challenges for many homeowners.",
    humidity: "Alabama's humid climate accelerates wood rot and gutter deterioration.",
    trees: `${city}'s mature trees mean heavy leaf and debris load on gutters each fall.`,
    storms: "Our spring storm season puts extra demand on gutter systems.",
  };
  
  const details = {
    'Seamless Gutters': customerType === 'commercial'
      ? `This ${city} business needed a complete gutter system upgrade. ${localHooks.storms} We installed commercial-grade seamless aluminum gutters designed to handle high water volume.`
      : `This ${city} homeowner was dealing with failing seamed gutters. ${localHooks.humidity} We removed the old system and installed seamless aluminum gutters with proper slope for optimal drainage.`,
    
    'Gutter Guards': `${localHooks.trees} This homeowner was tired of climbing ladders multiple times per year. We installed micro-mesh gutter guards that handle both large leaves and pine needles.`,
    
    'Gutter Cleaning': `This ${city} home hadn't had gutters cleaned in over two years. We removed all debris, flushed the downspouts, and checked for any damage or alignment issues.`,
    
    'Downspouts': `This ${city} home had water pooling near the foundation due to inadequate downspout placement. We installed additional downspouts and extensions to direct water safely away from the structure.`,
    
    'Underground Drains': `${localHooks.drainage} This ${city} homeowner was dealing with standing water near the foundation. We installed underground drain pipe with pop-up emitters positioned well away from the house.`,
    
    'Rotten Wood Repair': `${localHooks.humidity} This ${city} home had significant fascia damage from overflowing gutters. We replaced the damaged wood with treated lumber and installed aluminum capping for long-term protection.`,
  };
  
  return details[service] || `Professional ${service.toLowerCase()} service completed for a ${city} ${customerType === 'commercial' ? 'business' : 'homeowner'}.`;
}

// =============================================================================
// SPECS EXTRACTION
// =============================================================================

/**
 * Extract specs from line items and notes
 * Attempts to find specific technical details
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @returns {object} - Specs object
 */
export function extractSpecs(contentData) {
  const service = determinePrimaryService(contentData.services);
  const lineItems = contentData.raw?.lineItems || [];
  const notes = contentData.technicianNotes || '';
  const allText = (notes + ' ' + lineItems.map(i => `${i.name} ${i.description || ''}`).join(' ')).toLowerCase();
  
  const specs = {};
  
  // Common patterns to extract
  const patterns = {
    gutterSize: /(\d+)[\s-]*(inch|")\s*(k-style|half-round|gutter)/i,
    material: /(0\.0\d+)\s*gauge\s*aluminum/i,
    linearFeet: /(\d+)\s*(linear feet|lin\.?\s*ft\.?|lf)/i,
    downspouts: /(\d+)\s*downspouts?/i,
    color: /(white|bronze|brown|black|clay|almond|musket brown)/i,
  };
  
  // Extract gutter size
  const gutterMatch = allText.match(patterns.gutterSize);
  if (gutterMatch) {
    const style = gutterMatch[3]?.includes('half') ? 'half-round' : 'K-style';
    specs.gutterSize = `${gutterMatch[1]}-inch ${style}`;
  }
  
  // Extract material
  const materialMatch = allText.match(patterns.material);
  if (materialMatch) {
    specs.material = `${materialMatch[1]} gauge aluminum`;
  }
  
  // Extract linear feet
  const linearFeetMatch = allText.match(patterns.linearFeet);
  if (linearFeetMatch) {
    specs.linearFeet = parseInt(linearFeetMatch[1]);
  }
  
  // Extract downspout count
  const downspoutsMatch = allText.match(patterns.downspouts);
  if (downspoutsMatch) {
    specs.downspouts = parseInt(downspoutsMatch[1]);
  }
  
  // Extract color
  const colorMatch = allText.match(patterns.color);
  if (colorMatch) {
    specs.color = colorMatch[1].charAt(0).toUpperCase() + colorMatch[1].slice(1);
  }
  
  // Service-specific specs
  switch (service) {
    case 'Gutter Guards':
      if (allText.includes('micro-mesh') || allText.includes('micromesh')) {
        specs.guardType = 'Micro-mesh stainless steel';
      } else if (allText.includes('screen')) {
        specs.guardType = 'Aluminum screen';
      }
      specs.warranty = 'Lifetime clog-free guarantee';
      break;
      
    case 'Underground Drains':
      const pipeMatch = allText.match(/(\d+)[\s-]*(inch|")\s*(corrugated|pvc|pipe)/i);
      if (pipeMatch) {
        specs.pipeType = `${pipeMatch[1]}-inch ${pipeMatch[3]}`;
      }
      const emitterMatch = allText.match(/(\d+)\s*pop[\s-]?up\s*emitter/i);
      if (emitterMatch) {
        specs.emitters = parseInt(emitterMatch[1]);
      }
      break;
      
    case 'Rotten Wood Repair':
      const fasciaMatch = allText.match(/(\d+)\s*(linear feet|feet|ft).*fascia/i);
      if (fasciaMatch) {
        specs.fasciaReplaced = `${fasciaMatch[1]} linear feet`;
      }
      if (allText.includes('capping') || allText.includes('cap')) {
        specs.cappingInstalled = 'Yes - aluminum';
      }
      break;
  }
  
  return Object.keys(specs).length > 0 ? specs : null;
}

// =============================================================================
// SCHEMA MARKUP
// =============================================================================

/**
 * Generate Article schema markup for the project page
 * @param {object} project - Generated project object
 * @returns {object} - JSON-LD schema object
 */
export function generateArticleSchema(project) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": project.title,
    "description": project.description,
    "datePublished": project.date,
    "image": project.images?.[0] || project.thumbnail,
    "author": {
      "@type": "Organization",
      "name": "Blue River Gutters",
      "url": "https://bluerivergutters.com"
    },
    "publisher": {
      "@type": "Organization",
      "name": "Blue River Gutters",
      "logo": {
        "@type": "ImageObject",
        "url": "https://bluerivergutters.com/images/logo.png"
      }
    }
  };
}

/**
 * Generate Service schema markup
 * @param {object} project - Generated project object
 * @returns {object} - JSON-LD schema object
 */
export function generateServiceSchema(project) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "name": project.service,
    "provider": {
      "@type": "LocalBusiness",
      "name": "Blue River Gutters",
      "@id": "https://bluerivergutters.com/#organization"
    },
    "areaServed": {
      "@type": "City",
      "name": project.city,
      "containedInPlace": {
        "@type": "State",
        "name": "Alabama"
      }
    },
    "description": project.details
  };
}

// =============================================================================
// MAIN GENERATOR
// =============================================================================

/**
 * Generate a complete project object from content data
 * Output matches the schema in src/_data/projects.json
 * 
 * @param {object} contentData - Content data from extractContentData()
 * @param {object} options - Generation options
 * @param {boolean} options.includeSchema - Include schema markup (default: true)
 * @param {boolean} options.featured - Mark as featured project (default: false)
 * @returns {object} - Project object ready for projects.json
 */
export function generateProject(contentData, options = {}) {
  const { includeSchema = true, featured = false } = options;
  
  // Determine service first as it affects other fields
  const service = determinePrimaryService(contentData.services);
  const city = contentData.city || 'North Alabama';
  
  // Build the project object
  const project = {
    title: generateTitle(contentData),
    slug: generateSlug(contentData),
    date: contentData.completedAt 
      ? new Date(contentData.completedAt).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0],
    city: city,
    service: service,
    thumbnail: null,
    images: [],
    description: generateDescription(contentData),
    details: generateDetails(contentData),
    specs: extractSpecs(contentData),
    featured: featured,
  };
  
  // Add photo URLs if available (from photo-pipeline.js processing)
  if (contentData.processedPhotos && contentData.processedPhotos.length > 0) {
    const photos = contentData.processedPhotos.filter(p => p.processed);
    
    // First photo becomes thumbnail
    if (photos[0]) {
      project.thumbnail = photos[0].thumbnailUrl || photos[0].optimizedUrl;
    }
    
    // All photos go in images array (hero/gallery size)
    project.images = photos.map(p => 
      p.optimizedUrl || p.cloudinarySecureUrl
    );
  } else if (contentData.photoUrls && contentData.photoUrls.length > 0) {
    // Fallback to raw Jobber URLs (shouldn't be used for production)
    project.thumbnail = contentData.photoUrls[0];
    project.images = contentData.photoUrls;
  }
  
  // Add schema markup if requested
  if (includeSchema) {
    project.schema = {
      article: generateArticleSchema(project),
      service: generateServiceSchema(project),
    };
  }
  
  // Add internal reference data (not for public display)
  project._meta = {
    jobNumber: contentData.raw?.jobNumber,
    jobId: contentData.raw?.id,
    generatedAt: new Date().toISOString(),
    hasPhotos: contentData.hasPhotos,
    photoCount: contentData.photoCount,
  };
  
  return project;
}

/**
 * Get the service page URL for internal linking
 * @param {string} service - Service name
 * @param {string} city - City name
 * @returns {string} - Relative URL to service page
 */
export function getServicePageUrl(service, city) {
  const serviceSlug = {
    'Seamless Gutters': 'seamless-gutters',
    'Gutter Guards': 'gutter-guards',
    'Gutter Cleaning': 'gutter-cleaning',
    'Downspouts': 'downspouts',
    'Underground Drains': 'underground-drains',
    'Rotten Wood Repair': 'rotten-wood-repair',
  }[service] || 'seamless-gutters';
  
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  
  return `/services/${citySlug}/${serviceSlug}-${citySlug}-al/`;
}

/**
 * Get the city landing page URL
 * @param {string} city - City name
 * @returns {string} - Relative URL to city page
 */
export function getCityPageUrl(city) {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `/locations/gutters-${citySlug}-al/`;
}

// =============================================================================
// EXPORT FOR USE IN CONTENT ENGINE
// =============================================================================

export default {
  generateProject,
  generateSlug,
  generateTitle,
  generateDescription,
  generateDetails,
  extractSpecs,
  determinePrimaryService,
  generateArticleSchema,
  generateServiceSchema,
  getServicePageUrl,
  getCityPageUrl,
};
