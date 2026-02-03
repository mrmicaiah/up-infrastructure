/**
 * Content Engine Orchestrator
 * 
 * Main pipeline that connects all modules together.
 * Triggered when a Jobber webhook fires for visit_completed.
 * 
 * Pipeline Steps:
 * 1. Fetch job data from Jobber API
 * 2. Process photos through Cloudinary
 * 3. Generate project page content
 * 4. Commit to GitHub (bluerivergutters repo)
 * 5. Post to Google Business Profile
 * 6. Email social drafts to Adam
 * 
 * Each step is independent - if one fails, others still run.
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { getVisit, getJob, extractContentData, determineContentOpportunities } from './jobber-api.js';
import { processJobPhotos } from './photo-pipeline.js';
import { generateProject, getServicePageUrl, getCityPageUrl } from './project-generator.js';
import { generateAndSendSocialDrafts } from './social-generator.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // GitHub config
  github: {
    owner: 'mrmicaiah',
    repo: 'bluerivergutters',
    branch: 'main',
    projectsDataPath: 'src/_data/projects.json',
  },
  
  // Feature flags - disable individual pipeline steps
  features: {
    processPhotos: true,
    generateProject: true,
    commitToGithub: true,
    postToGMB: true,
    emailSocialDrafts: true,
  },
  
  // Minimum requirements for content generation
  requirements: {
    minPhotos: 1, // Need at least 1 photo for project page
  },
};

// =============================================================================
// PIPELINE RESULT TRACKING
// =============================================================================

/**
 * Create a pipeline result tracker
 */
function createPipelineResult(jobId) {
  return {
    jobId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    success: false,
    steps: {
      fetchJob: { status: 'pending', error: null, data: null },
      processPhotos: { status: 'pending', error: null, data: null },
      generateProject: { status: 'pending', error: null, data: null },
      commitToGithub: { status: 'pending', error: null, data: null },
      postToGMB: { status: 'pending', error: null, data: null },
      emailSocialDrafts: { status: 'pending', error: null, data: null },
    },
    summary: null,
  };
}

/**
 * Mark a step as complete
 */
function markStepComplete(result, stepName, data = null) {
  result.steps[stepName] = {
    status: 'complete',
    error: null,
    data,
    completedAt: new Date().toISOString(),
  };
  console.log(`✅ Step complete: ${stepName}`);
}

/**
 * Mark a step as failed
 */
function markStepFailed(result, stepName, error) {
  result.steps[stepName] = {
    status: 'failed',
    error: error.message || String(error),
    data: null,
    failedAt: new Date().toISOString(),
  };
  console.error(`❌ Step failed: ${stepName} - ${error.message || error}`);
}

/**
 * Mark a step as skipped
 */
function markStepSkipped(result, stepName, reason) {
  result.steps[stepName] = {
    status: 'skipped',
    error: null,
    data: { reason },
    skippedAt: new Date().toISOString(),
  };
  console.log(`⏭️ Step skipped: ${stepName} - ${reason}`);
}

// =============================================================================
// GITHUB INTEGRATION
// =============================================================================

/**
 * Commit project to GitHub
 * Adds new project to projects.json data file
 * 
 * @param {object} project - Generated project object
 * @param {object} env - Worker environment with GITHUB_TOKEN
 * @returns {Promise<object>} - Commit result
 */
async function commitProjectToGithub(project, env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not configured');
  }
  
  const { owner, repo, branch, projectsDataPath } = CONFIG.github;
  const apiBase = 'https://api.github.com';
  
  // Step 1: Get current projects.json
  console.log('Fetching current projects.json...');
  const getResponse = await fetch(
    `${apiBase}/repos/${owner}/${repo}/contents/${projectsDataPath}?ref=${branch}`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'BRG-Content-Engine',
      },
    }
  );
  
  if (!getResponse.ok) {
    const errorText = await getResponse.text();
    throw new Error(`Failed to fetch projects.json: ${getResponse.status} - ${errorText}`);
  }
  
  const fileData = await getResponse.json();
  const currentContent = atob(fileData.content);
  const currentProjects = JSON.parse(currentContent);
  
  // Step 2: Check if project already exists (by slug)
  const existingIndex = currentProjects.findIndex(p => p.slug === project.slug);
  if (existingIndex !== -1) {
    console.log(`Project ${project.slug} already exists, updating...`);
    currentProjects[existingIndex] = project;
  } else {
    console.log(`Adding new project: ${project.slug}`);
    // Add to beginning of array (newest first)
    currentProjects.unshift(project);
  }
  
  // Step 3: Commit updated file
  const newContent = JSON.stringify(currentProjects, null, 2);
  const encodedContent = btoa(unescape(encodeURIComponent(newContent)));
  
  const commitResponse = await fetch(
    `${apiBase}/repos/${owner}/${repo}/contents/${projectsDataPath}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'BRG-Content-Engine',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Add project: ${project.title}`,
        content: encodedContent,
        sha: fileData.sha,
        branch: branch,
      }),
    }
  );
  
  if (!commitResponse.ok) {
    const errorText = await commitResponse.text();
    throw new Error(`Failed to commit: ${commitResponse.status} - ${errorText}`);
  }
  
  const commitResult = await commitResponse.json();
  
  return {
    commitSha: commitResult.commit.sha,
    commitUrl: commitResult.commit.html_url,
    projectSlug: project.slug,
  };
}

