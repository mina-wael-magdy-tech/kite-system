-- Rollback of migration 038: restores the original column default (001_initial_schema.sql) and drops the formatter.
-- WARNING: the original default truncates from the 1,000th employee on. No employee_id is changed; the sequence is not moved back.
BEGIN;
ALTER TABLE public.profiles ALTER COLUMN employee_id SET DEFAULT ('EMP-' || LPAD(nextval('public.employee_id_seq')::TEXT, 3, '0'));
DROP FUNCTION IF EXISTS public.format_employee_id(bigint);
COMMIT;
