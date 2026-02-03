/**
 * Project Page Generator Module
 * 
 * Transforms processed job data into Eleventy-ready project content.
 * Outputs JSON that matches the projects.json schema used by the website.
 */

import { getThumbnailUrl, getGalleryUrl } from './photo-pipeline.js';

// Service type mapping from Jobber line items to display names
const SERVICE_MAP = {
  'seamless': 'Seamless Gutters',
  'gutter': 'Seamless Gutters',
  'gutters': 'Seamless Gutters',
  'guard': 'Gutter Guards',
  'guards': 'Gutter Guards',
  'leaf': 'Gutter Guards',
  'clean': 'Gutter Cleaning',
  'cleaning': 'Gutter Cleaning',
  'downspout': 'Downspouts',
  'underground': 'Underground Drains',
  'drain': 'Underground Drains',
  'drainage': 'Underground Drains',
  'fascia': 'Rotten Wood Repair',
  'rotten': 'Rotten Wood Repair',
  'wood': 'Rotten Wood Repair',
  'repair': 'Rotten Wood Repair',
};

// Alabama city list for validation
const ALABAMA_CITIES = [
  'Huntsville', 'Madison', 'Decatur', 'Athens', 'Hartselle',
  'Scottsboro', 'Albertville', 'Cullman', 'Arab', 'Guntersville',
  'Meridianville', 'Hazel Green', 'Hampton Cove', 'Owens Cross Roads',
  'Harvest', 'Toney', 'New Hope', 'New Market', 'Monrovia', 'Brownsboro',
  'Priceville', 'Trinity', 'Tanner', 'Somerville', 'Laceys Spring',
  'Elkmont', 'Ardmore', 'Gurley', 'Paint Rock', 'Triana'
];

/**
 * Generate a project page from content data
 * @param {Object} contentData - Extracted content data from jobber-api
 * @param {Object} options - Generation options
 * @returns {Object} - Project data ready for Eleventy
 */
export function generateProject(contentData, options = {}) {
  const city = contentData.city || 'North Alabama';
  const service = contentData.primaryService || 'Seamless Gutters';
  const date = formatDate(contentData.completedAt || new Date());
  const slug = generateSlug(city, service, date);
  
  // Get processed photos from contentData
  const photos = (contentData.processedPhotos || []).filter(p => p.processed && p.cloudinaryPublicId);
  
  const project = {
    title: generateTitle(service, city),
    slug,
    date: date.iso,
    city,
    service,
    thumbnail: photos[0] ? getThumbnailUrl(photos[0].cloudinaryPublicId) : null,
    images: photos.map(p => getGalleryUrl(p.cloudinaryPublicId)),
    description: generateDescription(service, city),
    details: generateDetails(contentData, service, city),
    specs: extractSpecs(contentData, service),
    featured: options.featured || false,
    jobNumber: contentData.jobNumber || contentData.jobId,
  };
  
  // Include schema if requested
  if (options.includeSchema) {
    project.schema = generateSchema(service, city, photos);
  }
  
  return project;
}

// Alias for backward compatibility
export const generateProjectPage = generateProject;

/**
 * Get URL for a service page
 */
export function getServicePageUrl(service) {
  const serviceSlug = service.toLowerCase().replace(/\s+/g, '-');
  return `/services/${serviceSlug}/`;
}

/**
 * Get URL for a city landing page
 */
export function getCityPageUrl(city) {
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  return `/gutters-${citySlug}-al/`;
}

/**
 * Get URL for a city+service page
 */
export function getCityServicePageUrl(city, service) {
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const serviceSlug = service.toLowerCase().replace(/\s+/g, '-');
  return `/${serviceSlug}-${citySlug}-al/`;
}

function extractCity(jobData) {
  const address = jobData.property?.address || jobData.client?.address || {};
  let city = address.city || 'North Alabama';
  const match = ALABAMA_CITIES.find(c => c.toLowerCase() === city.toLowerCase().trim());
  return match || city.trim();
}

function detectService(jobData) {
  const lineItems = jobData.lineItems || jobData.line_items || [];
  for (const item of lineItems) {
    const name = (item.name || item.description || '').toLowerCase();
    for (const [keyword, service] of Object.entries(SERVICE_MAP)) {
      if (name.includes(keyword)) return service;
    }
  }
  const title = (jobData.title || jobData.name || '').toLowerCase();
  for (const [keyword, service] of Object.entries(SERVICE_MAP)) {
    if (title.includes(keyword)) return service;
  }
  return 'Seamless Gutters';
}

