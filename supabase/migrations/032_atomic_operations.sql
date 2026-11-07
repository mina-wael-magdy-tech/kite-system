-- ====================================================================
-- KITE SYSTEM — 032_atomic_operations.sql   (Phase 3.D: F-09, F-11, F-16, F-17)
--
--   F-09  Department links change in ONE transaction: set_user_departments / set_primary_department (service role, used by the
--         workflow function) and set_client_departments (runs as the signed-in user, so the existing RLS still decides).
--         One primary department per employee (unique index, created only if no person has two today).
--   F-11  money_figures follows its record: a deleted client / project / campaign / department / lead / opportunity takes its
--         figure with it, a figure cannot be written for a record that does not exist, and create_entity_with_figure /
--         update_entity_with_figure save a record and its figure together (as the signed-in user: RLS unchanged).
--         Existing orphan figures are NOT deleted; money_figure_orphans() lists them.
--   F-16  Kite Drive link creation is recorded as an INTENT before the remote account is made, so a crash between "account
--         created on Drive" and "link saved here" is recoverable (retry adopts the account instead of creating a second one) and
--         visible (drive_link_orphans()). The PHP side is not touched.
--   F-17  Atomic helpers for check-then-act code: chat_reaction_toggle, chat_set_members; notifications.dedupe_key (one reminder
--         per person per day, enforced by the database); broadcasts.request_id (a repeated send is recognised); one PENDING
--         invitation per e-mail address (unique index, created only if there are no duplicates today).
--
-- Safe to run more than once. Run AFTER 031. Applied manually; never `db push` on live.
--
-- ROLLBACK (no data changes; the two new tables hold only in-flight / bookkeeping rows):
--   DROP INDEX IF EXISTS public.uq_user_primary_department, public.uq_notifications_dedupe, public.uq_broadcasts_request, public.uq_invitation_pending_email;
--   DROP TRIGGER IF EXISTS money_figures_entity_check ON public.money_figures;
--   DROP TRIGGER IF EXISTS money_cleanup ON public.clients;  DROP TRIGGER IF EXISTS money_cleanup ON public.projects;  DROP TRIGGER IF EXISTS money_cleanup ON public.campaigns;
--   DROP TRIGGER IF EXISTS money_cleanup ON public.departments;  DROP TRIGGER IF EXISTS money_cleanup ON public.leads;  DROP TRIGGER IF EXISTS money_cleanup ON public.opportunities;
--   DROP FUNCTION IF EXISTS public.set_user_departments(uuid, uuid[]), public.set_primary_department(uuid, uuid), public.set_client_departments(uuid, uuid[]),
--     public.department_link_drift(), public.money_figures_entity_check(), public.money_figure_cleanup(), public.money_figure_orphans(),
--     public.create_entity_with_figure(text, jsonb, numeric), public.update_entity_with_figure(text, uuid, jsonb, numeric, boolean),
--     public.drive_link_begin(uuid, text, uuid), public.drive_link_remote_created(uuid, integer, text), public.drive_link_abort(uuid),
--     public.drive_link_complete(uuid, integer, text, uuid, boolean), public.drive_link_orphans(),
--     public.chat_reaction_toggle(uuid, uuid, text), public.chat_set_members(uuid, uuid[]);
--   -- optional: ALTER TABLE public.notifications DROP COLUMN dedupe_key;  ALTER TABLE public.broadcasts DROP COLUMN request_id, DROP COLUMN completed_at;
--   --           DROP TABLE public.client_drive_link_intents;
-- ====================================================================

-- ---------------------------------------------------------------- 1. F-09 department links
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_departments WHERE is_primary GROUP BY user_id HAVING count(*) > 1) THEN
    RAISE NOTICE '032: some people have more than one PRIMARY department; uq_user_primary_department was NOT created. Fix them, then re-run.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_user_primary_department ON public.user_departments (user_id) WHERE is_primary;
  END IF;
END $$;

