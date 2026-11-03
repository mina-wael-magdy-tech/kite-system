// PULSE STUDIO OS — Edge Function: invite-employee
// Admin / HR invites a new employee. Server-side only: creates the auth user,
// the profile (status = onboarding), the role assignment and the invitation record.
//
// Privilege rules (enforced here, not in the browser):
//   * caller must be an active admin (super_admin/owner/general_manager) or hr_manager
//   * only admins may grant admin-level roles; only a super_admin may grant super_admin
//   * if any step fails, everything created so far is rolled back

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, audit, getCaller } from "../_shared/auth.ts";
import * as v from "../_shared/validate.ts";

const ADMIN_LEVEL = ["super_admin", "owner", "general_manager"];

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  if (!(caller.isAdmin || caller.has("hr_manager"))) {
    throw new HttpError(403, "Admin or HR privilege required");
  }

  const b = await readJson(req);

  // --- delete an employee (removes the auth user; cascades to profile / roles)
  if (b.action === "delete") {
    const targetId = v.uuid(b.userId, "userId");
    if (targetId === caller.id) throw new HttpError(400, "You cannot delete your own account");
    const { data: target } = await admin.from("profiles").select("id, email, employment_status").eq("id", targetId).maybeSingle();
    if (!target) throw new HttpError(404, "Employee not found");
    const { data: targetRoles } = await admin.from("user_roles").select("roles(name)").eq("user_id", targetId);
    // deno-lint-ignore no-explicit-any
    const isTargetAdmin = (targetRoles ?? []).some((r: any) => ADMIN_LEVEL.includes(r.roles?.name));
    if (isTargetAdmin && !caller.isAdmin) throw new HttpError(403, "Only an administrator can delete this account");

    await admin.from("invitations").delete().eq("email", target.email);
    const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
    if (delErr) {
      console.error("delete employee failed:", delErr);
      throw new HttpError(409, "Could not delete: this employee has linked records (tasks, expenses...). Set their status to Inactive instead.");
    }
    await audit(admin, { userId: caller.id, action: "EMPLOYEE_DELETED", entityType: "profiles", entityId: targetId, oldData: { email: target.email } }, req);
    return json(req, { success: true });
  }

  const email = v.email(b.email);
  const fullName = v.text(b.fullName, "fullName", 2, 120);
  const roleId = v.uuid(b.roleId, "roleId");
  // One or many departments; the first is the primary one
  const deptIds: string[] = Array.isArray(b.departmentIds)
    ? [...new Set(b.departmentIds.map((x) => v.uuid(x, "departmentIds")))]
    : (v.optUuid(b.departmentId, "departmentId") ? [v.optUuid(b.departmentId, "departmentId") as string] : []);
  const departmentId = deptIds[0] ?? null;
  const jobTitle = v.optText(b.jobTitle, "jobTitle", 100) ?? "Studio Member";

  // --- authorize the requested role
  const { data: role } = await admin.from("roles").select("id, name, is_active").eq("id", roleId).maybeSingle();
  if (!role || !role.is_active) throw new HttpError(400, "Unknown or inactive role");
  if (ADMIN_LEVEL.includes(role.name) && !caller.isAdmin) {
    throw new HttpError(403, "Only an administrator can grant this role");
  }
  if (role.name === "super_admin" && !caller.has("super_admin")) {
    throw new HttpError(403, "Only a super administrator can grant super_admin");
  }

  if (deptIds.length) {
    const { data: found } = await admin.from("departments").select("id").in("id", deptIds);
    if ((found?.length ?? 0) !== deptIds.length) throw new HttpError(400, "Unknown department");
  }

  const { data: existing } = await admin.from("profiles").select("id, employment_status").eq("email", email).maybeSingle();
  if (existing) {
    // Re-invite: only allowed while the person has never accepted (still onboarding)
    if (existing.employment_status !== "onboarding") {
      throw new HttpError(409, "An employee with this email already exists");
    }
    await admin.from("invitations").delete().eq("email", email);
    const { error } = await admin.auth.admin.deleteUser(existing.id);
    if (error) throw new HttpError(500, "Could not reset the previous invitation");
  } else {
    // Leftover auth user from a failed earlier attempt (no profile) blocks a new invite
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const stale = list?.users?.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (stale) {
      await admin.from("invitations").delete().eq("email", email);
      await admin.auth.admin.deleteUser(stale.id);
    }
  }

  // --- create the auth user + invitation email
  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
  if (!appUrl) throw new Error("APP_URL secret is not configured");

  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${appUrl}/invitation.html`,
  });
  if (inviteErr || !invited?.user) throw new HttpError(400, "Could not send invitation");
  const userId = invited.user.id;

  // --- everything below rolls back (deleting the auth user cascades to profile/roles)
  try {
    const { error: profileErr } = await admin.from("profiles").insert({
      id: userId, full_name: fullName, email, job_title: jobTitle,
      department_id: departmentId, employment_status: "onboarding",
    });
    if (profileErr) throw profileErr;

    const { error: roleErr } = await admin.from("user_roles").insert({ user_id: userId, role_id: roleId, assigned_by: caller.id });
    if (roleErr) throw roleErr;

    if (deptIds.length) {
      const { error } = await admin.from("user_departments").insert(
        deptIds.map((id, i) => ({ user_id: userId, department_id: id, is_primary: i === 0 })),
      );
      if (error) throw error;
    }
    const { error: invErr } = await admin.from("invitations").insert({
      email, full_name: fullName, role_id: roleId, department_id: departmentId,
      job_title: jobTitle, invited_by: caller.id, token: crypto.randomUUID(), status: "pending",
    });
    if (invErr) throw invErr;
  } catch (err) {
    console.error("invite rollback:", err);
    await admin.auth.admin.deleteUser(userId);
    throw new HttpError(500, "Invitation failed and was rolled back. Please try again.");
  }

  await audit(admin, { userId: caller.id, action: "EMPLOYEE_INVITED", entityType: "profiles", entityId: userId, newData: { email, role: role.name, departmentId } }, req);
  return json(req, { success: true, userId });
});
