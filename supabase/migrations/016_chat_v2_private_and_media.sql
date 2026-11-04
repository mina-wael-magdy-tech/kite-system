-- ====================================================================
-- PULSE STUDIO OS — 016_chat_v2_private_and_media.sql
-- Chat v2: real privacy + voice notes / files / reactions / replies + secure call signalling.
--
-- 1. PRIVACY. Until now every admin / CEO / GM could read EVERY conversation, including other
--    people's direct messages. From now on a conversation is visible only to its members;
--    open (public) channels stay visible to all staff. Direct messages can never be public.
-- 2. New message kinds: voice, image, file, call. Replies (reply_to_id).
-- 3. Reactions (message_reactions).
-- 4. Private storage bucket `chat-media` (voice notes, images, files). Only members of the
--    conversation can download; short-lived signed links only.
-- 5. Realtime authorisation for call signalling: only people who may post in a conversation can
--    join its `call:<conversation id>` channel, so nobody else can listen to or inject offers.
-- ====================================================================

-- ---------------------------------------------------------------- 1. privacy
CREATE OR REPLACE FUNCTION public.auth_can_view_conversation(p_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND (
      (c.is_public AND c.type <> 'direct')
      OR EXISTS (SELECT 1 FROM public.conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.user_id = auth.uid())
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_can_post_conversation(p_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.is_archived = false AND (
      (c.is_public AND c.type <> 'direct')
      OR EXISTS (SELECT 1 FROM public.conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.user_id = auth.uid())
    )
  );
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_direct_never_public') THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_direct_never_public CHECK (type <> 'direct' OR is_public = false) NOT VALID;
  END IF;
END $$;
-- make sure no existing DM is open to everyone
UPDATE public.conversations SET is_public = false WHERE type = 'direct' AND is_public;

-- ---------------------------------------------------------------- 2. message kinds + replies
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_message_type_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_message_type_check
  CHECK (message_type IN ('text', 'system', 'task_handoff', 'voice', 'image', 'file', 'call'));

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON public.messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_messages_convo_created ON public.messages(conversation_id, created_at DESC);

DROP POLICY IF EXISTS "messages_insert" ON public.messages;
CREATE POLICY "messages_insert" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid()
              AND message_type IN ('text', 'task_handoff', 'voice', 'image', 'file', 'call')
              AND public.auth_can_post_conversation(conversation_id));

-- ---------------------------------------------------------------- 3. reactions
CREATE TABLE IF NOT EXISTS public.message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_message_reaction UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON public.message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_convo ON public.message_reactions(conversation_id);

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_reactions FROM anon, authenticated;
GRANT SELECT ON public.message_reactions TO authenticated;      -- writes go through the chat function
DROP POLICY IF EXISTS "message_reactions_select" ON public.message_reactions;
CREATE POLICY "message_reactions_select" ON public.message_reactions FOR SELECT TO authenticated
  USING (public.auth_can_view_conversation(conversation_id));

ALTER TABLE public.message_reactions REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'message_reactions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;
  END IF;
END $$;

-- ---------------------------------------------------------------- 4. private media bucket
-- Path convention: <conversation_id>/<user_id>-<random>.<ext>
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chat-media', 'chat-media', false, 26214400) -- 25 MB
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

CREATE OR REPLACE FUNCTION public.storage_conversation_id(p_object_name TEXT)
RETURNS UUID LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN split_part(p_object_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN split_part(p_object_name, '/', 1)::uuid
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.storage_conversation_id(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.storage_conversation_id(TEXT) TO authenticated, service_role;

DROP POLICY IF EXISTS "chat_media_read" ON storage.objects;
CREATE POLICY "chat_media_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media'
         AND public.auth_can_view_conversation(public.storage_conversation_id(name)));

DROP POLICY IF EXISTS "chat_media_upload" ON storage.objects;
CREATE POLICY "chat_media_upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-media'
              AND public.auth_can_post_conversation(public.storage_conversation_id(name))
              AND split_part(split_part(name, '/', 2), '-', 1) = replace(auth.uid()::text, '-', ''));

DROP POLICY IF EXISTS "chat_media_delete" ON storage.objects;
CREATE POLICY "chat_media_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-media' AND owner_id = auth.uid()::text);

-- ---------------------------------------------------------------- 5. call signalling (Realtime Authorization)
-- Topic format: call:<conversation uuid>. Only people allowed to post in that conversation may
-- listen to or send on it. (Clients must open the channel with { config: { private: true } }.)
CREATE OR REPLACE FUNCTION public.realtime_call_topic_allowed(p_topic TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_topic ~ '^call:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN public.auth_can_post_conversation(substring(p_topic from 6)::uuid)
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION public.realtime_call_topic_allowed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.realtime_call_topic_allowed(TEXT) TO authenticated, service_role;

DROP POLICY IF EXISTS "call_signal_read" ON realtime.messages;
CREATE POLICY "call_signal_read" ON realtime.messages FOR SELECT TO authenticated
  USING (extension = 'broadcast' AND public.realtime_call_topic_allowed(realtime.topic()));

DROP POLICY IF EXISTS "call_signal_write" ON realtime.messages;
CREATE POLICY "call_signal_write" ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (extension = 'broadcast' AND public.realtime_call_topic_allowed(realtime.topic()));
