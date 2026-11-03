// KITE SYSTEM — Edge Function: client-preview  (PUBLIC, no login)
//
// The client opens a private link (/preview.html#<token>). This function:
//   get          returns the presentation (never internal fields such as who publishes) with short-lived image links
//   feedback     saves a note / change request / approval for ONE page and alerts the team
//   approve_all  the client approves the whole plan
//
// Security: the token is a 192-bit random secret, can be switched off or expire, input is length-limited,
// and feedback is rate-limited per plan.

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { ADMIN_ROLES, adminClient, audit, notify, userIdsWithRoles } from "../_shared/auth.ts";
import { oneOf, optText, text, uuid } from "../_shared/validate.ts";

const ACTIONS = ["get", "feedback", "approve_all"] as const;
const KINDS = ["note", "change", "approve"] as const;
const MAX_FEEDBACK_PER_HOUR = 60;

serveJson(async (req) => {
  const body = await readJson(req, 16_384);
  const action = oneOf(body.action, ACTIONS, "action");
  const token = text(body.token, "token", 20, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new HttpError(404, "This link is not valid");

  const admin = adminClient();
  const { data: share } = await admin.from("content_plan_shares").select("plan_id, enabled, expires_at").eq("token", token).maybeSingle();
  if (!share || !share.enabled) throw new HttpError(404, "This link is not active any more. Please ask the studio for a new one.");
  if (share.expires_at && new Date(share.expires_at) < new Date()) throw new HttpError(410, "This link has expired. Please ask the studio for a new one.");

  const { data: plan } = await admin.from("content_plans")
    .select("*, clients(name, company_name)") // "*" so it keeps working before migration 013 adds the glow colours
    .eq("id", share.plan_id).maybeSingle();
  if (!plan) throw new HttpError(404, "This plan no longer exists");

  if (action === "get") {
    const [{ data: posts }, { data: assets }, { data: feedback }] = await Promise.all([
      admin.from("content_posts")
        .select("id, position, title, post_date, post_time, content_type, platform, pillar, objective, idea, caption, links")
        .eq("plan_id", plan.id).order("position", { ascending: true }),
      admin.from("content_post_assets")
        .select("id, post_id, storage_path, file_name, file_type, position, layout")
        .eq("plan_id", plan.id).order("position", { ascending: true }),
      admin.from("content_feedback")
        .select("id, post_id, slide_no, author_name, kind, message, resolved, created_at")
        .eq("plan_id", plan.id).order("created_at", { ascending: true }),
    ]);

    const list = assets ?? [];
    const signed = list.length
      ? (await admin.storage.from("studio-assets").createSignedUrls(list.map((a) => a.storage_path), 3600)).data ?? []
      : [];
    const urlByPath = new Map(signed.map((s: { path: string; signedUrl: string | null }) => [s.path, s.signedUrl]));

    const withUrl = list
      .map((a) => ({ id: a.id, postId: a.post_id, name: a.file_name, type: a.file_type, layout: a.layout ?? null, url: urlByPath.get(a.storage_path) ?? null }))
      .filter((a) => a.url);
    // deno-lint-ignore no-explicit-any
    const client = (plan as any).clients;

    return json(req, {
      success: true,
      plan: {
        title: plan.title, subtitle: plan.subtitle, direction: plan.direction, accent: plan.accent, accent2: plan.accent2 ?? null, accent3: plan.accent3 ?? null, status: plan.status,
        clientName: client?.company_name || client?.name || null,
      },
      cover: withUrl.find((a) => a.postId === null) ?? null,
      posts: (posts ?? []).map((p) => ({
        id: p.id, title: p.title, date: p.post_date, time: p.post_time, type: p.content_type, platform: p.platform,
        pillar: p.pillar, objective: p.objective, idea: p.idea, caption: p.caption, links: p.links ?? [],
        visuals: withUrl.filter((a) => a.postId === p.id),
      })),
      feedback: (feedback ?? []).map((f) => ({
        id: f.id, postId: f.post_id, slideNo: f.slide_no, author: f.author_name, kind: f.kind,
        message: f.message, resolved: f.resolved, at: f.created_at,
      })),
    });
  }

  // ---- feedback & approval -------------------------------------------------
  const author = text(body.name, "Your name", 2, 80);
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await admin.from("content_feedback").select("id", { count: "exact", head: true })
    .eq("plan_id", plan.id).gte("created_at", since);
  if ((count ?? 0) >= MAX_FEEDBACK_PER_HOUR) throw new HttpError(429, "Too many notes in a short time. Please try again in a little while.");

  let row: Record<string, unknown>;
  let alertTitle: string;
  let alertText: string;
  let postPublisher: string | null = null;

  if (action === "approve_all") {
    row = { plan_id: plan.id, author_name: author, kind: "approve_all", message: optText(body.message, "message", 1000) };
    await admin.from("content_plans").update({ status: "approved" }).eq("id", plan.id);
    alertTitle = "Client approved the plan";
    alertText = `${author} approved "${plan.title}".`;
  } else {
    const kind = oneOf(body.kind, KINDS, "kind");
    const message = kind === "approve" ? optText(body.message, "message", 1000) : text(body.message, "Your note", 2, 1000);
    const slideNo = Math.min(Math.max(Math.floor(Number(body.slideNo) || 0), 1), 500);
    let postId: string | null = null;
    let slideTitle: string | null = null;
    if (body.postId) {
      const { data: p } = await admin.from("content_posts").select("id, title, publisher_id")
        .eq("id", uuid(body.postId, "postId")).eq("plan_id", plan.id).maybeSingle();
      if (!p) throw new HttpError(400, "That page does not belong to this plan");
      postId = p.id; slideTitle = p.title; postPublisher = p.publisher_id;
    }
    row = { plan_id: plan.id, post_id: postId, slide_no: slideNo, slide_title: slideTitle, author_name: author, kind, message };
    if (kind === "change") await admin.from("content_plans").update({ status: "changes_requested" }).eq("id", plan.id);
    const where = `page ${slideNo}${slideTitle ? ` (${slideTitle})` : ""}`;
    alertTitle = kind === "change" ? "Client asked for an edit" : kind === "approve" ? "Client approved a page" : "New client note";
    alertText = `${author} on ${where} of "${plan.title}"${message ? `: ${message.slice(0, 140)}` : ""}`;
  }

  const { error } = await admin.from("content_feedback").insert(row);
  if (error) throw error;

  // alert: whoever made the plan, the person publishing that post, and the administrators
  const recipients = new Set<string>(await userIdsWithRoles(admin, ADMIN_ROLES));
  if (plan.created_by) recipients.add(plan.created_by);
  if (postPublisher) recipients.add(postPublisher);
  for (const userId of recipients) {
    await notify(admin, {
      userId, type: "content_feedback", title: alertTitle, content: alertText,
      link: `#campaigns?plan=${plan.id}`, metadata: { plan_id: plan.id },
    });
  }
  await audit(admin, { userId: null, action: "CONTENT_PLAN_CLIENT_FEEDBACK", entityType: "content_plans", entityId: plan.id, newData: { author, action } }, req);
  return json(req, { success: true });
});