function formatDate(dateStr) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const monthsShort = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return {
    iso: date.toISOString().split('T')[0],
    monthYear: `${monthsShort[date.getMonth()]}-${date.getFullYear()}`,
  };
}

function generateSlug(city, service, date) {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const serviceSlug = service.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '');
  return `${citySlug}-${serviceSlug}-${date.monthYear}`;
}

function generateTitle(service, city) {
  return `${service} in ${city}, AL`;
}

function generateDescription(service, city) {
  const templates = {
    'Seamless Gutters': `Complete seamless gutter installation for a ${city} home.`,
    'Gutter Guards': `Professional gutter guard installation in ${city}.`,
    'Gutter Cleaning': `Full gutter cleaning service in ${city}.`,
    'Downspouts': `Downspout replacement and repair in ${city}.`,
    'Underground Drains': `Underground drainage system installed in ${city}.`,
    'Rotten Wood Repair': `Fascia board repair and replacement in ${city}.`,
  };
  return templates[service] || templates['Seamless Gutters'];
}

function generateDetails(contentData, service, city) {
  const notes = contentData.notes || contentData.description || '';
  if (notes.length > 50) return notes.replace(/\n+/g, ' ').trim().slice(0, 500);
  
  const hooks = {
    'Huntsville': "With Huntsville's clay soil and heavy spring rains, proper drainage is essential.",
    'Madison': "Madison's rapid growth means many homes have builder-grade gutters that need upgrading.",
    'default': "North Alabama's weather patterns make quality gutters essential for protecting your home.",
  };
  const hook = hooks[city] || hooks['default'];
  
  const templates = {
    'Seamless Gutters': `This ${city} homeowner needed new gutters. We installed seamless aluminum gutters custom-fabricated on-site. ${hook}`,
    'Gutter Guards': `This ${city} homeowner opted for professional gutter guard installation. We installed micro-mesh guards that keep out debris. ${hook}`,
    'Gutter Cleaning': `This ${city} home needed gutter cleaning. We removed all debris and flushed the downspouts. ${hook}`,
    'Downspouts': `The downspouts on this ${city} home were causing overflow. We upgraded to larger downspouts. ${hook}`,
    'Underground Drains': `Water pooling was a concern for this ${city} homeowner. We installed underground drainage. ${hook}`,
    'Rotten Wood Repair': `Moisture damage had affected this ${city} home's fascia. We replaced damaged wood and added capping. ${hook}`,
  };
  return templates[service] || templates['Seamless Gutters'];
}

function extractSpecs(contentData, service) {
  const specs = {};
  const lineItems = contentData.lineItems || contentData.line_items || [];
  for (const item of lineItems) {
    const name = (item.name || '').toLowerCase();
    const qty = item.quantity || item.qty;
    if (name.includes('linear') || name.includes('feet')) specs.linearFeet = qty;
    if (name.includes('downspout')) specs.downspouts = qty;
  }
  if (service === 'Seamless Gutters') {
    specs.gutterSize = '6-inch K-style';
    specs.material = '0.032 gauge aluminum';
  }
  if (service === 'Gutter Guards') {
    specs.guardType = 'Micro-mesh stainless steel';
    specs.warranty = 'Lifetime clog-free guarantee';
  }
  return Object.keys(specs).length > 0 ? specs : null;
}

function generateSchema(service, city, photos) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: service,
    provider: {
      '@type': 'LocalBusiness',
      name: 'Blue River Gutters',
      telephone: '+1-256-616-6760',
    },
    areaServed: { '@type': 'City', name: city },
    image: photos.map(p => p.cloudinaryUrl || p.optimizedUrl),
  };
}

function generateRelatedLinks(city, service) {
  return {
    cityPage: getCityPageUrl(city),
    servicePage: getServicePageUrl(service),
    allProjects: '/recent-projects/',
  };
}

export function projectToMarkdown(project) {
  const fm = ['---'];
  fm.push(`title: "${project.title}"`);
  fm.push(`slug: ${project.slug}`);
  fm.push(`date: ${project.date}`);
  fm.push(`city: ${project.city}`);
  fm.push(`service: ${project.service}`);
  if (project.thumbnail) fm.push(`thumbnail: ${project.thumbnail}`);
  if (project.images?.length) {
    fm.push('images:');
    project.images.forEach(img => fm.push(`  - "${img}"`));
  }
  fm.push(`description: "${project.description}"`);
  fm.push(`featured: ${project.featured}`);
  fm.push('---');
  fm.push('');
  fm.push(project.details);
  return fm.join('\n');
}

export function generateProjectBatch(jobs) {
  return jobs.map(({ jobData, photos }) => generateProject(jobData, photos));
}
