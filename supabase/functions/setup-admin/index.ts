// PULSE STUDIO OS — Edge Function: setup-admin  (ONE-TIME BOOTSTRAP)
//
// Creates the first super administrator. Hardened so that exposing it on the
// internet is not enough to take over the system:
//   * requires the SETUP_TOKEN secret in the `x-setup-token` header
//   * an atomic database lock (unique key) makes concurrent calls safe
//   * refuses to run if any super_admin already exists
//   * rolls back completely on failure
//
// After first use: `supabase functions delete setup-admin` and
// `supabase secrets unset SETUP_TOKEN`.

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, audit } from "../_shared/auth.ts";
import * as v from "../_shared/validate.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

serveJson(async (req) => {
  const expected = Deno.env.get("SETUP_TOKEN") ?? "";
  if (expected.length < 32) {
    throw new HttpError(503, "Setup is disabled: SETUP_TOKEN secret (min 32 chars) is not configured");
  }
  if (!timingSafeEqual(req.headers.get("x-setup-token") ?? "", expected)) {
    throw new HttpError(403, "Invalid setup token");
  }

  const b = await readJson(req);
  const email = v.email(b.email);
  const password = v.password(b.password);
  const fullName = v.text(b.fullName, "fullName", 2, 120);
  const companyName = v.optText(b.companyName, "companyName", 120);

  const admin = adminClient();

  // Atomic lock: the unique `key` guarantees only one caller ever proceeds.
  const { error: lockErr } = await admin.from("company_settings")
    .insert({ key: "setup_lock", value: { started_at: new Date().toISOString() } });
  if (lockErr) throw new HttpError(403, "System is already initialized");

  let userId: string | null = null;
  try {
    const { count } = await admin.from("user_roles")
      .select("id, roles!inner(name)", { count: "exact", head: true })
      .eq("roles.name", "super_admin");
    if ((count ?? 0) > 0) throw new HttpError(403, "A super administrator already exists");

    const { data: role } = await admin.from("roles").select("id").eq("name", "super_admin").single();
    if (!role) throw new Error("super_admin role is missing — run seed.sql first");

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (createErr || !created?.user) throw new HttpError(400, "Could not create the administrator account");
    userId = created.user.id;

    const { error: pErr } = await admin.from("profiles").insert({
      id: userId, full_name: fullName, email, job_title: "Studio Founder & Administrator",
      employment_status: "active", is_first_admin: true,
    });
    if (pErr) throw pErr;

    const { error: rErr } = await admin.from("user_roles").insert({ user_id: userId, role_id: role.id });
    if (rErr) throw rErr;

    if (companyName) {
      const { error } = await admin.from("company_settings").upsert({
        key: "company_info",
        value: { name: companyName, tagline: "Creative Agency Operating System", currency: "USD" },
      }, { onConflict: "key" });
      if (error) throw error;
    }

    await admin.from("company_settings")
      .update({ value: { completed_at: new Date().toISOString() } }).eq("key", "setup_lock");
    await audit(admin, { userId, action: "SYSTEM_INITIALIZED", entityType: "profiles", entityId: userId }, req);
    return json(req, { success: true, message: "First administrator created. Delete this function and unset SETUP_TOKEN." });
  } catch (err) {
    // Roll back: release the lock and remove any partial user.
    if (userId) await admin.auth.admin.deleteUser(userId);
    await admin.from("company_settings").delete().eq("key", "setup_lock");
    throw err;
  }
});
