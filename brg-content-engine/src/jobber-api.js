/**
 * Jobber GraphQL API Client
 * 
 * Provides methods to query Jobber's GraphQL API for job and visit data.
 * Uses OAuth tokens stored in KV via the auth module.
 */

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_API_VERSION = '2024-01-01'; // Update as needed

/**
 * Execute a GraphQL query against Jobber's API
 * 
 * @param {string} accessToken - OAuth access token
 * @param {string} query - GraphQL query string
 * @param {object} variables - Query variables
 * @returns {Promise<object>} - Query result
 */
export async function executeQuery(accessToken, query, variables = {}) {
  const response = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Jobber API error:', response.status, errorText);
    throw new Error(`Jobber API request failed: ${response.status}`);
  }
  
  const result = await response.json();
  
  // Check for GraphQL errors
  if (result.errors && result.errors.length > 0) {
    console.error('GraphQL errors:', JSON.stringify(result.errors));
    throw new Error(`GraphQL error: ${result.errors[0].message}`);
  }
  
  return result.data;
}

// =============================================================================
// GRAPHQL QUERIES
// =============================================================================

/**
 * Query to fetch a single job by ID with full details
 */
const GET_JOB_QUERY = `
  query GetJob($id: EncodedId!) {
    job(id: $id) {
      id
      jobNumber
      title
      jobStatus
      jobType
      instructions
      completedAt
      createdAt
      startAt
      endAt
      
      client {
        id
        firstName
        lastName
        companyName
      }
      
      property {
        id
        address {
          city
          street
          province
          postalCode
        }
      }
      
      lineItems(first: 50) {
        nodes {
          id
          name
          description
          quantity
          unitPrice
          totalPrice
        }
      }
      
      notes(first: 20) {
        nodes {
          ... on JobNote {
            id
            message
            createdAt
          }
        }
      }
      
      noteAttachments(first: 20) {
        nodes {
          id
          fileName
          fileUrl
          contentType
          createdAt
        }
      }
    }
  }
`;

/**
 * Query to fetch a visit by ID with job details
 */
const GET_VISIT_QUERY = `
  query GetVisit($id: EncodedId!) {
    visit(id: $id) {
      id
      title
      isComplete
      duration
      instructions
      visitStatus
      
      property {
        id
        address {
          city
          street
          province
          postalCode
        }
      }
      
      job {
        id
        jobNumber
        title
        jobStatus
        completedAt
        instructions
        
        client {
          id
          firstName
          lastName
          companyName
        }
        
        lineItems(first: 50) {
          nodes {
            id
            name
            description
            quantity
            unitPrice
            totalPrice
          }
        }
        
        notes(first: 20) {
          nodes {
            ... on JobNote {
              id
              message
              createdAt
            }
          }
        }
        
        noteAttachments(first: 20) {
          nodes {
            id
            fileName
            fileUrl
            contentType
            createdAt
          }
        }
      }
      
      lineItems(first: 50) {
        nodes {
          id
          name
          description
          quantity
        }
      }
    }
  }
`;

/**
 * Query to fetch recent completed jobs
 */
