import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { HttpError } from "./http.ts";
import { sendPush } from "./push.ts";

export const ADMIN_ROLES = ["super_admin", "owner", "general_manager"] as const;
export const MANAGER_ROLES = [...ADMIN_ROLES, "department_manager", "project_manager", "team_leader"] as const;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** Service-role client. Bypasses RLS — use only after the caller was authorized in code. */
export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client acting AS the caller: Row Level Security applies. Use it to ask "may this user see X?". */
export function userClient(token: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller {
  id: string;
  email: string;
  token: string;
  status: string; // profiles.employment_status
  roles: string[];
  isAdmin: boolean;
  isManager: boolean;
  isStaff: boolean; // active and holds a non-client role
  has(role: string): boolean;
}

/**
 * Authenticates the request and loads the caller's server-side identity.
 * Never trusts anything the browser says about roles.
 */
export async function getCaller(req: Request, admin: SupabaseClient): Promise<Caller> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Missing authorization token");

  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new HttpError(401, "Invalid or expired session");

  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    admin.from("profiles").select("employment_status").eq("id", user.id).maybeSingle(),
    admin.from("user_roles").select("roles(name, is_active)").eq("user_id", user.id),
  ]);

  const roles: string[] = (roleRows ?? [])
    // deno-lint-ignore no-explicit-any
    .map((r: any) => r.roles)
    // deno-lint-ignore no-explicit-any
    .filter((r: any) => r && r.is_active)
    // deno-lint-ignore no-explicit-any
    .map((r: any) => r.name as string);

  const status = profile?.employment_status ?? "none";
  const active = status === "active";
  const has = (role: string) => active && roles.includes(role);
  return {
    id: user.id,
    email: user.email ?? "",
    token,
    status,
    roles,
    has,
    isAdmin: active && ADMIN_ROLES.some((r) => roles.includes(r)),
    isManager: active && MANAGER_ROLES.some((r) => roles.includes(r)),
    isStaff: active && roles.some((r) => r !== "client"),
  };
}

export function requireStaff(c: Caller): void {
  if (!c.isStaff) throw new HttpError(403, "Active staff account required");
}

/** Append-only audit trail. Failures are logged but never block the user action. */
export async function audit(
  admin: SupabaseClient,
  entry: {
    userId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    oldData?: unknown;
    newData?: unknown;
  },
  req?: Request,
): Promise<void> {
  const { error } = await admin.from("audit_logs").insert({
    user_id: entry.userId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    old_data: entry.oldData ?? null,
    new_data: entry.newData ?? null,
    ip_address: req?.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    user_agent: req?.headers.get("user-agent")?.slice(0, 300) ?? null,
  });
  if (error) console.error("audit insert failed:", error.message);
}

export async function notify(
  admin: SupabaseClient,
  n: { userId: string; type: string; title: string; content: string; link?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  const { error } = await admin.from("notifications").insert({
    user_id: n.userId,
    type: n.type,
    title: n.title,
    content: n.content,
    link: n.link ?? null,
    metadata: n.metadata ?? {},
  });
  if (error) {
    console.error("notification insert failed:", error.message);
    return;
  }
  // Same message on the user's phone / desktop (no-op when push is not configured)
  await sendPush(admin, n.userId, { title: n.title, body: n.content, url: n.link, tag: n.type });
}

/** Active people holding any of the given roles (unknown role names simply match nobody). */
export async function userIdsWithRoles(admin: SupabaseClient, roleNames: readonly string[]): Promise<string[]> {
  const { data } = await admin
    .from("user_roles")
    .select("user_id, roles!inner(name)")
    .in("roles.name", [...roleNames]);
  const ids = [...new Set((data ?? []).map((r: { user_id: string }) => r.user_id))];
  if (!ids.length) return [];
  const { data: active } = await admin.from("profiles").select("id").in("id", ids).eq("employment_status", "active");
  return (active ?? []).map((p: { id: string }) => p.id);
}
