-- ====================================================================
-- KITE SYSTEM — 030_hr_integrity.sql   (Phase 3.C part 1: F-06 attendance and leave, F-12 business date)
--
-- BUSINESS RULES (defined here because the code had none; every default follows what the app already did):
--
--  Business date / time zone
--    * The studio's time zone is company_settings key 'studio_timezone' (JSON string); default Africa/Cairo, the same
--      default the scheduled functions already use (REMINDER_TZ). studio_today() / studio_date(ts) give the business date.
--
--  Attendance
--    * The CLOCK IS THE SERVER'S. An employee's check-in time is the database time of the insert, the check-out time is the
--      database time of the update, `date` is the studio date of the check-in, total_hours is computed from the two times.
--      Whatever the browser sends for these columns is ignored.
--    * One record per person per studio date (existing unique constraint). A record can be closed once; it cannot be
--      re-opened; check-out must be after check-in; an employee cannot close a record older than 24 hours (HR can, up to 99.99 h).
--    * HR / admins (and database operators with no signed-in user) may correct a check-out explicitly; the same validation applies.
--
--  Leave
--    * Duration = calendar days from start to end inclusive, calculated by the database (as the app already counted; weekends
--      and public holidays are NOT excluded: DECISION NEEDED if the studio wants working days only).
--    * Dates: end >= start. A person cannot have two overlapping PENDING or APPROVED requests (race-safe).
--    * Balance (leave_types.default_days): flat annual entitlement per leave type per calendar year, available in full from
--      1 January; NO accrual, NO proration for joiners, NO carry-over (DECISION NEEDED for any of those). A request is allowed
--      while approved + pending + requested days of that year <= entitlement; a request spanning two years is checked per year.
--      default_days = 0 means "no limit tracked" for that type. Pending requests RESERVE days; rejected / cancelled release them.
--    * Approval re-checks the balance. Status moves: pending -> approved | rejected | cancelled, approved -> cancelled; nothing else.
--    * Existing rows are never changed. A legacy pending request that would exceed the balance simply cannot be approved.
--
-- Safe to run more than once. Run AFTER 029. Applied manually; never `db push` on live.
--
-- ROLLBACK (no data changes):
--   DROP TRIGGER IF EXISTS hr_attendance_guard ON public.attendance_records;  DROP TRIGGER IF EXISTS hr_leave_guard ON public.leave_requests;
--   ALTER TABLE public.attendance_records DROP CONSTRAINT IF EXISTS attendance_out_after_in, DROP CONSTRAINT IF EXISTS attendance_hours_nonneg;
--   ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_end_after_start;
--   DROP FUNCTION IF EXISTS public.hr_attendance_guard(), public.hr_leave_guard(), public.hr_leave_check(uuid, uuid, date, date, uuid, boolean),
--     public.hr_leave_usage(uuid, uuid, integer, uuid), public.hr_leave_days_in_year(date, date, integer), public.hr_leave_balance(uuid, uuid, integer),
--     public.hr_open_attendance(), public.studio_today(), public.studio_date(timestamptz), public.studio_date(timestamptz, text), public.studio_timezone();
-- ====================================================================

