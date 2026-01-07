import { ToolContext } from '../types';
import { registerTaskTools } from './tasks';
import { registerTeamTools } from './team';
import { registerNotesTools } from './notes';
import { registerConnectionTools } from './connections';
import { registerDriveTools } from './drive';
import { registerEmailTools } from './email';
import { registerContactsTools } from './contacts';
import { registerBloggerTools } from './blogger';
import { registerLaunchTools } from './launch';
import { registerBethanyTools } from './bethany';
import { registerJournalTools } from './journal';
import { registerGitHubTools } from './github';
import { registerSkillsTools } from './skills';
import { registerSprintTools } from './sprints';
import { registerCourierTools } from './courier';
import { registerBlogTools } from './blog';

export function registerAllTools(ctx: ToolContext) {
  registerTaskTools(ctx);
  registerTeamTools(ctx);
  registerNotesTools(ctx);
  registerConnectionTools(ctx);
  registerDriveTools(ctx);
  registerEmailTools(ctx);
  registerContactsTools(ctx);
  registerBloggerTools(ctx);
  registerLaunchTools(ctx);
  registerBethanyTools(ctx);
  registerJournalTools(ctx);
  registerGitHubTools(ctx);
  registerSkillsTools(ctx);
  registerSprintTools(ctx);
  registerCourierTools(ctx);
  registerBlogTools(ctx);
}

// Re-export individual registrations for selective use
export {
  registerTaskTools,
  registerTeamTools,
  registerNotesTools,
  registerConnectionTools,
  registerDriveTools,
  registerEmailTools,
  registerContactsTools,
  registerBloggerTools,
  registerLaunchTools,
  registerBethanyTools,
  registerJournalTools,
  registerGitHubTools,
  registerSkillsTools,
  registerSprintTools,
  registerCourierTools,
  registerBlogTools,
};
