import { assertRunLineage, authenticate, bestEffort, BoundaryError, connectionFor, cors, emailPayload, fields, object, respond } from "./approved-runtime.ts";

type Dependencies = { supabase: any; supabaseUrl: string; fetchImpl?: typeof fetch; now?: () => number };
const actions: Record<string, string> = { "microsoft.health": "health", "microsoft.profile": "profile", "microsoft.inbox-status": "inbox-status", "microsoft.calendar-next": "calendar-next" };
const reserved = new Set(["outputs", "action_request_id", "workflow_run_id", "workflow_id", "run_id", "approved_by", "approved_at", "requested_by", "initiated_by"]);
export function manualContext(context: any) {
  if (!object(context)) throw new BoundaryError("Manual workflow context must be an object");
  const visit = (value: any, depth: number) => {
    if (depth > 20) throw new BoundaryError("Workflow context is too deeply nested");
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (reserved.has(key) || /^agent/i.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) throw new BoundaryError("Reserved workflow context or agent lineage is not permitted");
      visit(child, depth + 1);
    }
  };
  visit(context, 0);
  return context;
}
function resolveValue(value: string, context: any): string {
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_: string, path: string) => {
    let current: any = context;
    for (const key of path.split(".")) {
      if (!object(current) || !Object.hasOwn(current, key) || ["__proto__", "constructor", "prototype"].includes(key)) return "";
      current = current[key];
    }
    return ["string", "number", "boolean"].includes(typeof current) ? String(current) : "";
  });
}
function stepsFrom(run: any) {
  if (!run?.id || run.status !== "Running" || !run.organization_id || !run.initiated_by || !run.workflow_revision || !Array.isArray(run.workflow_steps) || run.workflow_steps.length > 100) throw new BoundaryError("Trusted workflow snapshot required", 409);
  manualContext(run.workflow_context);
  for (const step of run.workflow_steps) {
    if (!object(step)) throw new BoundaryError("Invalid workflow step", 409);
    if (Object.hasOwn(actions, step.type)) fields(step, ["type"]);
    else if (step.type === "approval.email") {
      fields(step, ["type", "to", "subject", "message"]);
      if (![step.to, step.subject, step.message].every(v => typeof v === "string")) throw new BoundaryError("Invalid email step", 409);
      emailPayload({ to: resolveValue(step.to, run.workflow_context), subject: resolveValue(step.subject, run.workflow_context), message: resolveValue(step.message, run.workflow_context) });
    } else if (step.type === "note") {
      fields(step, ["type", "text"]);
      if (typeof step.text !== "string" || step.text.length > 100000) throw new BoundaryError("Invalid note step", 409);
    } else throw new BoundaryError("Unsupported workflow operation", 409);
  }
  return run.workflow_steps;
}
async function updateRun(supabase: any, run: any, updates: any) {
  const { data, error } = await supabase.from("workflow_runs").update(updates).eq("id", run.id).eq("organization_id", run.organization_id).eq("status", "Running").select("*").single();
  if (error || !data || data.id !== run.id || (updates.status && data.status !== updates.status)) throw new BoundaryError("Workflow progress could not be saved", 503);
  return data;
}
export function createWorkflowHandler(mode: "start" | "resume", { supabase, supabaseUrl, fetchImpl = fetch, now = Date.now }: Dependencies) {
  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    let run: any = null;
    try {
      const { userId, jwt } = await authenticate(req, supabase);
      let body: any;
      try { body = await req.json(); } catch { throw new BoundaryError("Invalid JSON"); }
      fields(body, mode === "start" ? ["workflow_id", "context"] : ["run_id"]);
      if (mode === "start") {
        if (typeof body.workflow_id !== "string" || !body.workflow_id) throw new BoundaryError("workflow_id required");
        const context = manualContext(body.context ?? {});
        const { data, error } = await supabase.rpc("create_trusted_workflow_run", { p_workflow_id: body.workflow_id, p_actor_id: userId, p_context: context });
        if (error || !data || data.workflow_id !== body.workflow_id || data.initiated_by !== userId) throw new BoundaryError("Manual workflow cannot be started", 409);
        run = data;
      } else {
        if (typeof body.run_id !== "string" || !body.run_id) throw new BoundaryError("run_id required");
        const { data, error } = await supabase.rpc("claim_workflow_continuation", { p_run_id: body.run_id, p_actor_id: userId });
        if (error || !data || data.id !== body.run_id) throw new BoundaryError("Workflow cannot continue until the exact approved action is complete", 409);
        run = data;
      }
      const start = mode === "start" ? 0 : run.current_step + 1;
      if (mode === "resume" && run.workflow_steps?.[run.current_step]?.type !== "approval.email") throw new BoundaryError("Invalid workflow continuation", 409);
      return await executeTrustedWorkflow({ run, userId, jwt, supabase, supabaseUrl, fetchImpl, now }, start);
    } catch (error) {
      if (run) await bestEffort(() => supabase.from("workflow_runs").update({ status: "Error", completed_at: new Date(now()).toISOString(), error_message: "Workflow requires review", summary: "Workflow execution stopped safely" }).eq("id", run.id).eq("status", "Running"));
      return respond({ ok: false, error: error instanceof BoundaryError ? error.message : "Workflow service unavailable", ...(run ? { run_id: run.id } : {}) }, error instanceof BoundaryError ? error.status : 503);
    }
  };
}

