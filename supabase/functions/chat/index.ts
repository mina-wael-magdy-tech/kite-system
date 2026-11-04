// KITE SYSTEM — Edge Function: chat
// Slack-style administration of channels, group chats, DMs and messages.
//
//   channel.create   admin   { name, description?, isPublic, memberIds[] }
//   channel.update   admin   { id, name, description?, isPublic }
//   channel.members  admin   { id, memberIds[] }           (replaces the member list)
//   channel.archive  admin   { id, archived }
//   channel.delete   admin   { id }
//   dm.create        staff   { userId }                      (returns the existing DM if any)
//   message.send    staff   { conversationId, content, messageType?, metadata?, replyToId? }  (notifies the other members)
//                           messageType: text | task_handoff | voice | image | file  (voice/image/file carry metadata.path in chat-media)
//   reaction.toggle  staff   { messageId, emoji }
//   call.start       staff   { conversationId, kind: "video"|"audio" }   (posts a call card and rings the other members)
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
    case "reaction.toggle": return json(req, await reactionToggle(caller, admin, b));
    case "call.start": return json(req, await callStart(admin, caller, b));
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
  if (toAdd.length || toRemove.length) {
    await audit(admin, { userId: caller.id, action: "CHANNEL_MEMBERS_CHANGED", entityType: "conversations", entityId: id, newData: { added: toAdd, removed: toRemove } });
  }
  return { success: true, added: toAdd.length, removed: toRemove.length };
}

async function channelArchive(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  requireAdmin(caller);
  const id = v.uuid(b.id, "id");
  const ch0 = await loadChannel(admin, id);
  if (ch0.type === "direct") throw new HttpError(400, "Direct messages are private and cannot be archived by an admin");
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
  if (ch.type === "direct") throw new HttpError(400, "Direct messages are private and cannot be deleted by an admin");
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
  const { data: m } = await admin.from("messages").select("id, sender_id, conversation_id, metadata").eq("id", id).maybeSingle();
  if (!m) throw new HttpError(404, "Message not found");
  if (m.sender_id !== caller.id) {
    // moderation: admins may remove messages in channels, never in direct messages
    const ch = await loadChannel(admin, m.conversation_id);
    if (!caller.isAdmin || ch.type === "direct") throw new HttpError(403, "You can only delete your own messages");
  }
  const { error } = await admin.from("messages").delete().eq("id", id);
  if (error) throw new HttpError(500, "Could not delete the message");
  const path = (m.metadata as { path?: string } | null)?.path;
  if (path && path.startsWith(`${m.conversation_id}/`)) await admin.storage.from("chat-media").remove([path]);
  if (m.sender_id !== caller.id) {
    await audit(admin, { userId: caller.id, action: "MESSAGE_DELETED_BY_ADMIN", entityType: "messages", entityId: id }, req);
  }
  return { success: true };
}

const MESSAGE_SELECT = "*, sender:profiles!messages_sender_id_fkey(id, full_name, avatar_url)";
const MEDIA_TYPES = ["voice", "image", "file"] as const;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

/** Validates the metadata of a voice note / image / file message. Never trusts the browser's path. */
function mediaMetadata(conversationId: string, raw: unknown) {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const path = v.text(m.path, "path", 10, 300);
  if (!path.startsWith(`${conversationId}/`) || path.includes("..")) throw new HttpError(400, "Invalid file location");
  const mime = v.text(m.mime, "mime", 3, 100).toLowerCase();
  if (!MIME_RE.test(mime)) throw new HttpError(400, "Invalid file type");
  const size = Number(m.size);
  if (!Number.isFinite(size) || size < 0 || size > MEDIA_MAX_BYTES) throw new HttpError(400, "File is too large");
  const out: Record<string, unknown> = { path, mime, size, name: v.optText(m.name, "name", 200) ?? "file" };
  if (m.duration !== undefined) {
    const d = Number(m.duration);
    if (!Number.isFinite(d) || d < 0 || d > 60 * 30) throw new HttpError(400, "Invalid duration");
    out.duration = Math.round(d * 10) / 10;
  }
  if (Array.isArray(m.peaks)) out.peaks = m.peaks.slice(0, 64).map((x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0))));
  return out;
}

async function recipientsOf(admin: SupabaseClient, conversationId: string, callerId: string) {
  const { data: members } = await admin.from("conversation_members").select("user_id").eq("conversation_id", conversationId);
  const ids = (members ?? []).map((m: { user_id: string }) => m.user_id).filter((id: string) => id !== callerId);
  if (!ids.length) return [];
  const { data: active } = await admin.from("profiles").select("id").in("id", ids).eq("employment_status", "active");
  return (active ?? []).map((p: { id: string }) => p.id);
}

