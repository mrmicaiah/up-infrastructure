// Helm Task Tools - Index
// Combines all task-related tools into one registration function

import type { ToolContext } from '../../../types';
import { registerTaskCrudTools } from './crud';
import { registerTaskWorkflowTools } from './workflow';
import { registerTaskRecurringTools } from './recurring';
import { registerTaskReportingTools } from './reporting';

export function registerHelmTaskTools(ctx: ToolContext) {
  registerTaskCrudTools(ctx);
  registerTaskWorkflowTools(ctx);
  registerTaskRecurringTools(ctx);
  registerTaskReportingTools(ctx);
}

export {
  registerTaskCrudTools,
  registerTaskWorkflowTools,
  registerTaskRecurringTools,
  registerTaskReportingTools,
};
