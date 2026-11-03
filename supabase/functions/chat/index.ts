// KITE SYSTEM — Edge Function: chat
// Slack-style administration of channels, group chats, DMs and messages.
//
//   channel.create   admin   { name, description?, isPublic, memberIds[] }
//   channel.update   admin   { id, name, description?, isPublic }
//   channel.members  admin   { id, memberIds[] }           (replaces the member list)
//   channel.archive  admin   { id, archived }
//   channel.delete   admin   { id }
//   dm.create        staff   { userId }                      (returns the existing DM if any)
//   message.send    staff   { conversationId, content, messageType?, metadata? }  (notifies the other members)
//   message.edit     author  { id, content }
//   message.delete   author or admin { id }
//
// Privilege rules are enforced here, not in the browser.

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, audit, Caller, getCaller, notify, requireStaff, userClient } from "../_shared/auth.ts";
import * as v from "../_shared/validate.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  requireStaff(caller);
  const b = await readJson(req);

  switch (b.action) {
    case "channel.create": return json(req, await channelCreate(req, admin, caller, b));
    case "channel.update": return json(req, await channelUpdate(req, admin, caller, b));
    case "channel.members": return json(req, await channelMembers(admin, caller, b));
    case "channel.archive": return json(req, await channelArchive(req, admin, caller, b));
    case "channel.delete": return json(req, await channelDelete(req, admin, caller, b));
    case "dm.create": return json(req, await dmCreate(admin, caller, b));
    case "message.send": return json(req, await messageSend(admin, caller, b));
    case "message.edit": return json(req, await messageEdit(admin, caller, b));
    case "message.delete": return json(req, await messageDelete(req, admin, caller, b));
    default: throw new HttpError(400, "Unknown action");
  }
});

function requireAdmin(c: Caller) {
  if (!c.isAdmin) throw new HttpError(403, "Only an admin, CEO or general manager can manage channels");
}

/** Validates a list of user ids: they must exist and be active staff. */
async function validMembers(admin: SupabaseClient, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "memberIds must be a list");
  const ids = [...new Set(raw.map((x) => v.uuid(x, "memberIds")))];
  if (ids.length > 500) throw new HttpError(400, "Too many members");
  if (ids.length) {
    const { data } = await admin.from("profiles").select("id").in("id", ids).eq("employment_status", "active");
    if ((data?.length ?? 0) !== ids.length) throw new HttpError(400, "Some selected people are not active employees");
  }
  return ids;
}

async function loadChannel(admin: SupabaseClient, id: string) {
  const { data } = await admin.from("conversations").select("id, type, name, is_public, is_archived, created_by").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Channel not found");
  return data;
}

async function channelCreate(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  requireAdmin(caller);
  const name = v.text(b.name, "name", 2, 60);
  const description = v.optText(b.description, "description", 300);
  const isPublic = b.isPublic === true;
  const members = await validMembers(admin, b.memberIds);

  const { data: convo, error } = await admin.from("conversations").insert({
    type: "group", name, description, is_public: isPublic, created_by: caller.id,
  }).select("id").single();
  if (error || !convo) throw new HttpError(500, "Could not create the channel");

  const all = [...new Set([caller.id, ...members])];
  const { error: mErr } = await admin.from("conversation_members").insert(
    all.map((uid) => ({ conversation_id: convo.id, user_id: uid, role: uid === caller.id ? "admin" : "member" })),
  );
  if (mErr) {
    await admin.from("conversations").delete().eq("id", convo.id);
    throw new HttpError(500, "Could not add members to the channel");
  }
  await audit(admin, { userId: caller.id, action: "CHANNEL_CREATED", entityType: "conversations", entityId: convo.id, newData: { name, isPublic } }, req);
  return { success: true, id: convo.id };
}

