# Chat v2: private conversations, voice notes, files, calls

## Deploy checklist (in this order)
1. Run `supabase/migrations/016_chat_v2_private_and_media.sql` (SQL editor or `supabase db push`).
2. Redeploy the function: `npx supabase functions deploy chat --project-ref <ref> --use-api`
   and `workflow` / `broadcast` / `due-reminders` (they share `_shared/auth.ts` + `push.ts`, which changed).
3. Redeploy the site (Vercel). Reopen the installed app once so the new service worker installs.
4. Optional but strongly advised for calls: set `ICE_SERVERS` in Vercel (see below).
5. Android phones: open the bell → **Turn on notifications** once per device (if it was on already, turn it off and on again).

## Privacy model
| Who | Sees |
|---|---|
| Any member | Their own channels, their own DMs, and open (public) channels |
| Admin / CEO / GM | The same as everyone else, **not** other people's private channels or DMs. They can still create, rename, archive, delete and change members of *channels* (member changes are written to the audit log), and delete messages in *channels* (never in DMs). |
| Files & voice notes | Stored in the private `chat-media` bucket; only conversation members get short-lived (1 h) signed links |
| Calls | Audio/video is peer-to-peer and encrypted by WebRTC (DTLS-SRTP). Call set-up travels over a *private* Realtime channel that only conversation members can join. |

Messages themselves are protected by row-level security and encryption at rest/in transit (TLS), not end-to-end
encryption: the database operator can technically read text messages. True E2EE for text would need per-device keys
and would break search, multi-device sync and server notifications, so it is intentionally not included.

## Features
Slack-style rows with avatars and day dividers · replies · emoji reactions · voice notes (waveform, up to 5 min) ·
photo/file attachments (25 MB, paste a screenshot to send it) · voice and video calls for up to 6 people ·
screen sharing · incoming-call ringing with a full-screen alert on the phone · conversation search · unread badges.

## Calls: TURN server
STUN alone connects most office/Wi-Fi calls but fails on many mobile networks. Add a TURN service (e.g. Cloudflare
Realtime TURN, Metered, or your own coturn) and set the Vercel variable `ICE_SERVERS` to a JSON array:

```json
[{"urls":["stun:stun.l.google.com:19302"]},
 {"urls":["turn:turn.example.com:3478","turns:turn.example.com:5349"],"username":"USER","credential":"PASS"}]
```
Note: these values are visible in the browser. Use a TURN provider that issues limited credentials.

## Android notification troubleshooting
* Push needs **https**, an installed or at least Chrome-opened site, and notifications allowed for the site.
* Android system settings → Apps → Chrome / Kite → Notifications: make sure the *Kite System* channel is not silenced.
* Battery saver / "Sleeping apps" on Samsung/Xiaomi can delay pushes for installed PWAs: set Kite to *Unrestricted*.
* Chat and call pushes are now sent with **high priority** (Android no longer parks them in Doze), vibrate, and a
  separate notification per conversation. Incoming-call notifications stay on screen until tapped.
* If the app is open and in front, no system banner is shown (the in-app toast / ringing screen is used instead).
