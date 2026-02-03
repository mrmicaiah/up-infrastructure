/**
 * GitHub Integration Module
 * 
 * Commits generated project pages to the bluerivergutters repo.
 * Cloudflare Pages auto-deploys on new commits.
 */

const GITHUB_API_URL = 'https://api.github.com';
const REPO_OWNER = 'mrmicaiah';
const REPO_NAME = 'bluerivergutters';
const PROJECTS_FILE_PATH = 'src/_data/projects.json';
const BRANCH = 'main';

/**
 * Add a new project to the website and trigger deploy
 */
export async function addProjectToSite(env, projectData) {
  const token = await getGitHubToken(env);
  console.log(`[GitHub] Adding project: ${projectData.slug}`);
  
  try {
    const currentFile = await getFileContent(token, PROJECTS_FILE_PATH);
    const projects = JSON.parse(currentFile.content);
    
    const existingIndex = projects.findIndex(p => 
      p.slug === projectData.slug || p.jobNumber === projectData.jobNumber
    );
    
    if (existingIndex >= 0) {
      console.log(`[GitHub] Updating existing project`);
      projects[existingIndex] = cleanProjectData(projectData);
    } else {
      console.log(`[GitHub] Adding new project`);
      projects.unshift(cleanProjectData(projectData));
    }
    
    const commitMessage = existingIndex >= 0 
      ? `Update project: ${projectData.title}`
      : `Add project: ${projectData.title}`;
    
    const result = await commitFile(token, PROJECTS_FILE_PATH, JSON.stringify(projects, null, 2), commitMessage, currentFile.sha);
    
    return {
      success: true,
      action: existingIndex >= 0 ? 'updated' : 'created',
      commitSha: result.commit.sha,
      commitUrl: result.commit.html_url,
      projectSlug: projectData.slug,
      projectUrl: `https://bluerivergutters.com/projects/${projectData.slug}/`,
    };
  } catch (error) {
    console.error(`[GitHub] Failed: ${error.message}`);
    return { success: false, error: error.message, projectSlug: projectData.slug };
  }
}

/**
 * Batch add multiple projects
 */
export async function addProjectsBatch(env, projectsData) {
  const token = await getGitHubToken(env);
  console.log(`[GitHub] Batch adding ${projectsData.length} projects`);
  
  try {
    const currentFile = await getFileContent(token, PROJECTS_FILE_PATH);
    const projects = JSON.parse(currentFile.content);
    
    let added = 0, updated = 0;
    
    for (const projectData of projectsData) {
      const existingIndex = projects.findIndex(p => 
        p.slug === projectData.slug || p.jobNumber === projectData.jobNumber
      );
      
      if (existingIndex >= 0) {
        projects[existingIndex] = cleanProjectData(projectData);
        updated++;
      } else {
        projects.unshift(cleanProjectData(projectData));
        added++;
      }
    }
    
    const result = await commitFile(token, PROJECTS_FILE_PATH, JSON.stringify(projects, null, 2), `Add ${added} projects, update ${updated} projects`, currentFile.sha);
    
    return { success: true, added, updated, commitSha: result.commit.sha, commitUrl: result.commit.html_url };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get current projects list
 */
export async function getCurrentProjects(env) {
  const token = await getGitHubToken(env);
  const file = await getFileContent(token, PROJECTS_FILE_PATH);
  return JSON.parse(file.content);
}

/**
 * Delete a project by slug
 */
export async function deleteProject(env, slug) {
  const token = await getGitHubToken(env);
  const currentFile = await getFileContent(token, PROJECTS_FILE_PATH);
  const projects = JSON.parse(currentFile.content);
  
  const index = projects.findIndex(p => p.slug === slug);
  if (index < 0) return { success: false, error: 'Project not found' };
  
  projects.splice(index, 1);
  const result = await commitFile(token, PROJECTS_FILE_PATH, JSON.stringify(projects, null, 2), `Remove project: ${slug}`, currentFile.sha);
  
  return { success: true, commitSha: result.commit.sha };
}

function cleanProjectData(project) {
  const { schema, relatedLinks, _meta, ...cleanData } = project;
  return {
    title: cleanData.title,
    slug: cleanData.slug,
    date: cleanData.date,
    city: cleanData.city,
    service: cleanData.service,
    thumbnail: cleanData.thumbnail,
    images: cleanData.images || [],
    description: cleanData.description,
    details: cleanData.details,
    specs: cleanData.specs || {},
    featured: cleanData.featured || false,
    jobNumber: cleanData.jobNumber,
  };
}

async function getGitHubToken(env) {
  if (env.TOKENS) {
    const token = await env.TOKENS.get('github:token');
    if (token) return token;
  }
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  throw new Error('GitHub token not configured');
}

async function getFileContent(token, path) {
  const url = `${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'BRG-Content-Engine',
    },
  });
  if (!response.ok) throw new Error(`Failed to get file: ${response.status}`);
  const data = await response.json();
  return { sha: data.sha, content: atob(data.content.replace(/\n/g, '')) };
}

async function commitFile(token, path, content, message, sha) {
  const url = `${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'BRG-Content-Engine',
    },
    body: JSON.stringify({ message, content: btoa(content), sha, branch: BRANCH }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Commit failed: ${response.status}`);
  }
  return await response.json();
}

export async function triggerDeploy(env) {
  console.log('[GitHub] Deploy triggered automatically on commit');
  return { success: true, message: 'Auto-deploy triggered by commit' };
}

export async function checkGitHubStatus(env) {
  try {
    const token = await getGitHubToken(env);
    const response = await fetch(`${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'BRG-Content-Engine',
      },
    });
    if (!response.ok) return { connected: false, error: `API error: ${response.status}` };
    const repo = await response.json();
    return { connected: true, repo: repo.full_name, defaultBranch: repo.default_branch };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}
