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

// ---------------------------------------------------------------------------
// Canonical role tiers (single source for account-management decisions).
// Lower number = more powerful. `owner` and `ceo` are the same tier.
//   0 super_admin | 1 owner, ceo | 2 general_manager | 3 finance_manager, accountant
//   4 hr_manager  | 5 every other role (and a person with no role)
// Rules (enforced server-side by invite-employee and workflow):
//   * grant a role      -> the caller's tier must be <= the role's tier; super_admin only by a super_admin
//   * modify / disable / delete an account -> the caller's tier must be <= the account's best tier;
//     a super_admin account can only be managed by a super_admin
//   * the last active super_admin can never be demoted, disabled or deleted
// Gate for using these paths at all is unchanged: an active admin (super_admin/owner/general_manager) or hr_manager.
// ---------------------------------------------------------------------------
export const ROLE_TIER: Readonly<Record<string, number>> = {
  super_admin: 0,
  owner: 1,
  ceo: 1,
  general_manager: 2,
  finance_manager: 3,
  accountant: 3,
  hr_manager: 4,
};
export const DEFAULT_ROLE_TIER = 5;
const NO_TIER = 99; // inactive caller: powerless

export function roleTier(roleName: string): number {
  return ROLE_TIER[roleName] ?? DEFAULT_ROLE_TIER;
}

/** Best (lowest) tier among the given role names; no roles counts as the default tier. */
export function bestTier(roleNames: readonly string[]): number {
  return roleNames.length ? Math.min(...roleNames.map(roleTier)) : DEFAULT_ROLE_TIER;
}

export function callerTier(c: Pick<Caller, "status" | "roles">): number {
  return c.status === "active" ? bestTier(c.roles) : NO_TIER;
}

export function canGrantRole(c: Pick<Caller, "status" | "roles">, roleName: string): boolean {
  const t = roleTier(roleName);
  const mine = callerTier(c);
  return t === 0 ? mine === 0 : mine <= t;
}

export function canManageAccount(c: Pick<Caller, "status" | "roles">, targetRoleNames: readonly string[]): boolean {
  const t = bestTier(targetRoleNames);
  const mine = callerTier(c);
  return t === 0 ? mine === 0 : mine <= t;
}

export function assertCanGrantRole(c: Caller, roleName: string): void {
  if (roleTier(roleName) === 0 && !canGrantRole(c, roleName)) {
    throw new HttpError(403, "Only a super administrator can grant super_admin");
  }
  if (!canGrantRole(c, roleName)) throw new HttpError(403, "You are not allowed to grant this role");
}

export function assertCanManageAccount(c: Caller, targetRoleNames: readonly string[]): void {
  if (!canManageAccount(c, targetRoleNames)) throw new HttpError(403, "You are not allowed to modify this account");
}

/** Names of the active roles held by a user (service-role read). */
export async function activeRoleNames(admin: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await admin.from("user_roles").select("roles(name, is_active)").eq("user_id", userId);
  if (error) throw error;
  return (data ?? [])
    // deno-lint-ignore no-explicit-any
    .map((r: any) => r.roles)
    // deno-lint-ignore no-explicit-any
    .filter((r: any) => r && r.is_active)
    // deno-lint-ignore no-explicit-any
    .map((r: any) => r.name as string);
}

/**
 * Refuses (409) to demote, disable or delete the last ACTIVE super administrator.
 * Pass the person about to lose super-admin status; a person who is not an active super_admin is a no-op.
 */
export async function assertNotLastActiveSuperAdmin(admin: SupabaseClient, targetUserId: string): Promise<void> {
  const { data, error } = await admin
    .from("user_roles")
    .select("user_id, roles!inner(name, is_active)")
    .eq("roles.name", "super_admin");
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  const holders = [...new Set((data ?? []).filter((r: any) => r.roles?.is_active).map((r: any) => r.user_id as string))];
  if (!holders.includes(targetUserId)) return;
  const { data: profiles, error: pErr } = await admin.from("profiles").select("id, employment_status").in("id", holders);
  if (pErr) throw pErr;
  const active = (profiles ?? []).filter((p: { employment_status: string }) => p.employment_status === "active")
    .map((p: { id: string }) => p.id);
  if (!active.includes(targetUserId)) return; // already not counted as an active super admin
  if (active.filter((id) => id !== targetUserId).length === 0) {
    throw new HttpError(409, "Cannot remove, disable or delete the last active super administrator");
  }
}

/** Atomic role replacement (DB function, one transaction). The previous role survives any failure. */
export async function replaceUserRole(admin: SupabaseClient, userId: string, roleId: string, assignedBy: string): Promise<void> {
  const { error } = await admin.rpc("replace_user_role", { p_user_id: userId, p_role_id: roleId, p_assigned_by: assignedBy });
  if (!error) return;
  if (/last_super_admin/.test(error.message)) {
    throw new HttpError(409, "Cannot remove, disable or delete the last active super administrator");
  }
  if (/unknown_role/.test(error.message)) throw new HttpError(400, "Unknown or inactive role");
  throw error;
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
  n: {
    userId: string; type: string; title: string; content: string; link?: string; metadata?: Record<string, unknown>;
    push?: { tag?: string; urgent?: boolean; requireInteraction?: boolean };
  },
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
  await sendPush(admin, n.userId, {
    title: n.title, body: n.content, url: n.link,
    tag: n.push?.tag ?? n.type, urgent: n.push?.urgent, requireInteraction: n.push?.requireInteraction,
  });
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
