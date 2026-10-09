// No remote imports: same production helper is exercised by offline Node tests.
export type Client = any;
export type Row = Record<string, any>;
export const DEFAULT_SCOPES = ["openid", "profile", "offline_access", "User.Read"];
export const SUPPORTED_SCOPES = [...DEFAULT_SCOPES, "Mail.Read", "Mail.Send", "Calendars.Read", "Files.Read.All"];
const SIGN_IN_SCOPES = new Set(["openid", "profile", "offline_access", "email"]);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const canonicalScopes = (scopes: string[]): string[] => [...new Set(scopes)].sort();

// Mirrors private.microsoft_connection_binding. SQL is authoritative at every write/dispatch.
export function connectionBinding(c: Row, i: Row) {
  return {
    id: c.id, organization_id: c.organization_id, integration_id: c.integration_id,
    provider: c.provider, tenant_id: c.tenant_id, client_id: c.client_id,
    external_account_id: c.external_account_id, access_secret_id: c.access_secret_id,
    refresh_secret_id: c.refresh_secret_id, client_secret_id: c.client_secret_id,
    oauth_verified_version: c.oauth_verified_version, oauth_revision: c.oauth_revision,
    scopes: canonicalScopes(c.scopes || []), integration_revision: i.oauth_revision,
  };
}
export async function rpc(client: Client, name: string, args: Row) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`Microsoft operation failed: ${name}`);
  return data;
}
export async function requireTrue(client: Client, name: string, args: Row) {
  if ((await rpc(client, name, args)) !== true) throw new Error(`Microsoft operation was not committed: ${name}`);
}
export function parseGrantedScopes(scope: unknown, requested: string[]): string[] {
  if (typeof scope !== "string" || !scope.trim()) throw new Error("Microsoft did not confirm granted scopes");
  const granted = canonicalScopes(scope.trim().split(/\s+/).map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "")));
  const resource = (ss: string[]) => canonicalScopes(ss.filter(s => !SIGN_IN_SCOPES.has(s)));
  if (JSON.stringify(resource(granted)) !== JSON.stringify(resource(requested))) {
    throw new Error("Microsoft granted scopes differ from the requested scopes");
  }
  return granted;
}
export function tokenResult(value: Row, requested: string[], now = Date.now(), requireRefresh = false) {
  if (typeof value.access_token !== "string" || !value.access_token || /[\r\n]/.test(value.access_token)
      || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
      || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400
      || (requireRefresh && (typeof value.refresh_token !== "string" || !value.refresh_token))
      || (value.refresh_token !== undefined && (typeof value.refresh_token !== "string" || !value.refresh_token))) {
    throw new Error("Microsoft returned an incomplete token grant");
  }
  return {accessToken: value.access_token, refreshToken: value.refresh_token ?? null,
    expiresAt: new Date(now + value.expires_in * 1000).toISOString(),
    grantedScopes: parseGrantedScopes(value.scope, requested)};
}
export async function providerJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}) {
  const response = await fetchImpl(url, {...init, redirect: "error", signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error("Microsoft provider request failed");
  let json: any;
  try { json = await response.json(); } catch { throw new Error("Microsoft returned an invalid response"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Microsoft returned an invalid response");
  return json;
}
export async function verifiedMailbox(fetchImpl: typeof fetch, accessToken: string, expectedId?: string) {
  const account = await providerJson(fetchImpl, "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName,mail", {
    headers: {Authorization: `Bearer ${accessToken}`, Accept: "application/json"},
  });
  const principal = account.mail || account.userPrincipalName;
  if (typeof account.id !== "string" || !account.id.trim() || account.id.length > 512 || /[\x00-\x1f\x7f]/.test(account.id)
      || typeof principal !== "string" || !principal.includes("@") || /[\x00-\x1f\x7f]/.test(principal)
      || (expectedId !== undefined && account.id !== expectedId)) {
    throw new Error("Microsoft mailbox identity could not be verified");
  }
  return {id: account.id, name: typeof account.displayName === "string" && account.displayName.trim() ? account.displayName.slice(0,512) : principal.slice(0,512)};
}
export async function loadMicrosoftIntegration(supabase: Client, connection: Row) {
  const {data: i, error} = await supabase.from("integrations").select("*")
    .eq("id", connection.integration_id).eq("organization_id", connection.organization_id).single();
  if (error || !i || i.id !== connection.integration_id || i.organization_id !== connection.organization_id || i.provider !== "Microsoft" || i.integration_type !== "OAuth" || i.status !== "Connected"
      || i.scopes !== (connection.scopes || []).join(" ") || !i.oauth_revision) {
    throw new Error("Microsoft integration is unavailable");
  }
  return i;
}
export async function validateConnection(supabase: Client, connection: Row, binding: Row) {
  await requireTrue(supabase, "validate_microsoft_connection", {
    p_connection_id: connection.id, p_organization_id: connection.organization_id, p_expected_binding: binding,
  });
}
export async function getMicrosoftAccessToken({supabase, connection, fetchImpl = fetch, now = Date.now}: {
  supabase: Client; connection: Row; fetchImpl?: typeof fetch; now?: () => number;
}): Promise<string> {
  if (connection.provider !== "microsoft" || connection.status !== "Connected" || connection.oauth_verified_version !== 1
      || !connection.external_account_id || !connection.client_secret_id || !connection.access_secret_id
      || !connection.refresh_secret_id || !connection.oauth_refresh_revision) throw new Error("Microsoft connection is unavailable");
  const integration = await loadMicrosoftIntegration(supabase, connection);
  const binding = connectionBinding(connection, integration);
  await validateConnection(supabase, connection, binding);
  const readSecret = async (id: string) => {
    const secret = await rpc(supabase, "edge_read_secret", {secret_id: id});
    if (typeof secret !== "string" || !secret) throw new Error("Microsoft credential unavailable");
    return secret;
  };
  if (Date.parse(connection.token_expires_at || "") > now() + 120000) {
    const access = await readSecret(connection.access_secret_id);
    await validateConnection(supabase, connection, binding);
    return access;
  }
  const refresh = await readSecret(connection.refresh_secret_id);
  const clientSecret = await readSecret(connection.client_secret_id);
  await validateConnection(supabase, connection, binding);
  const json = await providerJson(fetchImpl, `https://login.microsoftonline.com/${encodeURIComponent(connection.tenant_id)}/oauth2/v2.0/token`, {
    method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({client_id: connection.client_id, client_secret: clientSecret,
      grant_type: "refresh_token", refresh_token: refresh, scope: connection.scopes.join(" ")}),
  });
  const result = tokenResult(json, connection.scopes, now());
  const account = await verifiedMailbox(fetchImpl, result.accessToken, connection.external_account_id);
  await requireTrue(supabase, "commit_microsoft_refresh", {connection_id: connection.id, organization_id: connection.organization_id,
    expected_refresh_revision: connection.oauth_refresh_revision, expected_binding: binding,
    access_token: result.accessToken, refresh_token: result.refreshToken, expires_at: result.expiresAt,
    verified_account_id: account.id, granted_scopes: result.grantedScopes});
  return result.accessToken;
}
