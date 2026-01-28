// Helm - Personal Productivity Tools
// Main index that combines all Helm subsystems

import type { ToolContext } from '../../types';
import { registerHelmTaskTools } from './tasks';
// Future: import { registerHelmSprintTools } from './sprints';
// Future: import { registerHelmWorkdayTools } from './workday';

export function registerHelmTools(ctx: ToolContext) {
  // Task management (list, add, complete, etc.)
  registerHelmTaskTools(ctx);
  
  // TODO: Move these from root tools/ to helm/
  // - sprints.ts → helm/sprints/
  // - bethany.ts → helm/workday/
}

export { registerHelmTaskTools };
