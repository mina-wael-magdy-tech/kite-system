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
  const email = v.email(b.email);
  const fullName = v.text(b.fullName, "fullName", 2, 120);
  const roleId = v.uuid(b.roleId, "roleId");
  const departmentId = v.optUuid(b.departmentId, "departmentId");
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

  if (departmentId) {
    const { data: dept } = await admin.from("departments").select("id").eq("id", departmentId).maybeSingle();
    if (!dept) throw new HttpError(400, "Unknown department");
  }

  const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (existing) throw new HttpError(409, "An employee with this email already exists");

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

    if (departmentId) {
      const { error } = await admin.from("user_departments").insert({ user_id: userId, department_id: departmentId, is_primary: true });
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
