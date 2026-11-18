// KITE SYSTEM — Edge Function: broadcast
//
// The owner / CEO sends an announcement to employees (in-app notification + push).
//   send      { title, message, audience: all|department|role|people, departmentIds?, roles?, userIds?, link? }
//   history   the last announcements
//
// Authorization is checked HERE from the server-side roles (never from the browser).
// Limits: 10 announcements per hour per sender; title <= 80, message <= 600 characters.

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, audit, getCaller, notify, userIdsWithRoles } from "../_shared/auth.ts";
import { oneOf, text, uuid } from "../_shared/validate.ts";

const SENDER_ROLES = ["owner", "ceo", "super_admin"];
const AUDIENCES = ["all", "department", "role", "people"] as const;
const ACTIONS = ["send", "history"] as const;
const MAX_PER_HOUR = 10;
const MAX_LIST = 200;
// only links inside the app are allowed, e.g. #tasks or #hr
const LINK_RE = /^#[a-z]{2,24}(\?[A-Za-z0-9=&_-]{0,100})?$/;

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  if (!SENDER_ROLES.some((r) => caller.has(r))) throw new HttpError(403, "Only the owner or CEO can send announcements");

  const body = await readJson(req, 16_384);
  const action = oneOf(body.action, ACTIONS, "action");

  if (action === "history") {
    const { data, error } = await admin.from("broadcasts")
      .select("id, title, message, audience_type, audience_label, recipient_count, created_at, sender:profiles!broadcasts_sender_id_fkey(full_name)")
      .order("created_at", { ascending: false }).limit(30);
    if (error) throw new HttpError(500, "History is not available yet. Run migration 014 first.");
    return json(req, { success: true, items: data ?? [] });
  }

  const title = text(body.title, "Title", 2, 80);
  const message = text(body.message, "Message", 2, 600);
  const audience = oneOf(body.audience, AUDIENCES, "audience");
  let link: string | null = null;
  if (body.link) {
    link = text(body.link, "link", 2, 140);
    if (!LINK_RE.test(link)) throw new HttpError(400, "link must be a page inside the app");
  }

  // rate limit
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await admin.from("broadcasts").select("id", { count: "exact", head: true })
    .eq("sender_id", caller.id).gte("created_at", since);
  if ((count ?? 0) >= MAX_PER_HOUR) throw new HttpError(429, "You sent several announcements in the last hour. Please wait a little.");

  // ---- who receives it
  let ids: string[] = [];
  let label = "Everyone";
  if (audience === "all") {
    const { data } = await admin.from("profiles").select("id").eq("employment_status", "active");
    ids = (data ?? []).map((p: { id: string }) => p.id);
  } else if (audience === "department") {
    const deptIds = list(body.departmentIds, "departmentIds").map((d) => uuid(d, "department"));
    const [{ data: viaProfile }, { data: viaJunction }, { data: depts }] = await Promise.all([
      admin.from("profiles").select("id").in("department_id", deptIds).eq("employment_status", "active"),
      admin.from("user_departments").select("user_id").in("department_id", deptIds),
      admin.from("departments").select("name").in("id", deptIds),
    ]);
    const candidate = new Set<string>([
      ...(viaProfile ?? []).map((p: { id: string }) => p.id),
      ...(viaJunction ?? []).map((p: { user_id: string }) => p.user_id),
    ]);
    ids = await onlyActive(admin, [...candidate]);
    label = (depts ?? []).map((d: { name: string }) => d.name).join(", ") || "Department";
  } else if (audience === "role") {
    const roles = list(body.roles, "roles").map((r) => text(r, "role", 2, 40));
    ids = await userIdsWithRoles(admin, roles);
    label = roles.join(", ");
  } else {
    const people = list(body.userIds, "userIds").map((u) => uuid(u, "person"));
    ids = await onlyActive(admin, people);
    label = `${ids.length} selected`;
  }

  ids = [...new Set(ids)].filter((id) => id !== caller.id);
  if (!ids.length) throw new HttpError(400, "No active employees match that audience");

  // Claim the send FIRST (migration 032): the same requestId can only be recorded once, so a double click / retry never notifies twice.
  const requestId = body.requestId === undefined || body.requestId === null || body.requestId === "" ? null : uuid(body.requestId, "requestId");
  // One atomic claim (migration 037). A repeated request id with the same sender and content RESUMES an unfinished broadcast: every
  // notification carries the key broadcast:<id>, so people who already received it are skipped. If the claim cannot be made we stop:
  // sending without a claim would be unrecoverable and could duplicate.
  const { data: claimRows, error: claimErr } = await admin.rpc("broadcast_claim", {
    p_sender: caller.id, p_title: title, p_message: message, p_link: link, p_audience_type: audience, p_label: label, p_request: requestId,
  });
  const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (claimErr || !claim?.broadcast_id) {
    console.error("broadcast claim failed:", claimErr?.message);
    throw new HttpError(500, "The announcement could not be recorded, so it was not sent. Please try again.");
  }
  if (claim.state === "conflict") throw new HttpError(409, "This request id was already used for a different announcement");
  if (claim.state === "done") {
    const { data: prev } = await admin.from("broadcasts").select("recipient_count").eq("id", claim.broadcast_id).maybeSingle();
    return json(req, { success: true, duplicate: true, status: "sent", recipients: prev?.recipient_count ?? 0 });
  }

  const dedupeKey = `broadcast:${claim.broadcast_id}`;
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map((userId) =>
      notify(admin, { userId, type: "announcement", title, content: message, link: link ?? undefined, metadata: { sender_id: caller.id }, dedupeKey })
    ));
  }
  // the notification rows are the truth: this counts them and closes the broadcast (safe to repeat)
  const { data: delivered, error: finErr } = await admin.rpc("broadcast_finish", { p_id: claim.broadcast_id });
  if (finErr) {
    console.error("broadcast finish failed:", finErr.message);
    throw new HttpError(500, "The announcement was delivered but could not be closed. Send the same request again to finish it.");
  }
  await audit(admin, { userId: caller.id, action: "BROADCAST_SENT", entityType: "broadcasts", newData: { audience, label, count: delivered, intended: ids.length, title, resumed: claim.state === "resume" } }, req);
  return json(req, { success: true, recipients: delivered, ...(claim.state === "resume" ? { resumed: true } : {}) });
});

function list(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, `Choose at least one (${field})`);
  if (v.length > MAX_LIST) throw new HttpError(400, `Too many entries in ${field}`);
  return v;
}

async function onlyActive(admin: ReturnType<typeof adminClient>, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { data } = await admin.from("profiles").select("id").in("id", ids).eq("employment_status", "active");
  return (data ?? []).map((p: { id: string }) => p.id);
}