// Server-internal entry point for an atomically reserved, human-approved agent run.
// This is never selected by a public request body. All lineage is asserted in SQL.
export async function executeTrustedWorkflow({ run, userId, jwt, supabase, supabaseUrl, fetchImpl = fetch, now = Date.now }: Dependencies & { run: any; userId: string; jwt: string }, start = 0): Promise<Response> {
      const steps = stepsFrom(run);
      await assertRunLineage(supabase, run, userId);
      if (!Number.isInteger(start) || start < 0 || start > steps.length) throw new BoundaryError("Invalid workflow continuation", 409);
      const outputs: any[] = start > 0 && Array.isArray(run.context?.outputs) ? [...run.context.outputs] : [];
      const context = run.workflow_context; // Never use client or mutable live definition context.
      for (let index = start; index < steps.length; index++) {
        const step = steps[index];
        await assertRunLineage(supabase, run, userId);
        await updateRun(supabase, run, { current_step: index });
        if (Object.hasOwn(actions, step.type)) {
          const response = await fetchImpl(`${supabaseUrl}/functions/v1/microsoft-execute`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ organization_id: run.organization_id, action: actions[step.type], workflow_run_id: run.id }) });
          const result = await response.json();
          if (response.status !== 200 || result.ok !== true || result.error) throw new BoundaryError("Microsoft read step did not complete", 502);
          outputs.push({ step: index, type: step.type, summary: result.summary, result: result.result });
        } else if (step.type === "note") {
          outputs.push({ step: index, type: "note", summary: step.text });
        } else if (step.type === "approval.email") {
          const payload = emailPayload({ to: resolveValue(step.to, context), subject: resolveValue(step.subject, context), message: resolveValue(step.message, context) });
          const { connection } = await connectionFor(supabase, run.organization_id);
          // This link is minted only from the claimed, frozen run. Public queue-email rejects it.
          const { data: action, error } = await supabase.from("action_requests").insert({ organization_id: run.organization_id, integration_id: connection.integration_id, connection_id: connection.id, provider: "microsoft", action_type: "send_email", status: "Pending", title: "Send Microsoft 365 email", summary: `Email to ${payload.to}: ${payload.subject}`, payload, requested_by: run.initiated_by, workflow_run_id: run.id }).select("*").single();
          if (error || !action?.id || action.status !== "Pending" || action.workflow_run_id !== run.id) throw new BoundaryError("Workflow email proposal could not be saved", 503);
          await updateRun(supabase, run, { status: "Waiting Approval", current_step: index, context: { ...context, outputs, action_request_id: action.id }, summary: "Workflow paused for distinct human approval", error_message: null });
          return respond({ ok: true, status: "Waiting Approval", run_id: run.id, action_request_id: action.id, outputs });
        }
      }
      await updateRun(supabase, run, { status: "Success", current_step: steps.length, completed_at: new Date(now()).toISOString(), context: { ...context, outputs }, summary: `Completed ${steps.length} workflow steps`, error_message: null });
      if (run.agent_run_request_id) {
        try {
          const { data, error } = await supabase.rpc("finish_agent_workflow", { p_run_id: run.id, p_actor_id: userId });
          if (error || data !== true) throw new Error("Unconfirmed agent completion");
        } catch {
          // Work is already persisted as Success. Never rerun it to repair bookkeeping.
          return respond({ ok: false, status: "Reconciliation required", outcome: "workflow_complete_agent_record_pending", run_id: run.id, retryable: false, error: "Workflow completed; its agent record needs reconciliation. Do not rerun." }, 202);
        }
      }
      return respond({ ok: true, status: "Success", run_id: run.id, outputs });
}
