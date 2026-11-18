-- Rollback of migration 038: restores the original column default (001_initial_schema.sql) and drops the formatter.
--
-- SAFETY: the original default is LPAD(nextval(..), 3, '0'), which TRUNCATES numbers above 999 (1000 -> EMP-100) and then fails on the
-- UNIQUE constraint. So this script REFUSES to run (it raises an exception and nothing is changed) when either
--   * an existing profiles.employee_id is 'EMP-<number>' with a number above 999, or
--   * the next value of employee_id_seq would be above 999 (the very next employee would get a truncated, colliding ID).
-- It never updates an employee_id and never changes the sequence. Run it with:  psql -v ON_ERROR_STOP=1 -f rollback-038.sql
-- If it refuses, keep 038: there is no safe way back while IDs above 999 exist.
BEGIN;
-- block new employees while the check and the change happen, so nobody can take a number in between
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE v_big TEXT; v_n BIGINT; v_last BIGINT; v_called BOOLEAN; v_next BIGINT;
BEGIN
  SELECT employee_id INTO v_big FROM public.profiles
   WHERE employee_id ~ '^EMP-[0-9]{1,15}$' AND substring(employee_id FROM 5)::bigint > 999
   ORDER BY substring(employee_id FROM 5)::bigint DESC LIMIT 1;
  IF v_big IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.profiles WHERE employee_id ~ '^EMP-[0-9]{1,15}$' AND substring(employee_id FROM 5)::bigint > 999;
    RAISE EXCEPTION 'rollback-038 refused: % employee ID(s) above 999 exist (highest: %). The old default would truncate IDs from 1000 on and collide; nothing was changed. Keep migration 038.', v_n, v_big;
  END IF;
  SELECT last_value, is_called INTO v_last, v_called FROM public.employee_id_seq;
  v_next := CASE WHEN v_called THEN v_last + 1 ELSE v_last END;
  IF v_next > 999 THEN
    RAISE EXCEPTION 'rollback-038 refused: the next employee ID number would be % (employee_id_seq is at %). The old default would truncate it and collide; nothing was changed. Keep migration 038.', v_next, v_last;
  END IF;
END $$;
ALTER TABLE public.profiles ALTER COLUMN employee_id SET DEFAULT ('EMP-' || LPAD(nextval('public.employee_id_seq')::TEXT, 3, '0'));
DROP FUNCTION IF EXISTS public.format_employee_id(bigint);
COMMIT;