async function messageSend(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const conversationId = v.uuid(b.conversationId, "conversationId");
  const messageType = (["task_handoff", ...MEDIA_TYPES] as string[]).includes(b.messageType as string) ? b.messageType as string : "text";
  const isMedia = (MEDIA_TYPES as readonly string[]).includes(messageType);

  let metadata: Record<string, unknown> = {};
  let content: string;
  if (isMedia) {
    metadata = mediaMetadata(conversationId, b.metadata);
    const fallback = messageType === "voice" ? "🎤 Voice message" : messageType === "image" ? "🖼️ Photo" : `📎 ${metadata.name}`;
    content = typeof b.content === "string" && b.content.trim() ? v.text(b.content, "content", 1, 4000) : fallback;
  } else {
    content = v.text(b.content, "content", 1, 4000);
    if (messageType === "task_handoff" && b.metadata && typeof b.metadata === "object") metadata = b.metadata as Record<string, unknown>;
  }
  const replyToId = v.optUuid(b.replyToId, "replyToId");

  // Insert AS the caller so the row-level policy decides whether they may post here.
  const { data: msg, error } = await userClient(caller.token).from("messages").insert({
    conversation_id: conversationId, sender_id: caller.id, content, message_type: messageType, metadata, reply_to_id: replyToId,
  }).select(MESSAGE_SELECT).single();
  if (error || !msg) throw new HttpError(403, "You cannot post in this conversation");

  await notifyMembers(admin, caller, conversationId, msg.sender?.full_name ?? "Someone", messageType, content);
  return { success: true, message: msg };
}

async function notifyMembers(admin: SupabaseClient, caller: Caller, conversationId: string, sender: string, messageType: string, content: string) {
  const { data: convo } = await admin.from("conversations").select("id, type, name").eq("id", conversationId).single();
  const isDirect = convo?.type === "direct";
  const preview = messageType === "task_handoff" ? `📌 ${content}` : (content.length > 110 ? content.slice(0, 107) + "…" : content);

  const activeIds = await recipientsOf(admin, conversationId, caller.id);
  if (!activeIds.length) return;

  // channels: one unread alert per conversation is enough (avoids a flood while people are chatting)
  const alreadyAlerted = new Set<string>();
  if (!isDirect) {
    const { data: unread } = await admin.from("notifications").select("user_id")
      .in("user_id", activeIds).eq("type", "chat_message").eq("is_read", false)
      .eq("metadata->>conversation_id", conversationId)
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
    (unread ?? []).forEach((r: { user_id: string }) => alreadyAlerted.add(r.user_id));
  }

  await Promise.all(activeIds.filter((id) => !alreadyAlerted.has(id)).map((userId) => notify(admin, {
    userId, type: "chat_message",
    title: isDirect ? sender : `${sender} in # ${convo?.name ?? "channel"}`,
    content: preview,
    link: `#chat?c=${conversationId}`,
    metadata: { conversation_id: conversationId },
    push: { tag: `chat-${conversationId}`, urgent: true },
  })));
}

async function reactionToggle(caller: Caller, admin: SupabaseClient, b: Record<string, unknown>) {
  const messageId = v.uuid(b.messageId, "messageId");
  const emoji = v.text(b.emoji, "emoji", 1, 16);
  if (/[<>&"'\s]/.test(emoji)) throw new HttpError(400, "Invalid emoji");
  // RLS decides whether the caller may see (and therefore react to) this message
  const { data: m } = await userClient(caller.token).from("messages").select("id, conversation_id").eq("id", messageId).maybeSingle();
  if (!m) throw new HttpError(404, "Message not found");
  const { data: convo } = await admin.from("conversations").select("is_archived").eq("id", m.conversation_id).single();
  if (convo?.is_archived) throw new HttpError(400, "This channel is archived");

  const { data: existing } = await admin.from("message_reactions").select("id")
    .eq("message_id", messageId).eq("user_id", caller.id).eq("emoji", emoji).maybeSingle();
  if (existing) {
    await admin.from("message_reactions").delete().eq("id", existing.id);
    return { success: true, active: false };
  }
  const { error } = await admin.from("message_reactions").insert({
    message_id: messageId, conversation_id: m.conversation_id, user_id: caller.id, emoji,
  });
  if (error) throw new HttpError(500, "Could not add the reaction");
  return { success: true, active: true };
}

async function callStart(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const conversationId = v.uuid(b.conversationId, "conversationId");
  const kind = v.oneOf(b.kind ?? "video", ["video", "audio"] as const, "kind");
  const callId = crypto.randomUUID();
  const label = kind === "video" ? "📹 Started a video call" : "📞 Started a voice call";

  const { data: msg, error } = await userClient(caller.token).from("messages").insert({
    conversation_id: conversationId, sender_id: caller.id, content: label, message_type: "call",
    metadata: { call_id: callId, kind, started_at: new Date().toISOString() },
  }).select(MESSAGE_SELECT).single();
  if (error || !msg) throw new HttpError(403, "You cannot start a call in this conversation");

  const { data: convo } = await admin.from("conversations").select("type, name").eq("id", conversationId).single();
  const sender = msg.sender?.full_name ?? "Someone";
  const recipients = await recipientsOf(admin, conversationId, caller.id);
  await Promise.all(recipients.map((userId) => notify(admin, {
    userId, type: "call_incoming",
    title: convo?.type === "direct" ? `${sender} is calling you` : `${sender} started a call in # ${convo?.name ?? "channel"}`,
    content: kind === "video" ? "Incoming video call — tap to join" : "Incoming voice call — tap to join",
    link: `#chat?c=${conversationId}&call=${callId}&kind=${kind}`,
    metadata: { conversation_id: conversationId, call_id: callId, kind, from: caller.id },
    push: { tag: `call-${callId}`, urgent: true, requireInteraction: true },
  })));
  return { success: true, callId, message: msg };
}
