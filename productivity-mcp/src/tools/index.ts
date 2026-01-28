/**
 * Tool Registration Index
 * 
 * This file imports and registers all MCP tools.
 * Tools are organized into categories for easier maintenance.
 * 
 * CATEGORIES:
 * - helm/        → Personal productivity (tasks, sprints, workday)
 * - team/        → Team collaboration
 * - tracking/    → Work tracking (checkins, journal)
 * - launch/      → Project launches
 * - content/     → Publishing (blog, authors)
 * - integrations/→ External services (drive, github, etc.)
 * - system/      → System tools (notes, skills, connections)
 */

import type { ToolContext } from '../types';

// === HELM (Personal Productivity) ===
import { registerHelmTools } from './helm';

// === LEGACY (to be reorganized) ===
// These will move to helm/ subdirectories
import { registerSprintTools } from './sprints';
import { registerBethanyTools } from './bethany';

// === TEAM ===
import { registerTeamTools } from './team';
import { registerHandoffTools } from './handoff';

// === TRACKING ===
import { registerCheckinsTools } from './checkins';
import { registerJournalTools } from './journal';

// === LAUNCH ===
import { registerLaunchTools } from './launch';

// === CONTENT ===
import { registerBlogTools } from './blog';
import { registerAuthorsTools } from './authors';
import { registerBloggerTools } from './blogger';

// === INTEGRATIONS ===
import { registerConnectionTools } from './connections';
import { registerDriveTools } from './drive';
import { registerEmailTools } from './email';
import { registerContactsTools } from './contacts';
import { registerGitHubTools } from './github';
import { registerCloudinaryTools } from './cloudinary';
import { registerAnalyticsTools } from './analytics';

// === SYSTEM ===
import { registerNotesTools } from './notes';
import { registerSkillsTools } from './skills';

export function registerAllTools(ctx: ToolContext) {
  // Helm (replaces old tasks.ts)
  registerHelmTools(ctx);
  
  // Legacy helm tools (TODO: move to helm/)
  registerSprintTools(ctx);
  registerBethanyTools(ctx);
  
  // Team
  registerTeamTools(ctx);
  registerHandoffTools(ctx);
  
  // Tracking
  registerCheckinsTools(ctx);
  registerJournalTools(ctx);
  
  // Launch
  registerLaunchTools(ctx);
  
  // Content
  registerBlogTools(ctx);
  registerAuthorsTools(ctx);
  registerBloggerTools(ctx);
  
  // Integrations
  registerConnectionTools(ctx);
  registerDriveTools(ctx);
  registerEmailTools(ctx);
  registerContactsTools(ctx);
  registerGitHubTools(ctx);
  registerCloudinaryTools(ctx);
  registerAnalyticsTools(ctx);
  
  // System
  registerNotesTools(ctx);
  registerSkillsTools(ctx);
}

// Re-export for selective use
export {
  registerHelmTools,
  registerSprintTools,
  registerBethanyTools,
  registerTeamTools,
  registerHandoffTools,
  registerCheckinsTools,
  registerJournalTools,
  registerLaunchTools,
  registerBlogTools,
  registerAuthorsTools,
  registerBloggerTools,
  registerConnectionTools,
  registerDriveTools,
  registerEmailTools,
  registerContactsTools,
  registerGitHubTools,
  registerCloudinaryTools,
  registerAnalyticsTools,
  registerNotesTools,
  registerSkillsTools,
};
