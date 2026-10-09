// Shared request boundary for manually initiated, human-approved workflows.
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export class BoundaryError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
export function object(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function fields(body: any, allowed: string[]) {
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new BoundaryError("Unsupported request fields");
}
export async function authenticate(req: Request, supabase: any) {
  const authorization = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new BoundaryError("Missing or invalid authorization", 401);
  const jwt = authorization.replace(/^Bearer\s+/i, "");
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user?.id || data.user.is_anonymous === true) throw new BoundaryError("Invalid session", 401);
  return { userId: data.user.id, jwt };
}
export async function permissions(supabase: any, organizationId: string, userId: string) {
  const [membership, staff] = await Promise.all([
    supabase.from("organization_members").select("role").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle(),
    supabase.from("staff_accounts").select("role,active").eq("user_id", userId).maybeSingle(),
  ]);
  if (membership.error || staff.error) throw new BoundaryError("Authorization check unavailable", 503);
  const m = membership.data, s = staff.data;
  return {
    contribute: !!m || s?.active === true,
    approve: !!(m && ["owner", "admin", "consultant"].includes(m.role)) || !!(s?.active === true && ["platform_admin", "consultant"].includes(s.role)),
  };
}
export function emailPayload(value: any) {
  fields(value, ["to", "subject", "message"]);
  if (![value.to, value.subject, value.message].every(v => typeof v === "string" && v.trim())) throw new BoundaryError("Recipient, subject, and message are required");
  if (value.to.length > 320 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.to) || /[\r\n]/.test(value.subject) || value.subject.length > 998 || value.message.length > 100000) throw new BoundaryError("Email payload is invalid or too large");
  return { to: value.to, subject: value.subject, message: value.message };
}
export function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function connectionFor(supabase: any, organizationId: string, connectionId?: string) {
  let query = supabase.from("oauth_connections").select("*").eq("organization_id", organizationId).eq("provider", "microsoft");
  if (connectionId) query = query.eq("id", connectionId);
  const { data: c, error } = await query.single();
  if (error || !c || c.organization_id !== organizationId || c.provider !== "microsoft" || c.status !== "Connected" || c.oauth_verified_version !== 1 || !c.external_account_id || !Array.isArray(c.scopes) || !c.scopes.includes("Mail.Send")) throw new BoundaryError("Verified Microsoft connection with Mail.Send required", 409);
  const { data: i, error: ie } = await supabase.from("integrations").select("*").eq("id", c.integration_id).eq("organization_id", organizationId).single();
  if (ie || !i || i.organization_id !== organizationId || i.id !== c.integration_id || i.status !== "Connected" || i.provider !== "Microsoft" || i.integration_type !== "OAuth") throw new BoundaryError("Microsoft integration unavailable", 409);
  return { connection: c, integration: i };
}
export async function bestEffort(operation: () => Promise<any>) {
  try { const result = await operation(); return !result?.error; } catch { return false; }
}
// A null assertion is valid only for a truly manual server-created run. Linked
// agent runs must carry the exact trusted lineage; never downgrade them to manual.
export async function assertRunLineage(supabase: any, run: any, userId: string) {
  const { data, error } = await supabase.rpc("assert_agent_workflow_lineage", { p_run_id: run.id, p_actor_id: userId });
  if (error || (run.agent_run_request_id ? !object(data) || data.agent_request_id !== run.agent_run_request_id : data !== null)) throw new BoundaryError("Workflow approval lineage is unavailable or invalid", 409);
  return data;
}