// =============================================================================
// GMB INTEGRATION (INLINE - gmb-post-generator may not exist)
// =============================================================================

/**
 * Generate a simple GMB post
 */
function generateGMBPost(contentData, project) {
  const city = contentData.city || 'North Alabama';
  const service = project.service;
  
  return {
    summary: `Just completed a ${service.toLowerCase()} project in ${city}! Another satisfied customer. Call (256) 616-6760 for a free estimate.`,
    callToAction: {
      actionType: 'CALL',
      url: 'tel:+12566166760',
    },
    mediaItems: project.images?.slice(0, 1).map(url => ({
      mediaFormat: 'PHOTO',
      sourceUrl: url,
    })) || [],
  };
}

/**
 * Post to Google Business Profile
 */
async function postToGMB(post, env) {
  // Import google-gbp module dynamically
  try {
    const { createPost, getGoogleAccessToken } = await import('./google-gbp.js');
    const googleToken = await getGoogleAccessToken(env);
    const result = await createPost(googleToken, env.BRG_LOCATION_ID, post);
    return { postId: result.name || 'unknown', success: true };
  } catch (error) {
    console.error('GMB post failed:', error.message);
    throw error;
  }
}

// =============================================================================
// MAIN ORCHESTRATOR
// =============================================================================

/**
 * Run the complete content pipeline
 * 
 * @param {string} visitId - Jobber visit ID (optional)
 * @param {string} jobId - Jobber job ID (optional, used if visitId not provided)
 * @param {string} accessToken - Jobber OAuth access token
 * @param {object} env - Worker environment
 * @returns {Promise<object>} - Pipeline result
 */