-- the full set of a person's departments; the first one is the primary (profiles.department_id follows)
CREATE OR REPLACE FUNCTION public.set_user_departments(p_user UUID, p_depts UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE d UUID[];
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  SELECT array_agg(x ORDER BY o) INTO d FROM (SELECT x, min(o) o FROM unnest(coalesce(p_depts, '{}'::uuid[])) WITH ORDINALITY t(x, o) GROUP BY x) s;
  d := coalesce(d, '{}'::uuid[]);
  IF cardinality(d) > 50 THEN RAISE EXCEPTION 'Too many departments (maximum 50)'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(d) x WHERE NOT EXISTS (SELECT 1 FROM public.departments WHERE id = x)) THEN RAISE EXCEPTION 'Unknown department'; END IF;
  DELETE FROM public.user_departments WHERE user_id = p_user AND NOT (department_id = ANY (d));
  UPDATE public.user_departments SET is_primary = false WHERE user_id = p_user AND is_primary;
  INSERT INTO public.user_departments (user_id, department_id, is_primary) SELECT p_user, x, false FROM unnest(d) x ON CONFLICT (user_id, department_id) DO NOTHING;
  IF cardinality(d) > 0 THEN UPDATE public.user_departments SET is_primary = true WHERE user_id = p_user AND department_id = d[1]; END IF;
  UPDATE public.profiles SET department_id = d[1] WHERE id = p_user;
END;
$$;

-- change only the primary department (what the single-department form did): the old primary membership is replaced
CREATE OR REPLACE FUNCTION public.set_primary_department(p_user UUID, p_dept UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  IF p_dept IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_dept) THEN RAISE EXCEPTION 'Unknown department'; END IF;
  DELETE FROM public.user_departments WHERE user_id = p_user AND is_primary AND department_id IS DISTINCT FROM p_dept;
  IF p_dept IS NOT NULL THEN
    UPDATE public.user_departments SET is_primary = false WHERE user_id = p_user AND is_primary AND department_id <> p_dept;
    INSERT INTO public.user_departments (user_id, department_id, is_primary) VALUES (p_user, p_dept, true)
    ON CONFLICT (user_id, department_id) DO UPDATE SET is_primary = true;
  END IF;
  UPDATE public.profiles SET department_id = p_dept WHERE id = p_user;
END;
$$;

