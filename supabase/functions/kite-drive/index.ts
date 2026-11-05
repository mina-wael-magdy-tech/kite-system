// KITE SYSTEM — Edge Function: kite-drive
//
// Decides who may do what with a client's files on Kite Drive (the PHP site on Hostinger), then signs a
// short-lived token that the browser sends to Drive's API. Files never pass through here.
//
//   status       is this client linked, and what may the caller do?
//   token        a token for one client: read, write (upload), view (previews) or download (one file)
//   link.options the Drive clients available to link
//   link.set     link this client to a Drive client
//   link.create  create a new Drive account for this client and link it
//   link.remove  remove the link (no files are touched)
//
// Who: anyone who can see the client can browse and download; only admins can upload or change links.
// "Can see" is answered by the clients table's own RLS.
//
// Secrets: KITE_DRIVE_API_SECRET (also in Drive's api/config.php), KITE_DRIVE_URL (https://…, no trailing slash).

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, audit, Caller, getCaller, requireStaff, userClient } from "../_shared/auth.ts";
import { email, oneOf, text, uuid } from "../_shared/validate.ts";

const ACTIONS = ["status", "token", "link.options", "link.set", "link.create", "link.remove", "link.account", "link.update"] as const;
const SCOPES = ["read", "write", "download", "view"] as const;
type Scope = (typeof SCOPES)[number] | "admin";

const TOKEN_SECONDS: Record<Scope, number> = { admin: 300, read: 600, write: 1800, download: 120, view: 600 };

function driveConfig(): { url: string; secret: string } {
  const url = (Deno.env.get("KITE_DRIVE_URL") ?? "").replace(/\/+$/, "");
  const secret = Deno.env.get("KITE_DRIVE_API_SECRET") ?? "";
  if (!/^https:\/\//.test(url) || secret.length < 32) throw new HttpError(503, "Kite Drive isn't set up yet");
  return { url, secret };
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signToken(
  secret: string,
  callerId: string,
  scope: Scope,
  driveUserId: number | null,
  fileId?: number,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_SECONDS[scope];
  const claims = { aud: "kite-drive", sub: callerId, scope, cid: driveUserId, ...(fileId ? { fid: fileId } : {}), iat, exp };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return { token: `${payload}.${toBase64Url(signature)}`, expiresAt: exp };
}

/** Admin rights on Drive links. "ceo" sees all clients under migration 015 but isn't in ADMIN_ROLES. */
const isDriveAdmin = (c: Caller) => c.isAdmin || c.has("ceo");

/** RLS answers this as the caller, so department scoping can't drift from the rest of the app. */
async function visibleClient(caller: Caller, clientId: string) {
  const { data } = await userClient(caller.token).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!data) throw new HttpError(404, "Client not found");
}

function positiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new HttpError(400, `${field} must be a valid id`);
  return v;
}

async function driveClients(caller: Caller): Promise<{ id: number; name: string; email: string }[]> {
  const { url, secret } = driveConfig();
  const { token } = await signToken(secret, caller.id, "admin", null);
  let res: Response;
  try {
    res = await fetch(`${url}/api/index.php?action=clients`, { headers: { "X-Drive-Token": token } });
  } catch (err) {
    console.error("Kite Drive unreachable:", err);
    throw new HttpError(502, "Couldn't reach Kite Drive");
  }
  if (!res.ok) {
    console.error("Kite Drive clients failed:", res.status);
    throw new HttpError(502, "Kite Drive refused the request");
  }
  return (await res.json()).clients;
}