const GET_RECENT_COMPLETED_JOBS_QUERY = `
  query GetRecentCompletedJobs($first: Int!) {
    jobs(
      first: $first,
      filter: { jobStatus: COMPLETED }
      sort: { key: COMPLETED_AT, direction: DESCENDING }
    ) {
      nodes {
        id
        jobNumber
        title
        completedAt
        
        property {
          id
          address {
            city
            street
          }
        }
        
        client {
          id
          firstName
          lastName
          companyName
        }
        
        lineItems(first: 10) {
          nodes {
            name
            description
          }
        }
      }
      
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// =============================================================================
// API METHODS
// =============================================================================

/**
 * Fetch a job by its ID
 * 
 * @param {string} accessToken - OAuth access token
 * @param {string} jobId - Jobber job ID (encoded)
 * @returns {Promise<object>} - Job data
 */
export async function getJob(accessToken, jobId) {
  console.log(`Fetching job: ${jobId}`);
  
  const data = await executeQuery(accessToken, GET_JOB_QUERY, { id: jobId });
  
  if (!data.job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  
  return normalizeJobData(data.job);
}

/**
 * Fetch a visit by its ID
 * 
 * @param {string} accessToken - OAuth access token
 * @param {string} visitId - Jobber visit ID (encoded)
 * @returns {Promise<object>} - Visit data with associated job
 */
export async function getVisit(accessToken, visitId) {
  console.log(`Fetching visit: ${visitId}`);
  
  const data = await executeQuery(accessToken, GET_VISIT_QUERY, { id: visitId });
  
  if (!data.visit) {
    throw new Error(`Visit not found: ${visitId}`);
  }
  
  return normalizeVisitData(data.visit);
}

/**
 * Fetch recent completed jobs
 * 
 * @param {string} accessToken - OAuth access token
 * @param {number} count - Number of jobs to fetch (max 50)
 * @returns {Promise<array>} - Array of job data
 */
export async function getRecentCompletedJobs(accessToken, count = 10) {
  console.log(`Fetching ${count} recent completed jobs`);
  
  const data = await executeQuery(accessToken, GET_RECENT_COMPLETED_JOBS_QUERY, { 
    first: Math.min(count, 50) 
  });
  
  if (!data.jobs || !data.jobs.nodes) {
    return [];
  }
  
  return data.jobs.nodes.map(job => normalizeJobData(job));
}

// =============================================================================
// DATA NORMALIZATION
// =============================================================================

/**
 * Normalize job data into a consistent format
 * Privacy-conscious: only includes city, not full street address
 */
function normalizeJobData(job) {
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    title: job.title,
    status: job.jobStatus,
    type: job.jobType,
    instructions: job.instructions,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    startAt: job.startAt,
    endAt: job.endAt,
    
    // Client info (privacy-conscious)
    client: job.client ? {
      id: job.client.id,
      firstName: job.client.firstName,
      lastName: job.client.lastName,
      companyName: job.client.companyName,
      // For content: use "a homeowner in [city]" or company name
      displayName: job.client.companyName || 
        `${job.client.firstName || ''} ${job.client.lastName || ''}`.trim() ||
        'Customer',
    } : null,
    
    // Property location (privacy-conscious - city only for public content)
    location: job.property?.address ? {
      city: job.property.address.city,
      // Include street for internal use, but don't expose in public content
      street: job.property.address.street,
      province: job.property.address.province,
      postalCode: job.property.address.postalCode,
      // For public content: "[City], AL"
      publicDisplay: job.property.address.city 
        ? `${job.property.address.city}, ${job.property.address.province || 'AL'}`
        : 'North Alabama',
    } : null,
    
    // Services performed
    lineItems: job.lineItems?.nodes?.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
    })) || [],
    
    // Get service names as a simple list
    services: job.lineItems?.nodes?.map(item => item.name).filter(Boolean) || [],
    
    // Notes from technician/Adam
    notes: job.notes?.nodes?.map(note => ({
      id: note.id,
      message: note.message,
      createdAt: note.createdAt,
    })) || [],
    
    // Photo attachments
    photos: job.noteAttachments?.nodes?.filter(att => 
      att.contentType?.startsWith('image/')
    ).map(photo => ({
      id: photo.id,
      fileName: photo.fileName,
      url: photo.fileUrl,
      contentType: photo.contentType,
      createdAt: photo.createdAt,
    })) || [],
    
    // All attachments (including non-photos)
    attachments: job.noteAttachments?.nodes?.map(att => ({
      id: att.id,
      fileName: att.fileName,
      url: att.fileUrl,
      contentType: att.contentType,
      createdAt: att.createdAt,
    })) || [],
  };
}

/**
 * Normalize visit data
 */
function normalizeVisitData(visit) {
  return {
    id: visit.id,
    title: visit.title,
    isComplete: visit.isComplete,
    duration: visit.duration,
    status: visit.visitStatus,
    instructions: visit.instructions,
    
    // Property location
    location: visit.property?.address ? {
      city: visit.property.address.city,
      street: visit.property.address.street,
      province: visit.property.address.province,
      postalCode: visit.property.address.postalCode,
      publicDisplay: visit.property.address.city 
        ? `${visit.property.address.city}, ${visit.property.address.province || 'AL'}`
        : 'North Alabama',
    } : null,
    
    // Visit-specific line items
    visitLineItems: visit.lineItems?.nodes?.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
    })) || [],
    
    // Associated job (full details)
    job: visit.job ? normalizeJobData(visit.job) : null,
  };
}

// =============================================================================
// CONTENT GENERATION HELPERS
// =============================================================================

/**
 * Extract content-ready data from a completed job
 * This is the data structure passed to content generation
 */
export function extractContentData(jobData) {
  return {
    // Location for SEO targeting
    city: jobData.location?.city || null,
    region: jobData.location?.publicDisplay || 'North Alabama',
    
    // Services performed (for service page linking)
    services: jobData.services,
    primaryService: jobData.services[0] || 'Gutter Service',
    
    // Content hooks
    customerType: jobData.client?.companyName ? 'commercial' : 'residential',
    hasPhotos: jobData.photos.length > 0,
    photoCount: jobData.photos.length,
    photoUrls: jobData.photos.map(p => p.url),
    
    // Notes that might contain useful content
    technicianNotes: jobData.notes.map(n => n.message).join('\n'),
    
    // Timing
    completedAt: jobData.completedAt,
    
    // For review request personalization
    customerFirstName: jobData.client?.firstName || null,
    customerDisplayName: jobData.client?.displayName || 'valued customer',
    
    // Raw data for advanced processing
    raw: jobData,
  };
}

/**
 * Determine which content types can be generated from this job
 */
export function determineContentOpportunities(contentData) {
  const opportunities = [];
  
  // Always eligible for review request
  opportunities.push({
    type: 'review_request',
    priority: 'high',
    reason: 'Job completed',
  });
  
  // If photos present, eligible for case study
  if (contentData.hasPhotos && contentData.photoCount >= 2) {
    opportunities.push({
      type: 'case_study',
      priority: 'medium',
      reason: `${contentData.photoCount} photos available`,
    });
  }
  
  // If in a target city, eligible for city page content
  if (contentData.city) {
    opportunities.push({
      type: 'city_content',
      priority: 'low',
      reason: `Completed job in ${contentData.city}`,
    });
  }
  
  // If technician notes are substantial, might have blog content
  if (contentData.technicianNotes && contentData.technicianNotes.length > 100) {
    opportunities.push({
      type: 'blog_material',
      priority: 'low',
      reason: 'Detailed technician notes',
    });
  }
  
  return opportunities;
}
