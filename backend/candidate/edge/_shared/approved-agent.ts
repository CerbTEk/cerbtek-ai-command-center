import { authenticate, bestEffort, BoundaryError, cors, fields, respond } from "./approved-runtime.ts";
import { executeTrustedWorkflow, manualContext } from "./approved-workflow.ts";

type Dependencies = { supabase: any; supabaseUrl: string; fetchImpl?: typeof fetch; now?: () => number };
export function createAgentHandler({ supabase, supabaseUrl, fetchImpl = fetch, now = Date.now }: Dependencies) {
  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    let run: any = null;
    try {
      const { userId, jwt } = await authenticate(req, supabase);
      let body: any;
      try { body = await req.json(); } catch { throw new BoundaryError("Invalid JSON"); }
      const op = body?.op;
      if (!["request", "approve", "reject", "execute"].includes(op)) throw new BoundaryError("Invalid operation");
      fields(body, op === "request" ? ["op", "organization_id", "agent_id", "workflow_id", "context"] : ["op", "request_id"]);
      if (op === "request") {
        if (![body.agent_id, body.workflow_id, body.organization_id].every(v => typeof v === "string" && v)) throw new BoundaryError("Organization, agent, and workflow IDs required");
        const context = manualContext(body.context ?? {});
        // Tenant is resolved by the server from the agent. Confirm the selected UI tenant
        // before creation, preventing cross-tenant stale-tab proposals.
        const { data: agent, error: lookupError } = await supabase.from("ai_agents").select("id,organization_id").eq("id", body.agent_id).eq("organization_id", body.organization_id).single();
        if (lookupError || !agent || agent.organization_id !== body.organization_id) throw new BoundaryError("Agent unavailable in this tenant", 403);
        const { data, error } = await supabase.rpc("create_agent_workflow_request", { p_agent_id: body.agent_id, p_workflow_id: body.workflow_id, p_actor_id: userId, p_context: context });
        if (error || !data || data.status !== "Pending" || data.organization_id !== body.organization_id || data.requested_by !== userId || !data.execution_snapshot || data.approved_by || data.workflow_run_id) throw new BoundaryError("Human-reviewed agent proposal could not be saved", 409);
        return respond({ ok: true, status: "Pending", workflow_status: null, request: data });
      }
      if (typeof body.request_id !== "string" || !body.request_id) throw new BoundaryError("request_id required");
      if (op === "approve" || op === "reject") {
        const { data, error } = await supabase.rpc("review_agent_workflow_request", { p_request_id: body.request_id, p_actor_id: userId, p_approve: op === "approve" });
        const expected = op === "approve" ? "Approved" : "Rejected";
        if (error || !data || data.id !== body.request_id || data.status !== expected || (op === "approve" && (data.approved_by !== userId || data.requested_by === userId))) throw new BoundaryError("Agent proposal cannot be reviewed by this person or has changed", 409);
        return respond({ ok: true, status: expected, workflow_status: null, request: data });
      }
      // A single transaction checks live authority, consumes the day's quota, and
      // creates exactly one linked run. Repeated execute requests cannot mint another.
      const { data, error } = await supabase.rpc("reserve_agent_workflow", { p_request_id: body.request_id, p_actor_id: userId });
      if (error || !data || !data.id || data.agent_run_request_id !== body.request_id || data.status !== "Running") throw new BoundaryError("Agent execution unavailable, already reserved, or requires renewed human review", 409);
      run = data;
      const response = await executeTrustedWorkflow({ run, jwt, userId, supabase, supabaseUrl, fetchImpl, now }, 0);
      const result = await response.json();
      if (response.status === 202 && result.ok === false && result.run_id === run.id && result.retryable === false) {
        return respond({ ...result, status: "Approved", workflow_status: result.status, request_id: body.request_id, workflow_run_id: run.id }, 202);
      }
      if (response.status !== 200 || result.ok !== true || result.run_id !== run.id || !["Success", "Waiting Approval"].includes(result.status)) throw new BoundaryError("Linked workflow needs human review", 409);
      return respond({ ok: true, status: result.status === "Success" ? "Executed" : "Approved", workflow_status: result.status, request_id: body.request_id, workflow_run_id: run.id, action_request_id: result.action_request_id ?? null });
    } catch (error) {
      if (run) await bestEffort(() => supabase.from("workflow_runs").update({ status: "Error", completed_at: new Date(now()).toISOString(), error_message: "Agent workflow needs human review", summary: "Agent execution stopped safely" }).eq("id", run.id).eq("status", "Running"));
      return respond({ ok: false, ...(run ? { status: "Approved", workflow_status: "Needs review", workflow_run_id: run.id, retryable: false } : {}), error: error instanceof BoundaryError ? error.message : "Agent service unavailable" }, error instanceof BoundaryError ? error.status : 503);
    }
  };
}
