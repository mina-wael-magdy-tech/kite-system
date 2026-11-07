// PULSE STUDIO OS — Edge Function: accept-invitation
// Called by an invited user AFTER they set their password. Activates the profile.
// Users cannot do this themselves: employment_status is not client-writable.

import { HttpError, json, serveJson } from "../_shared/http.ts";
import { adminClient, ADMIN_ROLES, audit, getCaller, notify, userIdsWithRoles } from "../_shared/auth.ts";

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);

  if (caller.status !== "onboarding") {
    throw new HttpError(409, "No pending invitation for this account");
  }

  // One atomic database decision (migration 034): profile + invitation are locked, checked and updated together,
  // so a double click, a replay or two devices can never activate twice or leave the invitation half-updated.
  const { data: outcome, error } = await admin.rpc("accept_invitation", { p_user: caller.id });
  if (error) throw error;
  if (outcome === "expired") throw new HttpError(410, "This invitation has expired. Ask your administrator to invite you again.");
  if (outcome === "not_onboarding") throw new HttpError(409, "Account is already active");
  if (outcome !== "accepted") throw new HttpError(409, "No pending invitation for this account");

  const { data: me } = await admin.from("profiles").select("full_name").eq("id", caller.id).maybeSingle();
  for (const userId of await userIdsWithRoles(admin, [...ADMIN_ROLES, "hr_manager"])) {
    if (userId === caller.id) continue;
    await notify(admin, { userId, type: "employee_joined", title: "New team member joined", content: `${me?.full_name ?? caller.email} accepted the invitation`, link: "#employees" });
  }
  await audit(admin, { userId: caller.id, action: "INVITATION_ACCEPTED", entityType: "profiles", entityId: caller.id }, req);
  return json(req, { success: true });
});
