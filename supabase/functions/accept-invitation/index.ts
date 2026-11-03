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

  const { data: invitation } = await admin.from("invitations")
    .select("id, expires_at")
    .eq("email", caller.email.toLowerCase())
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!invitation) throw new HttpError(409, "No pending invitation for this account");
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    await admin.from("invitations").update({ status: "expired" }).eq("id", invitation.id);
    throw new HttpError(410, "This invitation has expired. Ask your administrator to invite you again.");
  }

  const { data: activated, error } = await admin.from("profiles")
    .update({ employment_status: "active" })
    .eq("id", caller.id).eq("employment_status", "onboarding")
    .select("id").maybeSingle();
  if (error) throw error;
  if (!activated) throw new HttpError(409, "Account is already active");

  await admin.from("invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", invitation.id);
  const { data: me } = await admin.from("profiles").select("full_name").eq("id", caller.id).maybeSingle();
  for (const userId of await userIdsWithRoles(admin, [...ADMIN_ROLES, "hr_manager"])) {
    if (userId === caller.id) continue;
    await notify(admin, { userId, type: "employee_joined", title: "New team member joined", content: `${me?.full_name ?? caller.email} accepted the invitation`, link: "#employees" });
  }
  await audit(admin, { userId: caller.id, action: "INVITATION_ACCEPTED", entityType: "profiles", entityId: caller.id }, req);
  return json(req, { success: true });
});
