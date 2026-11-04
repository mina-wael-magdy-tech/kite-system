-- ====================================================================
-- 018 — "is typing…" indicator for chat
-- Topic format: typing:<conversation uuid> (private Realtime broadcast channel).
-- Anyone who may VIEW the conversation can listen; only people who may POST in it can send.
-- No data is stored: typing signals are ephemeral broadcasts.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.realtime_typing_topic_allowed(p_topic TEXT, p_write BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_topic ~ '^typing:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN CASE WHEN p_write
              THEN public.auth_can_post_conversation(substring(p_topic from 8)::uuid)
              ELSE public.auth_can_view_conversation(substring(p_topic from 8)::uuid) END
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION public.realtime_typing_topic_allowed(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.realtime_typing_topic_allowed(TEXT, BOOLEAN) TO authenticated, service_role;

DROP POLICY IF EXISTS "typing_read" ON realtime.messages;
CREATE POLICY "typing_read" ON realtime.messages FOR SELECT TO authenticated
  USING (extension = 'broadcast' AND public.realtime_typing_topic_allowed(realtime.topic(), false));

DROP POLICY IF EXISTS "typing_write" ON realtime.messages;
CREATE POLICY "typing_write" ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (extension = 'broadcast' AND public.realtime_typing_topic_allowed(realtime.topic(), true));
