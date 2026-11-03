-- ====================================================================
-- KITE SYSTEM — 006_chat_admin_post.sql
-- Admins (admin / CEO / general manager) can already READ every conversation;
-- let them POST in any non-archived one too (e.g. to answer in a private channel
-- they were not added to). Everyone else still needs an open channel or membership.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.auth_can_post_conversation(p_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.is_archived = false AND (
      c.is_public
      OR public.auth_is_admin()
      OR EXISTS (SELECT 1 FROM public.conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.user_id = auth.uid())
    )
  );
$$;

-- ====================================================================
-- Realtime: stream chat changes to connected browsers (RLS still decides who receives what).
-- REPLICA IDENTITY FULL lets DELETE events carry the conversation id.
-- ====================================================================
ALTER TABLE public.messages REPLICA IDENTITY FULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages', 'conversations', 'conversation_members'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