async function channelUpdate(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  requireAdmin(caller);
  const id = v.uuid(b.id, "id");
  const ch = await loadChannel(admin, id);
  if (ch.type === "direct") throw new HttpError(400, "Direct messages cannot be edited");
  const patch = {
    name: v.text(b.name, "name", 2, 60),
    description: v.optText(b.description, "description", 300),
    is_public: b.isPublic === true,
  };
  const { error } = await admin.from("conversations").update(patch).eq("id", id);
  if (error) throw new HttpError(500, "Could not update the channel");
  await audit(admin, { userId: caller.id, action: "CHANNEL_UPDATED", entityType: "conversations", entityId: id, oldData: { name: ch.name, isPublic: ch.is_public }, newData: patch }, req);
  return { success: true };
}

async function channelMembers(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  requireAdmin(caller);
  const id = v.uuid(b.id, "id");
  const ch = await loadChannel(admin, id);
  if (ch.type === "direct") throw new HttpError(400, "Direct messages have a fixed pair of people");
  const wanted = new Set(await validMembers(admin, b.memberIds));

  const { data: current } = await admin.from("conversation_members").select("user_id").eq("conversation_id", id);
  const have = new Set((current ?? []).map((r: { user_id: string }) => r.user_id));

  const toAdd = [...wanted].filter((u) => !have.has(u));
  const toRemove = [...have].filter((u) => !wanted.has(u));
  if (toAdd.length) {
    const { error } = await admin.from("conversation_members").insert(toAdd.map((u) => ({ conversation_id: id, user_id: u, role: "member" })));
    if (error) throw new HttpError(500, "Could not add members");
  }
  if (toRemove.length) {
    const { error } = await admin.from("conversation_members").delete().eq("conversation_id", id).in("user_id", toRemove);
    if (error) throw new HttpError(500, "Could not remove members");
  }
  return { success: true, added: toAdd.length, removed: toRemove.length };
}

async function channelArchive(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  requireAdmin(caller);
  const id = v.uuid(b.id, "id");
  await loadChannel(admin, id);
  const archived = b.archived !== false;
  const { error } = await admin.from("conversations").update({ is_archived: archived }).eq("id", id);
  if (error) throw new HttpError(500, "Could not update the channel");
  await audit(admin, { userId: caller.id, action: archived ? "CHANNEL_ARCHIVED" : "CHANNEL_RESTORED", entityType: "conversations", entityId: id }, req);
  return { success: true };
}

async function channelDelete(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  requireAdmin(caller);
  const id = v.uuid(b.id, "id");
  const ch = await loadChannel(admin, id);
  const { error } = await admin.from("conversations").delete().eq("id", id); // cascades to members + messages
  if (error) throw new HttpError(500, "Could not delete the channel");
  await audit(admin, { userId: caller.id, action: "CHANNEL_DELETED", entityType: "conversations", entityId: id, oldData: { name: ch.name } }, req);
  return { success: true };
}

async function dmCreate(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const userId = v.uuid(b.userId, "userId");
  if (userId === caller.id) throw new HttpError(400, "You cannot message yourself");
  const [other] = await validMembers(admin, [userId]);
  if (!other) throw new HttpError(400, "Unknown user");

  // existing DM between exactly these two people?
  const { data: mine } = await admin.from("conversation_members").select("conversation_id, conversations!inner(type)").eq("user_id", caller.id).eq("conversations.type", "direct");
  const ids = (mine ?? []).map((r: { conversation_id: string }) => r.conversation_id);
  if (ids.length) {
    const { data: theirs } = await admin.from("conversation_members").select("conversation_id").eq("user_id", userId).in("conversation_id", ids);
    if (theirs?.length) return { success: true, id: theirs[0].conversation_id, existing: true };
  }

  const { data: convo, error } = await admin.from("conversations").insert({ type: "direct", is_public: false, created_by: caller.id }).select("id").single();
  if (error || !convo) throw new HttpError(500, "Could not start the conversation");
  const { error: mErr } = await admin.from("conversation_members").insert([
    { conversation_id: convo.id, user_id: caller.id, role: "member" },
    { conversation_id: convo.id, user_id: userId, role: "member" },
  ]);
  if (mErr) {
    await admin.from("conversations").delete().eq("id", convo.id);
    throw new HttpError(500, "Could not start the conversation");
  }
  return { success: true, id: convo.id };
}

