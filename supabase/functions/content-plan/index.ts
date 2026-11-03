// KITE SYSTEM — Edge Function: content-plan  (signed-in staff)
//
// Server-side rules for content plans (feed calendars):
//   share.get | share.enable | share.disable   the private client link (the token never reaches the browser otherwise)
//   post.assign                                 choose who publishes a post, and tell them
//   post.changed                                tell the publisher the date / details moved
//   post.publish                                the publisher marks it live (and tells the team)

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, audit, getCaller, notify, requireStaff, userClient } from "../_shared/auth.ts";
import { oneOf, optText, uuid } from "../_shared/validate.ts";

const ACTIONS = ["share.get", "share.enable", "share.disable", "post.assign", "post.changed", "post.publish"] as const;

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const fmtDate = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toUTCString().slice(0, 16) : "no date yet");

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  requireStaff(caller);
  const body = await readJson(req);
  const action = oneOf(body.action, ACTIONS, "action");
  const asUser = userClient(caller.token);

  // Does RLS let this person edit the plan? (same rule as the database: admin, creator or department member)
  async function requireEditor(planId: string) {
    const { data, error } = await asUser.rpc("auth_can_edit_plan", { p_plan_id: planId });
    if (error) throw new HttpError(500, "Could not check your permission");
    if (!data) throw new HttpError(403, "Only the plan's department, its creator or an administrator can do this");
  }

  // deno-lint-ignore no-explicit-any
  async function loadPost(postId: string): Promise<any> {
    const { data: post } = await admin.from("content_posts")
      .select("id, plan_id, title, post_date, post_time, publisher_id, status, content_plans(id, title, created_by)")
      .eq("id", postId).maybeSingle();
    if (!post) throw new HttpError(404, "Post not found");
    return post;
  }

  if (action.startsWith("share.")) {
    const planId = uuid(body.planId, "planId");
    await requireEditor(planId);
    const { data: share } = await admin.from("content_plan_shares").select("*").eq("plan_id", planId).maybeSingle();

    if (action === "share.get") {
      return json(req, {
        success: true,
        share: share ? { token: share.token, enabled: share.enabled, expiresAt: share.expires_at } : null,
      });
    }

    if (action === "share.disable") {
      if (share) await admin.from("content_plan_shares").update({ enabled: false }).eq("plan_id", planId);
      await audit(admin, { userId: caller.id, action: "CONTENT_PLAN_UNSHARED", entityType: "content_plans", entityId: planId }, req);
      return json(req, { success: true, share: share ? { token: share.token, enabled: false, expiresAt: share.expires_at } : null });
    }

    // share.enable — keeps the same link unless asked for a fresh one
    const days = Math.min(Math.max(Number(body.days) || 0, 0), 365);
    const fresh = body.regenerate === true || !share;
    const token = fresh ? newToken() : share!.token;
    const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    const { error } = await admin.from("content_plan_shares")
      .upsert({ plan_id: planId, token, enabled: true, expires_at: expiresAt }, { onConflict: "plan_id" });
    if (error) throw error;
    await admin.from("content_plans").update({ status: "in_review" }).eq("id", planId).in("status", ["draft", "changes_requested"]);
    await audit(admin, { userId: caller.id, action: "CONTENT_PLAN_SHARED", entityType: "content_plans", entityId: planId, newData: { days, fresh } }, req);
    return json(req, { success: true, share: { token, enabled: true, expiresAt } });
  }

  const post = await loadPost(uuid(body.postId, "postId"));
  const plan = post.content_plans;

  if (action === "post.assign") {
    await requireEditor(post.plan_id);
    const publisherId = body.publisherId ? uuid(body.publisherId, "publisherId") : null;
    if (publisherId) {
      const { data: p } = await admin.from("profiles").select("id").eq("id", publisherId).eq("employment_status", "active").maybeSingle();
      if (!p) throw new HttpError(400, "That person is not an active team member");
    }
    const { error } = await admin.from("content_posts").update({ publisher_id: publisherId }).eq("id", post.id);
    if (error) throw error;
    if (publisherId && publisherId !== caller.id) {
      await notify(admin, {
        userId: publisherId, type: "content_publish",
        title: "You're publishing a post",
        content: `"${post.title}" in ${plan.title} — ${fmtDate(post.post_date)}${post.post_time ? " at " + String(post.post_time).slice(0, 5) : ""}.`,
        link: `#campaigns?plan=${post.plan_id}`,
        metadata: { plan_id: post.plan_id, post_id: post.id },
      });
    }
    return json(req, { success: true });
  }

  if (action === "post.changed") {
    await requireEditor(post.plan_id);
    if (post.publisher_id && post.publisher_id !== caller.id) {
      await notify(admin, {
        userId: post.publisher_id, type: "content_publish",
        title: "A post you publish was updated",
        content: `"${post.title}" is now planned for ${fmtDate(post.post_date)}${post.post_time ? " at " + String(post.post_time).slice(0, 5) : ""}.`,
        link: `#campaigns?plan=${post.plan_id}`,
        metadata: { plan_id: post.plan_id, post_id: post.id },
      });
    }
    return json(req, { success: true });
  }

  // post.publish — the assigned publisher or an editor
  const { data: can } = await asUser.rpc("auth_can_edit_plan", { p_plan_id: post.plan_id });
  if (!can && post.publisher_id !== caller.id) throw new HttpError(403, "Only the assigned publisher or the plan's team can do this");
  const url = optText(body.publishedUrl, "publishedUrl", 500);
  if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, "The published link must start with http:// or https://");
  const { error } = await admin.from("content_posts")
    .update({ status: "published", published_url: url, published_at: new Date().toISOString() }).eq("id", post.id);
  if (error) throw error;
  if (plan.created_by && plan.created_by !== caller.id) {
    await notify(admin, {
      userId: plan.created_by, type: "content_published",
      title: "A post went live",
      content: `"${post.title}" in ${plan.title} was published.`,
      link: `#campaigns?plan=${post.plan_id}`,
      metadata: { plan_id: post.plan_id, post_id: post.id },
    });
  }
  return json(req, { success: true });
});