-- ---------------------------------------------------------------- 1. the studio's business date
CREATE OR REPLACE FUNCTION public.studio_timezone()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT coalesce((SELECT nullif(value #>> '{}', '') FROM public.company_settings WHERE key = 'studio_timezone'), 'Africa/Cairo') $$;
CREATE OR REPLACE FUNCTION public.studio_date(p_ts TIMESTAMPTZ, p_tz TEXT)
RETURNS DATE LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT (p_ts AT TIME ZONE p_tz)::date $$;
CREATE OR REPLACE FUNCTION public.studio_date(p_ts TIMESTAMPTZ)
RETURNS DATE LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT public.studio_date(p_ts, public.studio_timezone()) $$;
CREATE OR REPLACE FUNCTION public.studio_today()
RETURNS DATE LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT public.studio_date(now()) $$;
GRANT EXECUTE ON FUNCTION public.studio_timezone(), public.studio_date(timestamptz, text), public.studio_date(timestamptz), public.studio_today() TO authenticated, service_role;

-- ---------------------------------------------------------------- 2. attendance
SELECT public.ops_add_check('public.attendance_records', 'attendance_out_after_in', 'check_out IS NULL OR check_out > check_in');
SELECT public.ops_add_check('public.attendance_records', 'attendance_hours_nonneg', 'total_hours IS NULL OR total_hours >= 0');

CREATE OR REPLACE FUNCTION public.hr_attendance_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_operator BOOLEAN := auth.uid() IS NULL; v_hr BOOLEAN;
BEGIN
  v_hr := v_operator OR public.auth_is_admin() OR public.auth_has_role('hr_manager');
  IF TG_OP = 'INSERT' THEN
    IF NOT v_operator THEN
      NEW.check_in := now();            -- the clock is the server's
      NEW.check_out := NULL;
    END IF;
    NEW.date := public.studio_date(NEW.check_in);
    IF NEW.check_out IS NOT NULL AND NEW.check_out <= NEW.check_in THEN
      RAISE EXCEPTION 'Check-out must be after check-in' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT v_operator AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.check_in IS DISTINCT FROM OLD.check_in OR NEW.date IS DISTINCT FROM OLD.date) THEN
      RAISE EXCEPTION 'The owner, check-in time and date of an attendance record cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF NEW.check_out IS DISTINCT FROM OLD.check_out THEN
      IF OLD.check_out IS NOT NULL AND NOT v_hr THEN
        RAISE EXCEPTION 'This attendance record is already checked out' USING ERRCODE = '42501';
      END IF;
      IF NEW.check_out IS NULL AND NOT v_operator THEN
        RAISE EXCEPTION 'A checked-out attendance record cannot be re-opened' USING ERRCODE = '42501';
      END IF;
      IF NOT v_hr THEN
        NEW.check_out := now();         -- employees close a record with the server clock only
        IF NEW.check_out - OLD.check_in > interval '24 hours' THEN
          RAISE EXCEPTION 'This attendance record is older than 24 hours: ask HR to close it' USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END IF;
  IF NEW.check_out IS NOT NULL THEN
    IF NEW.check_out <= NEW.check_in THEN RAISE EXCEPTION 'Check-out must be after check-in' USING ERRCODE = '23514'; END IF;
    IF NEW.check_out - NEW.check_in > interval '99 hours' THEN RAISE EXCEPTION 'An attendance record cannot span more than 99 hours' USING ERRCODE = '22023'; END IF;
    NEW.total_hours := round(extract(epoch FROM (NEW.check_out - NEW.check_in)) / 3600.0, 2);
  ELSE
    NEW.total_hours := 0;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_attendance_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS hr_attendance_guard ON public.attendance_records;
CREATE TRIGGER hr_attendance_guard BEFORE INSERT OR UPDATE ON public.attendance_records FOR EACH ROW EXECUTE FUNCTION public.hr_attendance_guard();

-- records still open after 24 hours (forgotten check-outs): for HR to close; read-only report
CREATE OR REPLACE FUNCTION public.hr_open_attendance()
RETURNS TABLE (id UUID, user_id UUID, date DATE, check_in TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT a.id, a.user_id, a.date, a.check_in FROM public.attendance_records a WHERE a.check_out IS NULL AND a.check_in < now() - interval '24 hours' ORDER BY a.check_in $$;
REVOKE ALL ON FUNCTION public.hr_open_attendance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_open_attendance() TO service_role;

-- ---------------------------------------------------------------- 3. leave
SELECT public.ops_add_check('public.leave_requests', 'leave_end_after_start', 'end_date >= start_date');

CREATE OR REPLACE FUNCTION public.hr_leave_days_in_year(p_start DATE, p_end DATE, p_year INTEGER)
RETURNS INTEGER LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT greatest(0, least(p_end, make_date(p_year, 12, 31)) - greatest(p_start, make_date(p_year, 1, 1)) + 1) $$;

-- days already approved / pending in one calendar year (the dates decide, not the stored total_days)
CREATE OR REPLACE FUNCTION public.hr_leave_usage(p_user UUID, p_type UUID, p_year INTEGER, p_exclude UUID DEFAULT NULL)
RETURNS TABLE (approved INTEGER, pending INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(public.hr_leave_days_in_year(start_date, end_date, p_year)) FILTER (WHERE status = 'approved'), 0)::int,
         coalesce(sum(public.hr_leave_days_in_year(start_date, end_date, p_year)) FILTER (WHERE status = 'pending'), 0)::int
  FROM public.leave_requests
  WHERE user_id = p_user AND leave_type_id = p_type AND status IN ('approved', 'pending') AND id IS DISTINCT FROM p_exclude
    AND start_date <= make_date(p_year, 12, 31) AND end_date >= make_date(p_year, 1, 1);
$$;
REVOKE ALL ON FUNCTION public.hr_leave_usage(UUID, UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;

-- a person's own balance (HR and admins may read anyone's)
CREATE OR REPLACE FUNCTION public.hr_leave_balance(p_user UUID, p_type UUID, p_year INTEGER)
RETURNS TABLE (entitlement INTEGER, approved INTEGER, pending INTEGER, remaining INTEGER)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_ent INTEGER; u RECORD;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user AND NOT (public.auth_is_admin() OR public.auth_has_role('hr_manager')) THEN
    RAISE EXCEPTION 'You can only read your own leave balance' USING ERRCODE = '42501';
  END IF;
  SELECT default_days INTO v_ent FROM public.leave_types WHERE id = p_type;
  IF v_ent IS NULL THEN RAISE EXCEPTION 'Unknown leave type'; END IF;
  SELECT * INTO u FROM public.hr_leave_usage(p_user, p_type, p_year);
  RETURN QUERY SELECT v_ent, u.approved, u.pending, CASE WHEN v_ent = 0 THEN NULL ELSE v_ent - u.approved - u.pending END;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_leave_balance(UUID, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_leave_balance(UUID, UUID, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_leave_check(p_user UUID, p_type UUID, p_start DATE, p_end DATE, p_exclude UUID, p_check_overlap BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_ent INTEGER; y INTEGER; u RECORD; v_req INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hr_leave'), hashtext(p_user::text));   -- one person's requests are checked one at a time
  IF p_check_overlap AND EXISTS (
       SELECT 1 FROM public.leave_requests r WHERE r.user_id = p_user AND r.status IN ('pending', 'approved')
         AND r.id IS DISTINCT FROM p_exclude AND r.start_date <= p_end AND r.end_date >= p_start) THEN
    RAISE EXCEPTION 'You already have a pending or approved leave request that overlaps these dates' USING ERRCODE = '23P01';
  END IF;
  SELECT default_days INTO v_ent FROM public.leave_types WHERE id = p_type;
  IF v_ent IS NULL OR v_ent = 0 THEN RETURN; END IF;
  FOR y IN extract(year FROM p_start)::int .. extract(year FROM p_end)::int LOOP
    v_req := public.hr_leave_days_in_year(p_start, p_end, y);
    SELECT * INTO u FROM public.hr_leave_usage(p_user, p_type, y, p_exclude);
    IF u.approved + u.pending + v_req > v_ent THEN
      RAISE EXCEPTION 'Not enough leave balance for %: % of % days left, % requested', y, greatest(v_ent - u.approved - u.pending, 0), v_ent, v_req USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_leave_check(UUID, UUID, DATE, DATE, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hr_leave_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_operator BOOLEAN := auth.uid() IS NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.end_date < NEW.start_date THEN RAISE EXCEPTION 'The end date cannot be before the start date' USING ERRCODE = '23514'; END IF;
    NEW.total_days := (NEW.end_date - NEW.start_date) + 1;      -- the database counts the days, not the browser
    IF NEW.status IN ('pending', 'approved') THEN
      PERFORM public.hr_leave_check(NEW.user_id, NEW.leave_type_id, NEW.start_date, NEW.end_date, NULL, true);
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NOT v_operator AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.leave_type_id IS DISTINCT FROM OLD.leave_type_id
       OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.total_days IS DISTINCT FROM OLD.total_days) THEN
    RAISE EXCEPTION 'The person, type and dates of a leave request cannot be changed: cancel it and request again' USING ERRCODE = '42501';
  END IF;
  IF NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    NEW.total_days := (NEW.end_date - NEW.start_date) + 1;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled')) OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
      RAISE EXCEPTION 'A % leave request cannot become %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'approved' THEN                                -- approving re-checks the balance (the request itself is excluded)
      PERFORM public.hr_leave_check(NEW.user_id, NEW.leave_type_id, NEW.start_date, NEW.end_date, OLD.id, false);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_leave_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS hr_leave_guard ON public.leave_requests;
CREATE TRIGGER hr_leave_guard BEFORE INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION public.hr_leave_guard();