async function messageEdit(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const id = v.uuid(b.id, "id");
  const content = v.text(b.content, "content", 1, 4000);
  const { data: m } = await admin.from("messages").select("id, sender_id, message_type, conversation_id").eq("id", id).maybeSingle();
  if (!m) throw new HttpError(404, "Message not found");
  if (m.sender_id !== caller.id) throw new HttpError(403, "You can only edit your own messages");
  if (m.message_type !== "text") throw new HttpError(400, "This message cannot be edited");
  const { error } = await admin.from("messages").update({ content, is_edited: true }).eq("id", id);
  if (error) throw new HttpError(500, "Could not edit the message");
  return { success: true };
}

async function messageDelete(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const id = v.uuid(b.id, "id");
  const { data: m } = await admin.from("messages").select("id, sender_id, conversation_id").eq("id", id).maybeSingle();
  if (!m) throw new HttpError(404, "Message not found");
  if (m.sender_id !== caller.id && !caller.isAdmin) throw new HttpError(403, "You can only delete your own messages");
  const { error } = await admin.from("messages").delete().eq("id", id);
  if (error) throw new HttpError(500, "Could not delete the message");
  if (m.sender_id !== caller.id) {
    await audit(admin, { userId: caller.id, action: "MESSAGE_DELETED_BY_ADMIN", entityType: "messages", entityId: id }, req);
  }
  return { success: true };
}

const MESSAGE_SELECT = "*, sender:profiles!messages_sender_id_fkey(id, full_name, avatar_url)";

async function messageSend(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const conversationId = v.uuid(b.conversationId, "conversationId");
  const content = v.text(b.content, "content", 1, 4000);
  const messageType = b.messageType === "task_handoff" ? "task_handoff" : "text";
  const metadata = messageType === "task_handoff" && b.metadata && typeof b.metadata === "object" ? b.metadata : {};

  // Insert AS the caller so the row-level policy decides whether they may post here.
  const { data: msg, error } = await userClient(caller.token).from("messages").insert({
    conversation_id: conversationId, sender_id: caller.id, content, message_type: messageType, metadata,
  }).select(MESSAGE_SELECT).single();
  if (error || !msg) throw new HttpError(403, "You cannot post in this conversation");

  // ---- notify the other members (in-app + push)
  const { data: convo } = await admin.from("conversations").select("id, type, name").eq("id", conversationId).single();
  const { data: members } = await admin.from("conversation_members").select("user_id").eq("conversation_id", conversationId);
  const sender = msg.sender?.full_name ?? "Someone";
  const preview = messageType === "task_handoff" ? `📌 ${content}` : (content.length > 110 ? content.slice(0, 107) + "…" : content);
  const isDirect = convo?.type === "direct";

  const recipients = (members ?? []).map((m: { user_id: string }) => m.user_id).filter((id: string) => id !== caller.id);
  if (recipients.length) {
    const { data: active } = await admin.from("profiles").select("id").in("id", recipients).eq("employment_status", "active");
    const activeIds = (active ?? []).map((p: { id: string }) => p.id);

    // channels: one unread alert per conversation is enough (avoids a flood while people are chatting)
    const alreadyAlerted = new Set<string>();
    if (!isDirect && activeIds.length) {
      const { data: unread } = await admin.from("notifications").select("user_id")
        .in("user_id", activeIds).eq("type", "chat_message").eq("is_read", false)
        .eq("metadata->>conversation_id", conversationId)
        .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
      (unread ?? []).forEach((r: { user_id: string }) => alreadyAlerted.add(r.user_id));
    }

    for (const userId of activeIds) {
      if (alreadyAlerted.has(userId)) continue;
      await notify(admin, {
        userId, type: "chat_message",
        title: isDirect ? sender : `${sender} in # ${convo?.name ?? "channel"}`,
        content: preview,
        link: `#chat?c=${conversationId}`,
        metadata: { conversation_id: conversationId },
      });
    }
  }
  return { success: true, message: msg };
}
