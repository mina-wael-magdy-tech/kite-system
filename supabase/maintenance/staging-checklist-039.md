# Staging verification checklist: migration 039 (NOT executed; run only after local review and explicit approval)

Apply migrations on staging one at a time (no `db push`: the live migration history is empty). Never run this on production first.

## 0. Before applying (read-only)
1. Run the three diagnostics from the header of `039_task_attachments_storage_guard.sql`. Duplicate `storage_path` rows must be 0 (039 aborts otherwise).
2. List open queue rows for review: `SELECT id, path, source, enqueued_at FROM storage_cleanup_queue WHERE bucket='task-attachments' AND done_at IS NULL;` A path nobody deleted legitimately is possible exploit residue: remove it from the queue before applying.
3. Record the Storage server version and confirm the objects schema: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' ORDER BY ordinal_position;` (expect `owner_id text`).

## 1. owner_id population (decides whether Stage 1 legacy uploads may ever be enabled)
4. As a normal user, upload with the OLD client code path (legacy name) and with the Storage REST API and with a resumable (TUS) upload. For each: `SELECT name, owner_id, owner FROM storage.objects WHERE name = '<path>';` Expect `owner_id` = the user's uuid in ALL three. If any is NULL or different, the switch `task_attachments_legacy_paths` stays OFF and Stage 1 is a hard cutover.
5. Upload with a service-role key: record owner_id (expect NULL; confirms service uploads can never register legacy rows).

## 2. Apply 039 and check the schema
6. Apply only `039_task_attachments_storage_guard.sql`. Re-apply it once (idempotent).
7. `SELECT state, deletable, count(*) FROM storage_path_registry GROUP BY 1,2;` live count equals `SELECT count(*) FROM task_attachments`.
8. `SELECT count(*) FROM storage_cleanup_queue WHERE bucket='task-attachments' AND done_at IS NULL AND attempts=12;` matches the quarantine you expected.
9. `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'task_attachments_%';` three policies in the new form.

## 3. Storage API behaviour under the new policies (the assumptions local tests cannot prove)
10. New frontend, user A: upload a file in a task, attach it, reload, download (signed URL works), delete (row delete, then Storage remove). The object disappears immediately.
11. User B (task assignee): open the same task, download A's attached file. Expected OK.
12. User B: Storage `list` of the task folder: must NOT show A's unattached object. A's own `list` shows it.
13. User B: `remove` of A's object path: nothing removed. User B: upload with A's uid in the object name: rejected.
14. User C (no access to the task): `list`, `download`, `upload` into the task prefix all fail.
15. Confirm `storage.from(bucket).remove([path])` for the OWNER still works after the attachment row was deleted (it needs the SELECT policy). If it silently removes nothing, the cleanup worker is the fallback: check the file is gone after the next drain.
16. Admin: list, download, delete any task attachment.
17. Upload then make the row insert fail (e.g. forged `uploaded_by`): the client's cleanup `remove` deletes the orphan.

## 4. Attack replay (all must fail)
18. As B, insert a `task_attachments` row pointing at A's pending object path (legacy format and bound format): rejected both times.
19. As A, delete an attachment, then insert a row with the same path: rejected "already used".
20. As A, insert a row with a path from another task's prefix, a nested path, a path with a newline/space/quote: rejected.
21. Worker: run the storage cleanup drain; confirm it removes only the deleted attachment's object and nothing else. `SELECT * FROM storage_cleanup_status();`

## 5. Legacy and stale clients
22. With the previous frontend build cached in a second browser profile, upload a task file. Expected: refused with the message to refresh (switch OFF). Reload: works.
23. Existing legacy attachments: download and delete work; deleting a canonical one queues and removes its file, deleting a non-canonical one is NOT queued (`deletable=false`).
24. Only if step 4 proved owner_id reliable AND you decide to allow a grace period: `UPDATE storage_guard_settings SET enabled = true WHERE key = 'task_attachments_legacy_paths';` repeat 22 (accepted) and 18 (still rejected for someone else's object). Switch back off afterwards.

## 6. Other buckets
25. Delete a chat message with media, a studio asset and a content-post asset: each still queues and is drained.

## 7. Rollback rehearsal
26. Run `maintenance/rollback-039.sql` (expect the refusal), then with `SET kite.confirm_drop_storage_registry='yes';`. Re-apply 039. Note that tombstones are lost by a rollback.

## Stage 2 (later migration, after the transition is verified)
Remove the legacy branch from `task_attachment_path_kind`/the guard/the Storage INSERT policy and drop `storage_guard_settings`.