export async function runContentPipeline(visitId, jobId, accessToken, env) {
  const result = createPipelineResult(jobId || visitId);
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BLUE RIVER GUTTERS CONTENT ENGINE');
  console.log('  Pipeline Started:', result.startedAt);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  
  let jobData = null;
  let contentData = null;
  let project = null;
  
  // =========================================================================
  // STEP 1: FETCH JOB DATA
  // =========================================================================
  console.log('📋 STEP 1: Fetching job data from Jobber...');
  try {
    if (visitId) {
      const visitData = await getVisit(accessToken, visitId);
      jobData = visitData.job;
    } else if (jobId) {
      jobData = await getJob(accessToken, jobId);
    } else {
      throw new Error('No visit or job ID provided');
    }
    
    if (!jobData) {
      throw new Error('No job data retrieved');
    }
    
    contentData = extractContentData(jobData);
    const opportunities = determineContentOpportunities(contentData);
    
    markStepComplete(result, 'fetchJob', {
      jobNumber: jobData.jobNumber,
      city: contentData.city,
      service: contentData.primaryService,
      photoCount: contentData.photoCount,
      opportunities: opportunities.length,
    });
    
    console.log(`   Job #${jobData.jobNumber} in ${contentData.city}`);
    console.log(`   Service: ${contentData.primaryService}`);
    console.log(`   Photos: ${contentData.photoCount}`);
    
  } catch (error) {
    markStepFailed(result, 'fetchJob', error);
    // Can't continue without job data
    result.completedAt = new Date().toISOString();
    result.summary = 'Pipeline failed: Could not fetch job data';
    return result;
  }
  
  // =========================================================================
  // STEP 2: PROCESS PHOTOS
  // =========================================================================
  console.log('');
  console.log('📸 STEP 2: Processing photos through Cloudinary...');
  
  if (!CONFIG.features.processPhotos) {
    markStepSkipped(result, 'processPhotos', 'Feature disabled');
  } else if (!contentData.hasPhotos) {
    markStepSkipped(result, 'processPhotos', 'No photos in job');
  } else {
    try {
      const processedPhotos = await processJobPhotos(accessToken, jobData, env);
      const successfulPhotos = processedPhotos.filter(p => p.processed);
      
      // Attach processed photos to contentData for downstream use
      contentData.processedPhotos = processedPhotos;
      
      markStepComplete(result, 'processPhotos', {
        total: processedPhotos.length,
        successful: successfulPhotos.length,
        failed: processedPhotos.length - successfulPhotos.length,
      });
      
      console.log(`   Processed ${successfulPhotos.length}/${processedPhotos.length} photos`);
      
    } catch (error) {
      markStepFailed(result, 'processPhotos', error);
      // Continue without photos
    }
  }
  
  // =========================================================================
  // STEP 3: GENERATE PROJECT PAGE
  // =========================================================================
  console.log('');
  console.log('📄 STEP 3: Generating project page content...');
  
  if (!CONFIG.features.generateProject) {
    markStepSkipped(result, 'generateProject', 'Feature disabled');
  } else {
    try {
      // Check if we meet minimum requirements
      const hasEnoughPhotos = (contentData.processedPhotos?.filter(p => p.processed)?.length || 0) >= CONFIG.requirements.minPhotos;
      
      if (!hasEnoughPhotos && CONFIG.requirements.minPhotos > 0) {
        markStepSkipped(result, 'generateProject', `Need at least ${CONFIG.requirements.minPhotos} photo(s)`);
      } else {
        project = generateProject(contentData, {
          includeSchema: true,
          featured: false,
        });
        
        markStepComplete(result, 'generateProject', {
          slug: project.slug,
          title: project.title,
          service: project.service,
          hasSpecs: !!project.specs,
          imageCount: project.images?.length || 0,
        });
        
        console.log(`   Generated: ${project.title}`);
        console.log(`   Slug: ${project.slug}`);
      }
      
    } catch (error) {
      markStepFailed(result, 'generateProject', error);
    }
  }
  
  // =========================================================================
  // STEP 4: COMMIT TO GITHUB
  // =========================================================================
  console.log('');
  console.log('📤 STEP 4: Committing to GitHub...');
  
  if (!CONFIG.features.commitToGithub) {
    markStepSkipped(result, 'commitToGithub', 'Feature disabled');
  } else if (!project) {
    markStepSkipped(result, 'commitToGithub', 'No project generated');
  } else if (!env.GITHUB_TOKEN) {
    markStepSkipped(result, 'commitToGithub', 'GITHUB_TOKEN not configured');
  } else {
    try {
      // Remove schema from project before committing (it's for page rendering, not data file)
      const projectForGithub = { ...project };
      delete projectForGithub.schema;
      
      const commitResult = await commitProjectToGithub(projectForGithub, env);
      
      markStepComplete(result, 'commitToGithub', commitResult);
      
      console.log(`   Committed: ${commitResult.commitSha.substring(0, 7)}`);
      console.log(`   URL: ${commitResult.commitUrl}`);
      
    } catch (error) {
      markStepFailed(result, 'commitToGithub', error);
    }
  }
  
  // =========================================================================
  // STEP 5: POST TO GOOGLE BUSINESS PROFILE
  // =========================================================================
  console.log('');
  console.log('📍 STEP 5: Posting to Google Business Profile...');
  
  if (!CONFIG.features.postToGMB) {
    markStepSkipped(result, 'postToGMB', 'Feature disabled');
  } else if (!project) {
    markStepSkipped(result, 'postToGMB', 'No project generated');
  } else if (!env.BRG_LOCATION_ID) {
    markStepSkipped(result, 'postToGMB', 'BRG_LOCATION_ID not configured');
  } else {
    try {
      // Generate and post to GMB
      const gmbPost = generateGMBPost(contentData, project);
      const gmbResult = await postToGMB(gmbPost, env);
      
      markStepComplete(result, 'postToGMB', {
        postId: gmbResult.postId,
        summary: gmbPost.summary.substring(0, 50) + '...',
      });
      
      console.log(`   Posted! ID: ${gmbResult.postId}`);
      
    } catch (error) {
      markStepFailed(result, 'postToGMB', error);
    }
  }
  
  // =========================================================================
  // STEP 6: EMAIL SOCIAL DRAFTS
  // =========================================================================
  console.log('');
  console.log('📧 STEP 6: Emailing social media drafts...');
  
  if (!CONFIG.features.emailSocialDrafts) {
    markStepSkipped(result, 'emailSocialDrafts', 'Feature disabled');
  } else if (!project) {
    markStepSkipped(result, 'emailSocialDrafts', 'No project generated');
  } else {
    try {
      const socialResult = await generateAndSendSocialDrafts(contentData, project, env);
      
      if (socialResult.emailSent) {
        markStepComplete(result, 'emailSocialDrafts', {
          messageId: socialResult.messageId,
          facebookCaptionLength: socialResult.facebookCaption.length,
          instagramCaptionLength: socialResult.instagramCaption.length,
        });
        console.log(`   Email sent! Message ID: ${socialResult.messageId}`);
      } else {
        markStepFailed(result, 'emailSocialDrafts', new Error(socialResult.emailError));
      }
      
    } catch (error) {
      markStepFailed(result, 'emailSocialDrafts', error);
    }
  }
  
  // =========================================================================
  // PIPELINE COMPLETE
  // =========================================================================
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  
  result.completedAt = new Date().toISOString();
  
  // Calculate success
  const completedSteps = Object.values(result.steps).filter(s => s.status === 'complete').length;
  const failedSteps = Object.values(result.steps).filter(s => s.status === 'failed').length;
  const skippedSteps = Object.values(result.steps).filter(s => s.status === 'skipped').length;
  
  result.success = failedSteps === 0 || (completedSteps > 0 && failedSteps < completedSteps);
  result.summary = `Pipeline ${result.success ? 'completed' : 'failed'}: ${completedSteps} complete, ${failedSteps} failed, ${skippedSteps} skipped`;
  
  console.log(`  ${result.success ? '✅' : '❌'} ${result.summary}`);
  console.log('  Duration:', calculateDuration(result.startedAt, result.completedAt));
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  
  return result;
}

/**
 * Calculate human-readable duration
 */
function calculateDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  runContentPipeline,
  CONFIG,
};
