-- ====================================================================
-- Remove all test / mock records created while testing (prefix "ZZ-TEST"),
-- plus the activity those tests generated. Safe to re-run.
--
-- Keeps: roles, departments seeded by seed.sql, leave types, default channels,
--        company info, your admin account and its SYSTEM_INITIALIZED audit entry.
-- Since migration 029, tasks / clients / projects with billing or time history cannot be deleted: a test record that was
--        invoiced or timed makes its DELETE below stop with 'record_has_history' (cancel / archive it instead).
-- Not in this file: stored files (SQL cannot delete storage objects; deleting a row queues its file in storage_cleanup_queue).
--        Remove them with:  npx supabase storage rm -r ss:///task-attachments --experimental --linked
-- ====================================================================

-- chat messages written by tests (incl. task hand-off cards)
DELETE FROM public.messages WHERE content LIKE '%ZZ-TEST%';

-- tasks (cascades comments, checklists, time entries, activity logs, attachment rows, hand-offs)
DELETE FROM public.tasks WHERE title LIKE 'ZZ-TEST%';

DELETE FROM public.expenses        WHERE title LIKE 'ZZ-TEST%';
DELETE FROM public.leave_requests  WHERE reason LIKE 'ZZ-TEST%';
DELETE FROM public.leads           WHERE title LIKE 'ZZ-TEST%';
DELETE FROM public.clients         WHERE company_name LIKE 'ZZ-TEST%';
DELETE FROM public.campaigns       WHERE name LIKE 'ZZ-TEST%';
DELETE FROM public.projects        WHERE name LIKE 'ZZ-TEST%';
DELETE FROM public.departments     WHERE name LIKE 'ZZ-TEST%';

-- the admin's test check-in / check-out
DELETE FROM public.attendance_records
 WHERE user_id IN (SELECT id FROM public.profiles WHERE is_first_admin);

-- notifications and audit entries produced by the tests (keep the bootstrap record)
DELETE FROM public.notifications;
-- audit_logs is append-only since migration 033: this one-off clean-up switches the guard off for this statement and back on
ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_append_only;
DELETE FROM public.audit_logs WHERE action <> 'SYSTEM_INITIALIZED';
ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;

-- next task gets TSK-101 again
SELECT setval('public.task_number_seq', 101, false);
