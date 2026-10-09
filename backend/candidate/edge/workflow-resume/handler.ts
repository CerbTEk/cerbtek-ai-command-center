import { createWorkflowHandler } from "../_shared/approved-workflow.ts";
export const createHandler = (dependencies: Parameters<typeof createWorkflowHandler>[1]) => createWorkflowHandler("resume", dependencies);
