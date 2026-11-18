-- ====================================================================
-- 038  Employee IDs beyond 999                                              (additive, idempotent, reversible)
-- ====================================================================
-- ROOT CAUSE: profiles.employee_id defaulted to 'EMP-' || LPAD(nextval('employee_id_seq')::TEXT, 3, '0') (001_initial_schema.sql).
-- LPAD(text, 3) TRUNCATES a longer text: 1000 became 'EMP-100', 1001 'EMP-100' again, and the UNIQUE constraint then rejected the
-- insert (so creating the 1,000th employee fails and every failed insert still consumes a sequence value).
--
-- FIX:   * public.format_employee_id(bigint)   'EMP-' + the number padded to AT LEAST 3 digits, never cut: 7 -> EMP-007, 999 -> EMP-999,
--          1000 -> EMP-1000, 1001 -> EMP-1001, 10000 -> EMP-10000.
--        * the column DEFAULT now calls it. The sequence is still the only generator (concurrency safe: nextval is atomic).
--        * the sequence is moved FORWARD (never back) if an existing 'EMP-<n>' is higher than its current value, so a default can never
--          hand out a number that already exists.
-- NOT CHANGED: every existing employee_id (no row is updated), the column type (TEXT), the UNIQUE constraint, the column grants.
--
-- Read-only check before applying (nothing is modified):
--   SELECT employee_id, count(*) FROM public.profiles GROUP BY 1 HAVING count(*) > 1;            -- must be empty (UNIQUE guarantees it)
--   SELECT employee_id FROM public.profiles WHERE employee_id !~ '^EMP-[0-9]{3,}$';              -- IDs that were typed by hand
--   SELECT last_value, is_called FROM public.employee_id_seq;
--
-- ROLLBACK:  psql -v ON_ERROR_STOP=1 -f supabase/maintenance/rollback-038.sql   (refuses, changing nothing, once an ID above 999 exists or the sequence is past 998)
-- ====================================================================

CREATE OR REPLACE FUNCTION public.format_employee_id(p_n BIGINT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT SET search_path = ''
AS $$ SELECT 'EMP-' || repeat('0', greatest(0, 3 - length(p_n::text))) || p_n::text; $$;
GRANT EXECUTE ON FUNCTION public.format_employee_id(BIGINT) TO PUBLIC;

ALTER TABLE public.profiles ALTER COLUMN employee_id SET DEFAULT public.format_employee_id(nextval('public.employee_id_seq'));

DO $$
DECLARE v_max BIGINT; v_last BIGINT; v_called BOOLEAN;
BEGIN
  SELECT max(substring(employee_id FROM '^EMP-([0-9]{1,15})$')::bigint) INTO v_max FROM public.profiles WHERE employee_id ~ '^EMP-[0-9]{1,15}$';
  SELECT last_value, is_called INTO v_last, v_called FROM public.employee_id_seq;
  IF v_max IS NOT NULL AND (v_max > v_last OR (v_max = v_last AND NOT v_called)) THEN
    PERFORM setval('public.employee_id_seq', v_max, true);
  END IF;
END $$;