serveJson(async (req) => {
  const body = await readJson(req);
  const action = oneOf(body.action, ACTIONS, "action");
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  requireStaff(caller);

  if (action === "link.options") {
    if (!isDriveAdmin(caller)) throw new HttpError(403, "Only admins can link Kite Drive accounts");
    const [clients, { data: links }] = await Promise.all([
      driveClients(caller),
      admin.from("client_drive_links").select("drive_user_id"),
    ]);
    const taken = new Set((links ?? []).map((l: { drive_user_id: number }) => l.drive_user_id));
    return json(req, { success: true, clients: clients.filter((c) => !taken.has(c.id)) });
  }

  const clientId = uuid(body.clientId, "clientId");
  await visibleClient(caller, clientId);
  const canUpload = isDriveAdmin(caller);
  const { data: link } = await admin.from("client_drive_links").select("drive_user_id, drive_name").eq("client_id", clientId).maybeSingle();

  if (action === "status") {
    const url = (Deno.env.get("KITE_DRIVE_URL") ?? "").replace(/\/+$/, "");
    return json(req, {
      success: true,
      configured: Boolean(url && Deno.env.get("KITE_DRIVE_API_SECRET")),
      linked: Boolean(link),
      driveName: link?.drive_name ?? null,
      driveUrl: url || null,
      canUpload,
      canLink: isDriveAdmin(caller),
    });
  }

  if (action === "token") {
    if (!link) throw new HttpError(409, "This client isn't linked to Kite Drive");
    const scope = oneOf(body.scope, SCOPES, "scope");
    if (scope === "write" && !canUpload) throw new HttpError(403, "Only admins can upload to Kite Drive");
    const fileId = scope === "download" ? positiveInt(body.fileId, "fileId") : undefined;
    const { url, secret } = driveConfig();
    const signed = await signToken(secret, caller.id, scope, link.drive_user_id, fileId);
    return json(req, { success: true, apiUrl: `${url}/api/index.php`, ...signed });
  }

  // ---- changing a link -------------------------------------------------------
  if (!isDriveAdmin(caller)) throw new HttpError(403, "Only admins can link Kite Drive accounts");

  // The client's Drive login: read it (never the password, Drive only keeps a hash), or change email / name / password.
  if (action === "link.account" || action === "link.update") {
    if (!link) throw new HttpError(409, "This client isn't linked to Kite Drive");
    const { url, secret } = driveConfig();
    const { token } = await signToken(secret, caller.id, "admin", null);
    const headers = { "X-Drive-Token": token, "Content-Type": "application/json" };
    let res: Response;
    try {
      res = action === "link.account"
        ? await fetch(`${url}/api/index.php?action=client_account&id=${link.drive_user_id}`, { headers })
        : await fetch(`${url}/api/index.php?action=update_client`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: link.drive_user_id,
            ...(typeof body.name === "string" && body.name.trim() ? { name: text(body.name, "Name", 1, 120) } : {}),
            ...(typeof body.email === "string" && body.email.trim() ? { email: email(body.email) } : {}),
            ...(typeof body.password === "string" && body.password ? { password: text(body.password, "Password", 8, 128) } : {}),
          }),
        });
    } catch (err) {
      console.error("Kite Drive unreachable:", err);
      throw new HttpError(502, "Couldn't reach Kite Drive");
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 404 && out.error === "Unknown action") throw new HttpError(502, "Kite Drive needs its latest update before accounts can be edited");
    if (!res.ok) throw new HttpError([400, 404, 409].includes(res.status) ? res.status : 502, out.error ?? "Kite Drive refused the request");
    if (action === "link.account") return json(req, { success: true, name: out.name, email: out.email });
    if (typeof out.name === "string" && out.name !== link.drive_name) {
      await admin.from("client_drive_links").update({ drive_name: out.name }).eq("client_id", clientId);
    }
    // what changed, never the new password
    await audit(admin, { userId: caller.id, action: "kite_drive.account_update", entityType: "client", entityId: clientId, newData: { drive_user_id: link.drive_user_id, changed: out.changed ?? [] } }, req);
    return json(req, { success: true, name: out.name, email: out.email, changed: out.changed ?? [] });
  }

  if (action === "link.remove") {
    const { error } = await admin.from("client_drive_links").delete().eq("client_id", clientId);
    if (error) throw error;
    await audit(admin, { userId: caller.id, action: "kite_drive.unlink", entityType: "client", entityId: clientId, oldData: link }, req);
    return json(req, { success: true });
  }

  let match: { id: number; name: string } | undefined;
  if (action === "link.create") {
    if (link) throw new HttpError(409, "This client is already linked to Kite Drive");
    const account = {
      name: text(body.name, "Name", 1, 120),
      email: email(body.email),
      password: text(body.password, "Password", 8, 128),
    };
    const { url, secret } = driveConfig();
    const { token } = await signToken(secret, caller.id, "admin", null);
    const res = await fetch(`${url}/api/index.php?action=create_client`, {
      method: "POST",
      headers: { "X-Drive-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(account),
    });
    const created = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status === 409 || res.status === 400 ? res.status : 502, created.error ?? "Kite Drive refused the request");
    match = { id: created.id, name: created.name };
  } else {
    const wanted = positiveInt(body.driveUserId, "driveUserId");
    match = (await driveClients(caller)).find((c) => c.id === wanted);
    if (!match) throw new HttpError(404, "That Kite Drive account no longer exists");
  }
  const driveUserId = match.id;
  const { error } = await admin.from("client_drive_links").upsert({
    client_id: clientId, drive_user_id: driveUserId, drive_name: match.name, linked_by: caller.id, linked_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "That Kite Drive account is already linked to another client");
    throw error;
  }
  await audit(admin, { userId: caller.id, action: "kite_drive.link", entityType: "client", entityId: clientId, oldData: link, newData: { drive_user_id: driveUserId, drive_name: match.name } }, req);
  return json(req, { success: true, driveName: match.name });
});
