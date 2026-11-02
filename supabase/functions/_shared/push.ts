// Web Push delivery (VAPID). Used by notify() so every in-app notification can also reach a phone.
//
// Secrets (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@company.com)
// If they are not set, push is silently disabled and in-app notifications keep working.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import webpush from "npm:web-push@3.6.7";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;   // in-app route, e.g. "#tasks"
  tag?: string;   // same tag replaces the previous notification instead of stacking
}

// Subscription endpoints must belong to a real push service. The server POSTs to them, so an
// arbitrary URL would be a server-side request forgery vector.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return false;
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com", pub, priv);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return Boolean(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY"));
}

/** Sends to every device the user enabled. Never throws; expired subscriptions are removed. */
export async function sendPush(admin: SupabaseClient, userId: string, payload: PushPayload): Promise<{ sent: number; removed: number }> {
  const result = { sent: 0, removed: 0 };
  try {
    if (!configure()) return result;

    const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
    if (!subs?.length) return result;

    const { count: unread } = await admin.from("notifications")
      .select("id", { count: "exact", head: true }).eq("user_id", userId).eq("is_read", false);

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ? `/index.html${payload.url.startsWith("#") ? payload.url : "#" + payload.url}` : "/index.html#dashboard",
      tag: payload.tag,
      badgeCount: unread ?? 0,
    });

    await Promise.all(subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      if (!isAllowedPushEndpoint(s.endpoint)) {
        await admin.from("push_subscriptions").delete().eq("id", s.id);
        result.removed++;
        return;
      }
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60 * 24, urgency: "normal" });
        result.sent++;
      } catch (err) {
        // deno-lint-ignore no-explicit-any
        const status = (err as any)?.statusCode;
        if (status === 404 || status === 410) { // subscription expired or was revoked by the user
          await admin.from("push_subscriptions").delete().eq("id", s.id);
          result.removed++;
        } else {
          console.error("push failed:", status, (err as Error)?.message);
        }
      }
    }));
  } catch (err) {
    console.error("sendPush error:", (err as Error)?.message);
  }
  return result;
}
