import { connectionBinding, getMicrosoftAccessToken } from "../_shared/microsoft-connection.ts";
import { assertRunLineage, authenticate, bestEffort, BoundaryError, connectionFor, cors, emailPayload, fields, permissions, respond, stable } from "../_shared/approved-runtime.ts";

type Dependencies = { supabase: any; supabaseUrl: string; fetchImpl?: typeof fetch; now?: () => number; getToken?: typeof getMicrosoftAccessToken };
export function createHandler({ supabase, supabaseUrl, fetchImpl = fetch, now = Date.now, getToken = getMicrosoftAccessToken }: Dependencies) {
  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    let claimed: any = null;
    let dispatchAuthorized = false;
    let providerAccepted = false;
    try {
      const { userId, jwt } = await authenticate(req, supabase);
      let body: any;
      try { body = await req.json(); } catch { throw new BoundaryError("Invalid JSON"); }
      const op = body?.op;
      if (!["queue-email", "approve", "reject", "execute"].includes(op)) throw new BoundaryError("Invalid operation");
      fields(body, op === "queue-email" ? ["op", "organization_id", "to", "subject", "message"] : ["op", "request_id"]);
      if (op === "queue-email") {
        if (typeof body.organization_id !== "string" || !body.organization_id) throw new BoundaryError("organization_id required");
        const permission = await permissions(supabase, body.organization_id, userId);
        if (!permission.contribute) throw new BoundaryError("Not authorized for this tenant", 403);
        const payload = emailPayload({ to: body.to, subject: body.subject, message: body.message });
        const { connection } = await connectionFor(supabase, body.organization_id);
        const { data, error } = await supabase.from("action_requests").insert({
          organization_id: body.organization_id, integration_id: connection.integration_id, connection_id: connection.id,
          provider: "microsoft", action_type: "send_email", status: "Pending", title: "Send Microsoft 365 email",
          summary: `Email to ${payload.to}: ${payload.subject}`, payload, requested_by: userId, workflow_run_id: null,
        }).select("*").single();
        if (error || !data?.id || data.status !== "Pending") throw new BoundaryError("Unable to save pending proposal", 503);
        await bestEffort(() => supabase.from("audit_events").insert({ organization_id: data.organization_id, actor_user_id: userId, event_type: "action_requested", entity_type: "action_request", entity_id: data.id, summary: "Manual email proposal created", metadata: { action_type: "send_email" } }));
        return respond({ ok: true, request: data });
      }
      if (typeof body.request_id !== "string" || !body.request_id) throw new BoundaryError("request_id required");
      const { data: proposal, error } = await supabase.from("action_requests").select("*").eq("id", body.request_id).single();
      if (error || !proposal) throw new BoundaryError("Action request not found", 404);
      const permission = await permissions(supabase, proposal.organization_id, userId);
      if (!permission.approve) throw new BoundaryError("Action requires owner/admin/consultant authorization", 403);
      if (proposal.provider !== "microsoft" || proposal.action_type !== "send_email") throw new BoundaryError("Unsupported action", 409);
      if (op === "approve" || op === "reject") {
        if (proposal.status !== "Pending") throw new BoundaryError("Only pending requests can be reviewed", 409);
        if (op === "approve" && (!proposal.requested_by || proposal.requested_by === userId)) throw new BoundaryError("A different authorized person must approve", 403);
        if (op === "approve") {
          emailPayload(proposal.payload);
          const { connection } = await connectionFor(supabase, proposal.organization_id, proposal.connection_id);
          if (connection.integration_id !== proposal.integration_id) throw new BoundaryError("Proposal integration mismatch", 409);
        }
        const updates = op === "approve" ? { status: "Approved", approved_by: userId, approved_at: new Date(now()).toISOString(), error_message: null } : { status: "Rejected", rejected_by: userId, rejected_at: new Date(now()).toISOString(), error_message: null };
        const { data, error: reviewError } = await supabase.from("action_requests").update(updates).eq("id", proposal.id).eq("status", "Pending").select("*").single();
        if (reviewError || !data || data.status !== updates.status) throw new BoundaryError("Proposal changed or review could not be saved", 409);
        await bestEffort(() => supabase.from("audit_events").insert({ organization_id: proposal.organization_id, actor_user_id: userId, event_type: op === "approve" ? "action_approved" : "action_rejected", entity_type: "action_request", entity_id: proposal.id, summary: `Microsoft email action ${op === "approve" ? "approved" : "rejected"}`, metadata: { action_type: "send_email" } }));
        return respond({ ok: true, request: data });
      }
      // Only this serialized RPC authorizes execution. Never infer a claim from a read.
      const { data: claim, error: claimError } = await supabase.rpc("claim_microsoft_action", { request_id: proposal.id, actor_id: userId });
      if (claimError || !claim || claim.id !== proposal.id || claim.status !== "Executing") throw new BoundaryError("Action cannot be claimed; it may already be in progress", 409);
      claimed = claim;
      const payload = emailPayload(claim.payload);
      if (claim.organization_id !== proposal.organization_id || claim.provider !== "microsoft" || claim.action_type !== "send_email" || claim.approval_guard_version !== 1 || !claim.approved_at || !claim.approved_by || claim.approved_by === claim.requested_by) throw new BoundaryError("Invalid claimed approval", 409);
      const checkWorkflow = async () => {
        if (!claim.workflow_run_id) return;
        const { data: run, error } = await supabase.from("workflow_runs").select("*").eq("id", claim.workflow_run_id).eq("organization_id", claim.organization_id).single();
        if (error || !run || run.status !== "Waiting Approval" || run.context?.action_request_id !== claim.id) throw new BoundaryError("Approved workflow binding changed", 409);
        await assertRunLineage(supabase, run, userId);
      };
      await checkWorkflow();
      const { connection, integration } = await connectionFor(supabase, claim.organization_id, claim.connection_id);
      if (claim.integration_id !== connection.integration_id || stable(claim.approved_connection_binding) !== stable(connectionBinding(connection, integration))) throw new BoundaryError("Approved Microsoft identity changed", 409);
      const accessToken = await getToken({ supabase, connection, fetchImpl, now });
      if (typeof accessToken !== "string" || !accessToken) throw new BoundaryError("Access token unavailable", 409);
      await checkWorkflow();
      const { data: recorded, error: dispatchError } = await supabase.rpc("record_microsoft_attempt", { p_request_id: claim.id, p_actor_id: userId, p_phase: "Dispatching", p_provider_reference: null });
      if (dispatchError || recorded !== true) throw new BoundaryError("Dispatch authorization could not be confirmed", 409);
      dispatchAuthorized = true;
      const graph = await fetchImpl("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { subject: payload.subject, body: { contentType: "Text", content: payload.message }, toRecipients: [{ emailAddress: { address: payload.to } }] }, saveToSentItems: true }),
      });
      // sendMail's documented acknowledgement is 202. It does not prove delivery.
      if (graph.status !== 202) throw new BoundaryError("Microsoft send outcome requires review", 502);
      providerAccepted = true;
      const reference = graph.headers.get("request-id") || graph.headers.get("client-request-id") || null;
      const { data: accepted, error: acceptanceError } = await supabase.rpc("record_microsoft_attempt", { p_request_id: claim.id, p_actor_id: userId, p_phase: "ProviderAccepted", p_provider_reference: reference });
      if (acceptanceError || accepted !== true) throw new BoundaryError("Provider acceptance could not be recorded", 503);
      const { data: completed, error: completionError } = await supabase.from("action_requests").update({ status: "Executed", executed_at: new Date(now()).toISOString(), error_message: null }).eq("id", claim.id).eq("status", "Executing").select("*").single();
      if (completionError || !completed || completed.status !== "Executed") throw new BoundaryError("Provider acceptance recorded; completion needs review", 503);
      const recordedAudit = await bestEffort(() => supabase.from("audit_events").insert({ organization_id: claim.organization_id, actor_user_id: userId, event_type: "action_executed", entity_type: "action_request", entity_id: claim.id, summary: "Microsoft accepted the approved email", metadata: { provider_accepted: true } }));
      const recordedRun = await bestEffort(() => supabase.from("integration_runs").insert({ organization_id: claim.organization_id, integration_id: claim.integration_id, connection_id: claim.connection_id, provider: "microsoft", action: "send-email", status: "Success", actor_user_id: userId, summary: "Microsoft accepted the approved email", metadata: { approval_request_id: claim.id, provider_accepted: true } }));
      let workflowStatus: string | null = null;
      if (claim.workflow_run_id) {
        try {
          const response = await fetchImpl(`${supabaseUrl}/functions/v1/workflow-resume`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ run_id: claim.workflow_run_id }) });
          const result = await response.json();
          workflowStatus = response.status === 200 && result.ok === true && ["Success", "Waiting Approval"].includes(result.status) ? result.status : "Needs review";
        } catch { workflowStatus = "Needs review"; }
      }
      return respond({ ok: true, status: "Executed", outcome: "provider_accepted", delivered: false, retryable: false, request_id: claim.id, summary: "Microsoft accepted the approved email", workflow_status: workflowStatus, audit_pending: !(recordedAudit && recordedRun) });
    } catch (error) {
      if (claimed) {
        // No reset, no automatic Failed transition, and no second Graph attempt.
        // An uncertain receipt/completion/resume must never erase an accepted send.
        return respond({ ok: false, status: "Executing", outcome: providerAccepted ? "provider_accepted_needs_reconciliation" : dispatchAuthorized ? "unknown" : "not_dispatched_needs_reconciliation", provider_accepted: providerAccepted, retryable: false, request_id: claimed.id, error: providerAccepted ? "Microsoft accepted the email; the record needs reconciliation. Do not resend." : "The claimed action needs review. Do not resend." }, 202);
      }
      return respond({ ok: false, error: error instanceof BoundaryError ? error.message : "Action service unavailable" }, error instanceof BoundaryError ? error.status : 503);
    }
  };
}