-- a client's departments, replaced atomically; SECURITY INVOKER: the caller's RLS decides (managers who can see the client)
CREATE OR REPLACE FUNCTION public.set_client_departments(p_client UUID, p_depts UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE d UUID[] := coalesce(p_depts, '{}'::uuid[]);
BEGIN
  DELETE FROM public.client_departments WHERE client_id = p_client AND NOT (department_id = ANY (d));
  INSERT INTO public.client_departments (client_id, department_id) SELECT p_client, x FROM (SELECT DISTINCT unnest(d) x) s ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.set_user_departments(UUID, UUID[]), public.set_primary_department(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_departments(UUID, UUID[]), public.set_primary_department(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.set_client_departments(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_client_departments(UUID, UUID[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.department_link_drift()
RETURNS TABLE (user_id UUID, profile_department UUID, primary_department UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.id, p.department_id, (SELECT ud.department_id FROM public.user_departments ud WHERE ud.user_id = p.id AND ud.is_primary LIMIT 1)
  FROM public.profiles p
  WHERE p.department_id IS DISTINCT FROM (SELECT ud.department_id FROM public.user_departments ud WHERE ud.user_id = p.id AND ud.is_primary LIMIT 1)
    AND EXISTS (SELECT 1 FROM public.user_departments ud WHERE ud.user_id = p.id);
$$;
REVOKE ALL ON FUNCTION public.department_link_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_link_drift() TO service_role;

-- ---------------------------------------------------------------- 2. F-11 money_figures
CREATE OR REPLACE FUNCTION public.money_figures_entity_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_table TEXT; v_ok BOOLEAN;
BEGIN
  v_table := CASE NEW.entity WHEN 'client_monthly' THEN 'clients' WHEN 'project_budget' THEN 'projects' WHEN 'campaign_budget' THEN 'campaigns'
                             WHEN 'department_budget' THEN 'departments' WHEN 'lead_value' THEN 'leads' WHEN 'opportunity_value' THEN 'opportunities' END;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', v_table) INTO v_ok USING NEW.entity_id;
  IF NOT v_ok THEN RAISE EXCEPTION 'money_figure_orphan: there is no % with this id', v_table USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.money_figures_entity_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS money_figures_entity_check ON public.money_figures;
CREATE TRIGGER money_figures_entity_check BEFORE INSERT OR UPDATE OF entity, entity_id ON public.money_figures FOR EACH ROW EXECUTE FUNCTION public.money_figures_entity_check();

CREATE OR REPLACE FUNCTION public.money_figure_cleanup()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.money_figures WHERE entity = TG_ARGV[0] AND entity_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.money_figure_cleanup() FROM PUBLIC, anon, authenticated;
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('clients', 'client_monthly'), ('projects', 'project_budget'), ('campaigns', 'campaign_budget'),
                                 ('departments', 'department_budget'), ('leads', 'lead_value'), ('opportunities', 'opportunity_value')) v(t, e) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS money_cleanup ON public.%I', r.t);
    EXECUTE format('CREATE TRIGGER money_cleanup AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.money_figure_cleanup(%L)', r.t, r.e);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.money_figure_orphans()
RETURNS TABLE (entity TEXT, entity_id UUID, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT m.entity, m.entity_id, m.amount FROM public.money_figures m WHERE NOT CASE m.entity
    WHEN 'client_monthly' THEN EXISTS (SELECT 1 FROM public.clients x WHERE x.id = m.entity_id)
    WHEN 'project_budget' THEN EXISTS (SELECT 1 FROM public.projects x WHERE x.id = m.entity_id)
    WHEN 'campaign_budget' THEN EXISTS (SELECT 1 FROM public.campaigns x WHERE x.id = m.entity_id)
    WHEN 'department_budget' THEN EXISTS (SELECT 1 FROM public.departments x WHERE x.id = m.entity_id)
    WHEN 'lead_value' THEN EXISTS (SELECT 1 FROM public.leads x WHERE x.id = m.entity_id)
    WHEN 'opportunity_value' THEN EXISTS (SELECT 1 FROM public.opportunities x WHERE x.id = m.entity_id) END;
$$;
REVOKE ALL ON FUNCTION public.money_figure_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_figure_orphans() TO service_role;

-- Create a record and its figure together. SECURITY INVOKER: the same RLS as the plain insert / upsert.
CREATE OR REPLACE FUNCTION public.create_entity_with_figure(p_table TEXT, p_row JSONB, p_amount NUMERIC DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE v_entity TEXT; v_cols TEXT; v_id UUID;
BEGIN
  v_entity := CASE p_table WHEN 'clients' THEN 'client_monthly' WHEN 'projects' THEN 'project_budget' WHEN 'campaigns' THEN 'campaign_budget'
                           WHEN 'departments' THEN 'department_budget' WHEN 'leads' THEN 'lead_value' WHEN 'opportunities' THEN 'opportunity_value' END;
  IF v_entity IS NULL THEN RAISE EXCEPTION 'Unsupported table'; END IF;
  IF jsonb_typeof(p_row) <> 'object' OR p_row = '{}'::jsonb THEN RAISE EXCEPTION 'Nothing to insert'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_row) k WHERE NOT EXISTS (
       SELECT 1 FROM pg_attribute a WHERE a.attrelid = format('public.%I', p_table)::regclass AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'Unknown column';
  END IF;
  SELECT string_agg(format('%I', k), ', ') INTO v_cols FROM jsonb_object_keys(p_row) k;
  EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) RETURNING id', p_table, v_cols, v_cols, p_table) INTO v_id USING p_row;
  IF p_amount IS NOT NULL AND p_amount > 0 THEN
    INSERT INTO public.money_figures (entity, entity_id, amount, updated_by, updated_at) VALUES (v_entity, v_id, p_amount, auth.uid(), now())
    ON CONFLICT (entity, entity_id) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  RETURN v_id;
END;
$$;

-- Update a record and its figure together. p_touch_figure = false leaves the figure alone; true with NULL / <= 0 clears it.
CREATE OR REPLACE FUNCTION public.update_entity_with_figure(p_table TEXT, p_id UUID, p_row JSONB, p_amount NUMERIC DEFAULT NULL, p_touch_figure BOOLEAN DEFAULT true)
RETURNS UUID LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE v_entity TEXT; v_set TEXT; v_got UUID;
BEGIN
  v_entity := CASE p_table WHEN 'clients' THEN 'client_monthly' WHEN 'projects' THEN 'project_budget' WHEN 'campaigns' THEN 'campaign_budget'
                           WHEN 'departments' THEN 'department_budget' WHEN 'leads' THEN 'lead_value' WHEN 'opportunities' THEN 'opportunity_value' END;
  IF v_entity IS NULL THEN RAISE EXCEPTION 'Unsupported table'; END IF;
  IF coalesce(p_row, '{}'::jsonb) <> '{}'::jsonb THEN
    IF jsonb_typeof(p_row) <> 'object' THEN RAISE EXCEPTION 'Bad row'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_row) k WHERE NOT EXISTS (
         SELECT 1 FROM pg_attribute a WHERE a.attrelid = format('public.%I', p_table)::regclass AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped) OR k = 'id') THEN
      RAISE EXCEPTION 'Unknown column';
    END IF;
    SELECT string_agg(format('%I = r.%I', k, k), ', ') INTO v_set FROM jsonb_object_keys(p_row) k;
    EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I, $1) r WHERE t.id = $2 RETURNING t.id', p_table, v_set, p_table) INTO v_got USING p_row, p_id;
    IF v_got IS NULL THEN RAISE EXCEPTION 'not_found_or_not_permitted: the record does not exist or you may not change it'; END IF;
  END IF;
  IF p_touch_figure THEN
    IF p_amount IS NULL OR p_amount <= 0 THEN
      DELETE FROM public.money_figures WHERE entity = v_entity AND entity_id = p_id;
    ELSE
      INSERT INTO public.money_figures (entity, entity_id, amount, updated_by, updated_at) VALUES (v_entity, p_id, p_amount, auth.uid(), now())
      ON CONFLICT (entity, entity_id) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now();
    END IF;
  END IF;
  RETURN p_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_entity_with_figure(TEXT, JSONB, NUMERIC), public.update_entity_with_figure(TEXT, UUID, JSONB, NUMERIC, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_entity_with_figure(TEXT, JSONB, NUMERIC), public.update_entity_with_figure(TEXT, UUID, JSONB, NUMERIC, BOOLEAN) TO authenticated, service_role;

-- ---------------------------------------------------------------- 3. F-16 Kite Drive link intents
CREATE TABLE IF NOT EXISTS public.client_drive_link_intents (
    client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
    email TEXT,
    drive_user_id INTEGER,
    drive_name TEXT,
    requested_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    remote_created_at TIMESTAMPTZ
);
ALTER TABLE public.client_drive_link_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_drive_link_intents FROM anon, authenticated;

-- state: new (go and create the remote account) | adopt (it exists on Drive: just link it) | busy (another request is creating it now)
--        | stale (an earlier request died before recording the account: look it up on Drive by e-mail, create only if absent)
CREATE OR REPLACE FUNCTION public.drive_link_begin(p_client UUID, p_email TEXT, p_actor UUID)
RETURNS TABLE (drive_user_id INTEGER, drive_name TEXT, state TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE r public.client_drive_link_intents%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.client_drive_links WHERE client_id = p_client) THEN RAISE EXCEPTION 'already_linked: This client is already linked to Kite Drive'; END IF;
  INSERT INTO public.client_drive_link_intents (client_id, email, requested_by) VALUES (p_client, p_email, p_actor) ON CONFLICT (client_id) DO NOTHING;
  IF FOUND THEN RETURN QUERY SELECT NULL::integer, NULL::text, 'new'::text; RETURN; END IF;
  SELECT * INTO r FROM public.client_drive_link_intents WHERE client_id = p_client FOR UPDATE;
  IF r.drive_user_id IS NOT NULL THEN RETURN QUERY SELECT r.drive_user_id, r.drive_name, 'adopt'::text; RETURN; END IF;
  IF r.created_at < now() - interval '2 minutes' THEN
    UPDATE public.client_drive_link_intents SET created_at = now(), email = p_email, requested_by = p_actor WHERE client_id = p_client;
    RETURN QUERY SELECT NULL::integer, NULL::text, 'stale'::text; RETURN;
  END IF;
  RETURN QUERY SELECT NULL::integer, NULL::text, 'busy'::text;
END;
$$;
CREATE OR REPLACE FUNCTION public.drive_link_remote_created(p_client UUID, p_drive_user_id INTEGER, p_name TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ UPDATE public.client_drive_link_intents SET drive_user_id = p_drive_user_id, drive_name = p_name, remote_created_at = now() WHERE client_id = p_client $$;
CREATE OR REPLACE FUNCTION public.drive_link_abort(p_client UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ DELETE FROM public.client_drive_link_intents WHERE client_id = p_client AND drive_user_id IS NULL $$;
-- the link and the removal of the intent commit together; p_replace = true lets "link an existing account" replace a link (the old behaviour)
CREATE OR REPLACE FUNCTION public.drive_link_complete(p_client UUID, p_drive_user_id INTEGER, p_name TEXT, p_actor UUID, p_replace BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_replace THEN
    INSERT INTO public.client_drive_links (client_id, drive_user_id, drive_name, linked_by, linked_at) VALUES (p_client, p_drive_user_id, p_name, p_actor, now())
    ON CONFLICT (client_id) DO UPDATE SET drive_user_id = EXCLUDED.drive_user_id, drive_name = EXCLUDED.drive_name, linked_by = EXCLUDED.linked_by, linked_at = now();
  ELSE
    INSERT INTO public.client_drive_links (client_id, drive_user_id, drive_name, linked_by, linked_at) VALUES (p_client, p_drive_user_id, p_name, p_actor, now());
  END IF;
  DELETE FROM public.client_drive_link_intents WHERE client_id = p_client;
END;
$$;
-- Drive accounts created by this system that never got linked here (the recoverable half of the dual write)
CREATE OR REPLACE FUNCTION public.drive_link_orphans()
RETURNS TABLE (client_id UUID, drive_user_id INTEGER, drive_name TEXT, remote_created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT i.client_id, i.drive_user_id, i.drive_name, i.remote_created_at FROM public.client_drive_link_intents i
      WHERE i.drive_user_id IS NOT NULL AND i.created_at < now() - interval '10 minutes' $$;
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['drive_link_begin(uuid,text,uuid)', 'drive_link_remote_created(uuid,integer,text)', 'drive_link_abort(uuid)',
                           'drive_link_complete(uuid,integer,text,uuid,boolean)', 'drive_link_orphans()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 4. F-17 atomic chat helpers, dedupe keys, idempotent broadcasts, one pending invitation
CREATE OR REPLACE FUNCTION public.chat_reaction_toggle(p_user UUID, p_message UUID, p_emoji TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_conv UUID;
BEGIN
  SELECT conversation_id INTO v_conv FROM public.messages WHERE id = p_message;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'message_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('chat_reaction'), hashtext(p_message::text || p_user::text || p_emoji));   -- one person's toggles of one emoji run one at a time
  DELETE FROM public.message_reactions WHERE message_id = p_message AND user_id = p_user AND emoji = p_emoji;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO public.message_reactions (message_id, conversation_id, user_id, emoji) VALUES (p_message, v_conv, p_user, p_emoji) ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.chat_set_members(p_channel UUID, p_members UUID[])
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_add UUID[]; v_del UUID[]; w UUID[] := coalesce(p_members, '{}'::uuid[]);
BEGIN
  PERFORM 1 FROM public.conversations WHERE id = p_channel FOR UPDATE;       -- concurrent member edits of one channel queue here
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_not_found'; END IF;
  SELECT coalesce(array_agg(x), '{}') INTO v_add FROM (SELECT DISTINCT unnest(w) x) s WHERE NOT EXISTS (SELECT 1 FROM public.conversation_members m WHERE m.conversation_id = p_channel AND m.user_id = s.x);
  SELECT coalesce(array_agg(m.user_id), '{}') INTO v_del FROM public.conversation_members m WHERE m.conversation_id = p_channel AND NOT (m.user_id = ANY (w));
  INSERT INTO public.conversation_members (conversation_id, user_id, role) SELECT p_channel, x, 'member' FROM unnest(v_add) x ON CONFLICT (conversation_id, user_id) DO NOTHING;
  DELETE FROM public.conversation_members WHERE conversation_id = p_channel AND user_id = ANY (v_del);
  RETURN jsonb_build_object('added', to_jsonb(v_add), 'removed', to_jsonb(v_del));
END;
$$;
REVOKE ALL ON FUNCTION public.chat_reaction_toggle(UUID, UUID, TEXT), public.chat_set_members(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_reaction_toggle(UUID, UUID, TEXT), public.chat_set_members(UUID, UUID[]) TO service_role;

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe ON public.notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS request_id UUID, ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcasts_request ON public.broadcasts (request_id) WHERE request_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.invitations WHERE status = 'pending' GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE NOTICE '032: some e-mail addresses have more than one PENDING invitation; uq_invitation_pending_email was NOT created. Revoke the extra ones, then re-run.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_invitation_pending_email ON public.invitations (lower(email)) WHERE status = 'pending';
  END IF;
END $$;
