// PULSE STUDIO OS — Edge Function: workflow
//
// All business rules for state-changing operations live HERE, not in SQL:
//   task.create | task.set_status | task.reassign | task.update | task.delete
//   expense.decide | leave.decide | employee.update
//
// Pattern for every action:
//   1. authenticate the caller (JWT -> profile + roles, server-side)
//   2. validate input
//   3. authorize (user-scoped client = RLS answers "may they see it?";
//      role/ownership rules are enforced here)
//   4. mutate with the service role using conditional updates (race-safe)
//   5. write activity log + notifications + audit trail
//
// Request:  POST { "action": "task.create", ...params }
// Response: { "success": true, ...result } | { "error": "..." }

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { activeRoleNames, adminClient, ADMIN_ROLES, assertCanGrantRole, assertCanManageAccount, assertNotLastActiveSuperAdmin, audit, Caller, canManageEmployees, EXECUTIVE_ROLES, getCaller, isExecutive, notify, replaceUserRole, requireStaff, userClient, userIdsWithRoles } from "../_shared/auth.ts";
import * as v from "../_shared/validate.ts";
import { isAllowedPushEndpoint, pushConfigured, sendPush } from "../_shared/push.ts";
import { drainStorageCleanup } from "../_shared/storage-cleanup.ts";
import { mayRunStorageCleanup } from "../_shared/authz.ts";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const TASK_STATUSES = [
  "backlog", "todo", "in_progress", "under_review", "changes_requested",
  "approved", "completed", "cancelled", "on_hold",
] as const;
type TaskStatus = typeof TASK_STATUSES[number];

// Allowed lifecycle transitions. Admins may override (see canTransition).
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo", "cancelled"],
  todo: ["backlog", "in_progress", "on_hold", "cancelled"],
  in_progress: ["todo", "under_review", "on_hold", "cancelled"],
  under_review: ["in_progress", "changes_requested", "approved", "completed"],
  changes_requested: ["in_progress", "under_review"],
  approved: ["completed", "in_progress"],
  completed: ["in_progress"],
  cancelled: ["backlog"],
  on_hold: ["todo", "in_progress", "cancelled"],
};
// Moves that finalize work or reopen it require a reviewer.
const REVIEW_GATED: TaskStatus[] = ["approved", "completed"];

interface TaskRow {
  id: string;
  task_number: string;
  title: string;
  status: TaskStatus;
  assigned_to: string | null;
  created_by: string;
  department_id: string | null;
  project_id: string | null;
}

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  requireStaff(caller);

  const body = await readJson(req);
  switch (body.action) {
    case "task.create": return json(req, await taskCreate(req, admin, caller, body));
    case "task.set_status": return json(req, await taskSetStatus(req, admin, caller, body));
    case "task.reassign": return json(req, await taskReassign(req, admin, caller, body));
    case "task.update": return json(req, await taskUpdate(req, admin, caller, body));
    case "task.delete": return json(req, await taskDelete(req, admin, caller, body));
    case "employee.update": return json(req, await employeeUpdate(req, admin, caller, body));
    case "push.subscribe": return json(req, await pushSubscribe(admin, caller, body));
    case "push.unsubscribe": return json(req, await pushUnsubscribe(admin, caller, body));
    case "push.test": return json(req, await pushTest(admin, caller));
    case "expense.decide": return json(req, await expenseDecide(req, admin, caller, body));
    case "expense.submit": return json(req, await expenseSubmit(req, admin, caller, body));
    case "expense.pay": return json(req, await expensePay(req, admin, caller, body));
    case "storage.cleanup":
      // deletes files with the service role: active administrators only (Phase 7)
      if (!mayRunStorageCleanup(caller.status, caller.roles, ADMIN_ROLES)) throw new HttpError(403, "Only an administrator can run the storage clean-up");
      return json(req, { success: true, ...(await drainStorageCleanup(admin, 100)) });
    case "leave.decide": return json(req, await leaveDecide(req, admin, caller, body));
    case "task.comment": return json(req, await taskComment(admin, caller, body));
    case "task.file_added": return json(req, await taskFileAdded(admin, caller, body));
    case "leave.submitted": return json(req, await leaveSubmitted(admin, caller, body));
    case "expense.submitted": return json(req, await expenseSubmitted(admin, caller, body));
    default: throw new HttpError(400, "Unknown action");
  }
});

// ---------------------------------------------------------------- helpers

/** The task, only if RLS lets the caller see it (single source of truth for visibility). */
async function loadVisibleTask(caller: Caller, taskId: string): Promise<TaskRow> {
  const { data, error } = await userClient(caller.token)
    .from("tasks")
    .select("id, task_number, title, status, assigned_to, created_by, department_id, project_id")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Task not found");
  return data as TaskRow;
}

async function isDeptManager(admin: SupabaseClient, userId: string, deptId: string | null): Promise<boolean> {
  if (!deptId) return false;
  const { data } = await admin.from("departments").select("id").eq("id", deptId).eq("manager_id", userId).maybeSingle();
  return !!data;
}

async function isProjectManager(admin: SupabaseClient, userId: string, projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  const { data } = await admin.from("projects").select("id").eq("id", projectId).eq("project_manager_id", userId).maybeSingle();
  return !!data;
}

/** Reviewer = may finalize / reassign: admin, department manager, project manager, or creator who is not the assignee. */
async function isReviewer(admin: SupabaseClient, caller: Caller, t: TaskRow): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (t.created_by === caller.id && t.assigned_to !== caller.id) return true;
  return (await isDeptManager(admin, caller.id, t.department_id)) ||
    (await isProjectManager(admin, caller.id, t.project_id));
}

async function isParticipant(admin: SupabaseClient, caller: Caller, t: TaskRow): Promise<boolean> {
  if (t.assigned_to === caller.id || t.created_by === caller.id) return true;
  const { data } = await admin.from("task_assignees").select("id").eq("task_id", t.id).eq("user_id", caller.id).maybeSingle();
  return !!data;
}

async function requireActiveStaffMember(admin: SupabaseClient, userId: string, label: string) {
  const { data: p } = await admin.from("profiles").select("id, department_id, employment_status").eq("id", userId).maybeSingle();
  if (!p || p.employment_status !== "active") throw new HttpError(400, `${label} must be an active employee`);
  const { data: roles } = await admin.from("user_roles").select("roles(name)").eq("user_id", userId);
  // deno-lint-ignore no-explicit-any
  if (!(roles ?? []).some((r: any) => r.roles && r.roles.name !== "client")) {
    throw new HttpError(400, `${label} must be an internal staff member`);
  }
  return p as { id: string; department_id: string | null };
}

async function logTask(admin: SupabaseClient, taskId: string, userId: string, action: string, oldValue: unknown, newValue: unknown) {
  const { error } = await admin.from("task_activity_logs").insert({
    task_id: taskId, user_id: userId, action, old_value: oldValue, new_value: newValue,
  });
  if (error) console.error("task activity insert failed:", error.message);
}

// ---------------------------------------------------------------- task.create

async function taskCreate(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const title = v.text(b.title, "title", 1, 200);
  const description = v.optText(b.description, "description", 5000);
  const assignedTo = v.uuid(b.assignedTo, "assignedTo");
  const projectId = v.optUuid(b.projectId, "projectId");
  const priority = b.priority === undefined ? "medium" : v.oneOf(b.priority, PRIORITIES, "priority");
  const dueDate = v.isoDate(b.dueDate, "dueDate");

  const assignee = await requireActiveStaffMember(admin, assignedTo, "Assignee");

  // Task department: the assignee's primary one, or any other department they belong to.
  let taskDeptId = assignee.department_id;
  const requestedDept = v.optUuid(b.departmentId, "departmentId");
  if (requestedDept && requestedDept !== assignee.department_id) {
    const { data: member } = await admin.from("user_departments").select("id").eq("user_id", assignedTo).eq("department_id", requestedDept).maybeSingle();
    if (!member) throw new HttpError(400, "The assignee is not a member of that department");
    taskDeptId = requestedDept;
  }

  if (projectId) {
    // RLS decides whether this caller may see (and therefore attach to) the project.
    const { data } = await userClient(caller.token).from("projects").select("id").eq("id", projectId).maybeSingle();
    if (!data) throw new HttpError(404, "Project not found");
  }

  const { data: task, error } = await admin.from("tasks").insert({
    title,
    description,
    assigned_to: assignedTo,
    department_id: taskDeptId, // validated server-side against the assignee's departments
    project_id: projectId,
    priority,
    due_date: dueDate,
    status: "todo",
    created_by: caller.id,
  }).select("id, task_number, title, status, assigned_to, department_id, project_id, priority, due_date").single();
  if (error) throw error;

  await logTask(admin, task.id, caller.id, "CREATED", null, { status: "todo", assigned_to: assignedTo });
  if (assignedTo !== caller.id) {
    await notify(admin, {
      userId: assignedTo, type: "task_assigned",
      title: `New Task Assigned: ${task.task_number}`, content: title, link: "#tasks",
    });
  }
  await audit(admin, { userId: caller.id, action: "TASK_CREATED", entityType: "tasks", entityId: task.id, newData: { task_number: task.task_number, assigned_to: assignedTo } }, req);
  return { success: true, task };
}

// ---------------------------------------------------------------- task.set_status

async function taskSetStatus(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const taskId = v.uuid(b.taskId, "taskId");
  const next = v.oneOf(b.status, TASK_STATUSES, "status");
  const task = await loadVisibleTask(caller, taskId);

  if (task.status === next) return { success: true, unchanged: true };

  const reviewer = await isReviewer(admin, caller, task);
  const participant = reviewer || await isParticipant(admin, caller, task);
  if (!participant) throw new HttpError(403, "You are not allowed to change this task");

  // Self-created, self-assigned work can be finalized by its owner; otherwise a reviewer must.
  const selfOwned = task.created_by === caller.id && task.assigned_to === caller.id;
  if (REVIEW_GATED.includes(next) && !reviewer && !selfOwned) {
    throw new HttpError(403, "Only a manager, project manager or the task creator can approve or complete this task");
  }
  if (task.status === "completed" && !reviewer && !selfOwned) {
    throw new HttpError(403, "Only a reviewer can reopen a completed task");
  }
  if (!caller.isAdmin && !TRANSITIONS[task.status].includes(next)) {
    throw new HttpError(400, `Cannot move a task from ${task.status} to ${next}`);
  }

  // Conditional update: fails cleanly if someone else changed the status meanwhile.
  const { data: updated, error } = await admin.from("tasks")
    .update({ status: next })
    .eq("id", taskId).eq("status", task.status)
    .select("id").maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, "Task was changed by someone else; refresh and retry");

  await logTask(admin, taskId, caller.id, "STATUS_CHANGE", { status: task.status }, { status: next });

  const label = next.replace(/_/g, " ").toUpperCase();
  const recipients = new Set([task.created_by, task.assigned_to].filter((x): x is string => !!x && x !== caller.id));
  for (const userId of recipients) {
    await notify(admin, {
      userId, type: "task_status_updated",
      title: `Task Status Updated: ${task.task_number}`, content: `Status changed to ${label}`, link: "#tasks",
    });
  }
  await audit(admin, { userId: caller.id, action: "TASK_STATUS_CHANGED", entityType: "tasks", entityId: taskId, oldData: { status: task.status }, newData: { status: next } }, req);
  return { success: true, status: next };
}

// ---------------------------------------------------------------- task.reassign

async function taskReassign(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const taskId = v.uuid(b.taskId, "taskId");
  const assigneeId = v.uuid(b.assigneeId, "assigneeId");
  const task = await loadVisibleTask(caller, taskId);

  if (!(await isReviewer(admin, caller, task))) {
    throw new HttpError(403, "Only a manager or the task creator can reassign this task");
  }
  await requireActiveStaffMember(admin, assigneeId, "New assignee");
  if (task.assigned_to === assigneeId) return { success: true, unchanged: true };

  let q = admin.from("tasks").update({ assigned_to: assigneeId }).eq("id", taskId);
  q = task.assigned_to === null ? q.is("assigned_to", null) : q.eq("assigned_to", task.assigned_to);
  const { data: updated, error } = await q.select("id").maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, "Task was changed by someone else; refresh and retry");

  await logTask(admin, taskId, caller.id, "REASSIGNMENT", { assigned_to: task.assigned_to }, { assigned_to: assigneeId });
  if (assigneeId !== caller.id) {
    await notify(admin, {
      userId: assigneeId, type: "task_assigned",
      title: `New Task Assigned: ${task.task_number}`, content: task.title, link: "#tasks",
    });
  }
  await audit(admin, { userId: caller.id, action: "TASK_REASSIGNED", entityType: "tasks", entityId: taskId, oldData: { assigned_to: task.assigned_to }, newData: { assigned_to: assigneeId } }, req);
  return { success: true };
}

// ---------------------------------------------------------------- expense.decide

async function expenseDecide(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const expenseId = v.uuid(b.expenseId, "expenseId");
  const decision = v.oneOf(b.decision, ["approved", "rejected"] as const, "decision");
  const notes = v.optText(b.notes, "notes", 1000);

  // Finance data is executive-only (super_admin, owner, ceo): only they may see and decide expense claims
  if (!isExecutive(caller)) {
    throw new HttpError(403, "Finance privilege required");
  }
  const { data: exp } = await admin.from("expenses").select("id, title, status, submitted_by").eq("id", expenseId).maybeSingle();
  if (!exp) throw new HttpError(404, "Expense not found");
  // One SQL transaction: lock the claim, check it is still "submitted", change the status AND write the approval record.
  await expenseRpc(admin, "expense_decide", { p_actor: caller.id, p_expense: expenseId, p_decision: decision, p_notes: notes });
  await notify(admin, {
    userId: exp.submitted_by, type: "expense_decision",
    title: `Expense ${decision}`, content: exp.title, link: "#finance",
    dedupeKey: `expense_decision:${expenseId}:${decision}`,   // a claim is decided once
  });
  await audit(admin, { userId: caller.id, action: `EXPENSE_${decision.toUpperCase()}`, entityType: "expenses", entityId: expenseId, oldData: { status: "submitted" }, newData: { status: decision } }, req);
  return { success: true, status: decision };
}

/** Calls an expense SQL function; its stable error codes (migration 031) become HTTP statuses. */
async function expenseRpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (!error) return data;
  const m = /^expense_(\w+):\s*(.*)$/s.exec(error.message ?? "");
  if (m) {
    const status = ({ forbidden: 403, self_decision: 403, not_found: 404, already_decided: 409, not_approved: 409, bad_decision: 400 } as Record<string, number>)[m[1]] ?? 400;
    throw new HttpError(status, m[2]);
  }
  throw error;
}

async function expenseSubmit(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const expenseId = v.uuid(b.expenseId, "expenseId");
  await expenseRpc(admin, "expense_submit", { p_actor: caller.id, p_expense: expenseId });
  await audit(admin, { userId: caller.id, action: "EXPENSE_SUBMITTED", entityType: "expenses", entityId: expenseId, oldData: { status: "draft" }, newData: { status: "submitted" } }, req);
  return { success: true, status: "submitted" };
}

async function expensePay(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const expenseId = v.uuid(b.expenseId, "expenseId");
  if (!isExecutive(caller)) throw new HttpError(403, "Finance privilege required");   // Finance data is executive-only
  const { data: exp } = await admin.from("expenses").select("id, title, submitted_by").eq("id", expenseId).maybeSingle();
  if (!exp) throw new HttpError(404, "Expense not found");
  await expenseRpc(admin, "expense_mark_paid", { p_actor: caller.id, p_expense: expenseId });
  await audit(admin, { userId: caller.id, action: "EXPENSE_PAID", entityType: "expenses", entityId: expenseId, oldData: { status: "approved" }, newData: { status: "paid" } }, req);
  return { success: true, status: "paid" };
}

// ---------------------------------------------------------------- leave.decide

async function leaveDecide(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const leaveId = v.uuid(b.leaveId, "leaveId");
  const decision = v.oneOf(b.decision, ["approved", "rejected"] as const, "decision");
  const notes = v.optText(b.notes, "notes", 1000);

  if (!(caller.isAdmin || caller.has("hr_manager"))) throw new HttpError(403, "HR privilege required");

  const { data: lr } = await admin.from("leave_requests").select("id, user_id, status").eq("id", leaveId).maybeSingle();
  if (!lr) throw new HttpError(404, "Leave request not found");
  if (lr.user_id === caller.id) throw new HttpError(403, "You cannot decide on your own leave request");
  if (lr.status !== "pending") throw new HttpError(409, `Leave request is already ${lr.status}`);

  const { data: updated, error } = await admin.from("leave_requests")
    .update({ status: decision, reviewed_by: caller.id, reviewed_at: new Date().toISOString(), reviewer_notes: notes })
    .eq("id", leaveId).eq("status", "pending").select("id").maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, "Leave request was already decided");

  await notify(admin, {
    userId: lr.user_id, type: "leave_decision",
    title: `Leave request ${decision}`, content: notes ?? `Your leave request was ${decision}.`, link: "#hr",
    dedupeKey: `leave_decision:${leaveId}`,   // a request is decided once (pending -> decided)
  });
  await audit(admin, { userId: caller.id, action: `LEAVE_${decision.toUpperCase()}`, entityType: "leave_requests", entityId: leaveId, oldData: { status: "pending" }, newData: { status: decision } }, req);
  return { success: true, status: decision };
}

// ---------------------------------------------------------------- task.update

async function taskUpdate(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const taskId = v.uuid(b.taskId, "taskId");
  const task = await loadVisibleTask(caller, taskId);
  const allowed = (await isReviewer(admin, caller, task)) || (await isParticipant(admin, caller, task));
  if (!allowed) throw new HttpError(403, "You are not allowed to edit this task");

  const patch: Record<string, unknown> = {};
  if ("title" in b) patch.title = v.text(b.title, "title", 1, 200);
  if ("description" in b) patch.description = v.optText(b.description, "description", 5000);
  if ("priority" in b) patch.priority = v.oneOf(b.priority, PRIORITIES, "priority");
  if ("dueDate" in b) patch.due_date = v.isoDate(b.dueDate, "dueDate");
  if ("projectId" in b) {
    const projectId = v.optUuid(b.projectId, "projectId");
    if (projectId) {
      const { data } = await userClient(caller.token).from("projects").select("id").eq("id", projectId).maybeSingle();
      if (!data) throw new HttpError(404, "Project not found");
    }
    patch.project_id = projectId;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update");

  const cols = Object.keys(patch).join(", ");
  const { data: before } = await admin.from("tasks").select(cols).eq("id", taskId).single();
  const { error } = await admin.from("tasks").update(patch).eq("id", taskId);
  if (error) throw error;

  await logTask(admin, taskId, caller.id, "EDITED", before, patch);
  {
    const changed: string[] = [];
    if ("title" in patch) changed.push("title");
    if ("priority" in patch) changed.push(`priority → ${patch.priority}`);
    if ("due_date" in patch) changed.push(`deadline → ${patch.due_date}`);
    if ("description" in patch) changed.push("brief");
    if ("project_id" in patch) changed.push("project");
    const who = await personName(admin, caller.id);
    for (const userId of await taskAudience(admin, task, caller.id)) {
      await notify(admin, {
        userId, type: "task_updated", title: `Task updated: ${task.task_number}`,
        content: `${who} changed ${changed.join(", ")} — ${task.title}`, link: "#tasks", metadata: { task_id: taskId },
      });
    }
  }
  await audit(admin, { userId: caller.id, action: "TASK_EDITED", entityType: "tasks", entityId: taskId, oldData: before, newData: patch }, req);
  return { success: true };
}

// ---------------------------------------------------------------- task.delete

async function taskDelete(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const taskId = v.uuid(b.taskId, "taskId");
  const task = await loadVisibleTask(caller, taskId);
  const allowed = caller.isAdmin || task.created_by === caller.id ||
    (await isDeptManager(admin, caller.id, task.department_id)) ||
    (await isProjectManager(admin, caller.id, task.project_id));
  if (!allowed) throw new HttpError(403, "Only an admin, a manager or the task creator can delete this task");

  // The database row goes FIRST (a trigger queues its files in the same transaction), then the files are removed.
  // If the task has billing or time history the database refuses and nothing is touched.
  const who = await personName(admin, caller.id);
  const audience = await taskAudience(admin, task, caller.id);   // read before the delete: the assignee rows go with the task
  const taskFiles = await admin.from("task_attachments").select("id", { count: "exact", head: true }).eq("task_id", taskId);
  const fileCount = taskFiles.count ?? 0;
  const { error } = await admin.from("tasks").delete().eq("id", taskId);
  if (error) {
    if (/record_has_history/.test(error.message)) throw new HttpError(409, "This task has billing or time history and cannot be deleted. Cancel it instead.");
    throw error;
  }
  for (const userId of audience) {
    await notify(admin, {
      userId, type: "task_deleted", title: `Task removed: ${task.task_number}`,
      content: `${who} deleted “${task.title}”`, link: "#tasks",
      dedupeKey: `task_deleted:${taskId}`,   // a task is deleted once
    });
  }
  await drainStorageCleanup(admin);   // best effort; anything that fails stays queued and is retried by the daily job

  await audit(admin, {
    userId: caller.id, action: "TASK_DELETED", entityType: "tasks", entityId: taskId,
    oldData: { task_number: task.task_number, title: task.title, status: task.status, files: fileCount },
  }, req);
  return { success: true };
}

// ---------------------------------------------------------------- employee.update

const EMPLOYMENT_STATUSES = ["active", "inactive", "suspended"] as const;

async function employeeUpdate(req: Request, admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  if (!canManageEmployees(caller)) throw new HttpError(403, "Admin or HR privilege required");
  const userId = v.uuid(b.userId, "userId");
  const isSelf = userId === caller.id;

  const { data: target } = await admin.from("profiles")
    .select("id, full_name, job_title, department_id, employment_status").eq("id", userId).maybeSingle();
  if (!target) throw new HttpError(404, "Employee not found");

  const targetRoles = await activeRoleNames(admin, userId);
  // Tier rule (see _shared/auth.ts): only an equal-or-higher tier may touch this account
  assertCanManageAccount(caller, targetRoles);

  const patch: Record<string, unknown> = {};
  let primaryDept: { id: string | null } | null = null;   // department changes go through ONE SQL transaction (migration 032)
  if ("fullName" in b) patch.full_name = v.text(b.fullName, "fullName", 2, 120);
  if ("jobTitle" in b) patch.job_title = v.optText(b.jobTitle, "jobTitle", 100);
  if ("departmentId" in b) {
    const deptId = v.optUuid(b.departmentId, "departmentId");
    if (deptId) {
      const { data: d } = await admin.from("departments").select("id").eq("id", deptId).maybeSingle();
      if (!d) throw new HttpError(400, "Unknown department");
    }
    primaryDept = { id: deptId };
  }

  // Multiple departments: the first one is the primary (profiles.department_id)
  let deptIds: string[] | null = null;
  if (Array.isArray(b.departmentIds)) {
    deptIds = [...new Set(b.departmentIds.map((x) => v.uuid(x, "departmentIds")))];
    if (deptIds.length > 50) throw new HttpError(400, "Too many departments (maximum 50)");
    if (deptIds.length) {
      const { data: found } = await admin.from("departments").select("id").in("id", deptIds);
      if ((found?.length ?? 0) !== deptIds.length) throw new HttpError(400, "Unknown department");
    }
  }

  let newStatus: typeof EMPLOYMENT_STATUSES[number] | null = null;
  if ("employmentStatus" in b) {
    newStatus = v.oneOf(b.employmentStatus, EMPLOYMENT_STATUSES, "employmentStatus");
    if (isSelf && newStatus !== "active") throw new HttpError(400, "You cannot deactivate your own account");
    if (newStatus !== target.employment_status) patch.employment_status = newStatus;
    // the last active super administrator can never be disabled
    if (newStatus !== "active" && newStatus !== target.employment_status) await assertNotLastActiveSuperAdmin(admin, userId);
  }

  let newRole: { id: string; name: string } | null = null;
  if ("roleId" in b && b.roleId) {
    const roleId = v.uuid(b.roleId, "roleId");
    if (isSelf) throw new HttpError(400, "You cannot change your own role");
    const { data: role } = await admin.from("roles").select("id, name, is_active").eq("id", roleId).maybeSingle();
    if (!role || !role.is_active) throw new HttpError(400, "Unknown or inactive role");
    assertCanGrantRole(caller, role.name);
    if (!(targetRoles.length === 1 && targetRoles[0] === role.name)) newRole = { id: role.id, name: role.name };
    // never demote the last active super admin (the DB function re-checks this under a lock)
    if (newRole && targetRoles.includes("super_admin") && role.name !== "super_admin") await assertNotLastActiveSuperAdmin(admin, userId);
  }
  if (Object.keys(patch).length === 0 && !newRole && !deptIds && !primaryDept) return { success: true, unchanged: true };

  if (Object.keys(patch).length) {
    const { error } = await admin.from("profiles").update(patch).eq("id", userId);
    if (error) {
      // the database guard (migration 023) refused: a concurrent request just removed the other active super_admin
      if (/last_super_admin/.test(error.message)) throw new HttpError(409, "Cannot remove, disable or delete the last active super administrator");
      throw error;
    }
  }
  if (deptIds || primaryDept) {
    const { error: dErr } = deptIds
      ? await admin.rpc("set_user_departments", { p_user: userId, p_depts: deptIds })
      : await admin.rpc("set_primary_department", { p_user: userId, p_dept: primaryDept!.id });
    if (dErr) throw /Unknown department|Too many/.test(dErr.message) ? new HttpError(400, dErr.message) : dErr;
  }
  if (newRole) {
    // one transaction: a failure leaves the previous role untouched
    await replaceUserRole(admin, userId, newRole.id, caller.id);
  }
  // Deactivated people can no longer sign in or refresh a session.
  if (newStatus && "employment_status" in patch) {
    const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: newStatus === "active" ? "none" : "87600h" });
    if (error) console.error("ban update failed:", error.message);
  }

  if (newRole && !isSelf) {
    await notify(admin, { userId, type: "role_changed", title: "Your role was updated", content: `You are now: ${newRole.name.replace(/_/g, " ")}`, link: "#dashboard" });
  }
  await audit(admin, {
    userId: caller.id, action: "EMPLOYEE_UPDATED", entityType: "profiles", entityId: userId,
    oldData: {
      full_name: target.full_name, job_title: target.job_title, department_id: target.department_id,
      employment_status: target.employment_status, roles: targetRoles,
    },
    newData: { ...patch, ...(deptIds ? { department_ids: deptIds } : primaryDept ? { department_id: primaryDept.id } : {}), role: newRole?.name },
  }, req);
  return { success: true };
}

// ---------------------------------------------------------------- notification helpers

async function personName(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.from("profiles").select("full_name").eq("id", userId).maybeSingle();
  return data?.full_name ?? "Someone";
}

/** Everyone involved in a task (assignee, creator, extra assignees) except the person acting. */
async function taskAudience(admin: SupabaseClient, t: TaskRow, actorId: string): Promise<string[]> {
  const { data: extra } = await admin.from("task_assignees").select("user_id").eq("task_id", t.id);
  const ids = new Set<string>([t.assigned_to, t.created_by, ...(extra ?? []).map((r: { user_id: string }) => r.user_id)].filter((x): x is string => !!x));
  ids.delete(actorId);
  return [...ids];
}

// ---------------------------------------------------------------- task.comment

async function taskComment(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const taskId = v.uuid(b.taskId, "taskId");
  const content = v.text(b.content, "content", 1, 4000);
  const task = await loadVisibleTask(caller, taskId); // RLS: only people who can see the task may comment
  const { data: comment, error } = await admin.from("task_comments")
    .insert({ task_id: taskId, user_id: caller.id, content }).select("id").single();
  if (error) throw error;

  const who = await personName(admin, caller.id);
  const preview = content.length > 110 ? content.slice(0, 107) + "…" : content;
  for (const userId of await taskAudience(admin, task, caller.id)) {
    await notify(admin, {
      userId, type: "task_comment", title: `${who} commented on ${task.task_number}`,
      content: preview, link: "#tasks", metadata: { task_id: taskId },
      dedupeKey: `task_comment:${comment.id}`,   // the comment row is the event
    });
  }
  return { success: true, id: comment.id };
}

// ---------------------------------------------------------------- task.file_added

async function taskFileAdded(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const taskId = v.uuid(b.taskId, "taskId");
  const fileName = v.text(b.fileName, "fileName", 1, 200);
  const task = await loadVisibleTask(caller, taskId);
  const who = await personName(admin, caller.id);
  for (const userId of await taskAudience(admin, task, caller.id)) {
    await notify(admin, {
      userId, type: "task_file", title: `New file on ${task.task_number}`,
      content: `${who} uploaded ${fileName}`, link: "#documents", metadata: { task_id: taskId },
    });
  }
  return { success: true };
}

// ---------------------------------------------------------------- leave.submitted / expense.submitted
// The row is created by the browser (RLS); these tell the approvers. They only fire for a fresh row
// that belongs to the caller, so they cannot be used to spam people.

async function leaveSubmitted(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const leaveId = v.uuid(b.leaveId, "leaveId");
  const { data: lr } = await admin.from("leave_requests").select("id, user_id, status, start_date, end_date, total_days, created_at").eq("id", leaveId).maybeSingle();
  if (!lr || lr.user_id !== caller.id || lr.status !== "pending") throw new HttpError(404, "Leave request not found");
  if (Date.now() - new Date(lr.created_at).getTime() > 10 * 60_000) return { success: true, skipped: true };
  const who = await personName(admin, caller.id);
  const approvers = new Set(await userIdsWithRoles(admin, [...ADMIN_ROLES, "hr_manager"]));
  approvers.delete(caller.id);
  for (const userId of approvers) {
    await notify(admin, {
      userId, type: "leave_request", title: "Leave request to review",
      content: `${who}: ${lr.total_days} day(s), ${lr.start_date} → ${lr.end_date}`, link: "#hr",
      dedupeKey: `leave_request:${leaveId}`,   // fires only within 10 minutes of creating the row; a repeat is the same event
    });
  }
  return { success: true };
}

async function expenseSubmitted(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const expenseId = v.uuid(b.expenseId, "expenseId");
  const { data: ex } = await admin.from("expenses").select("id, title, amount, currency, submitted_by, status, created_at").eq("id", expenseId).maybeSingle();
  if (!ex || ex.submitted_by !== caller.id || ex.status !== "submitted") throw new HttpError(404, "Expense not found");
  if (Date.now() - new Date(ex.created_at).getTime() > 10 * 60_000) return { success: true, skipped: true };
  const who = await personName(admin, caller.id);
  // the claim carries an amount: only executives (who may view Finance data) are told
  const approvers = new Set(await userIdsWithRoles(admin, EXECUTIVE_ROLES));
  approvers.delete(caller.id);
  for (const userId of approvers) {
    await notify(admin, {
      userId, type: "expense_request", title: "Expense claim to approve",
      content: `${who}: ${ex.title} (${ex.currency} ${ex.amount})`, link: "#finance",
      dedupeKey: `expense_request:${expenseId}`,   // same event, same key
    });
  }
  return { success: true };
}

// ---------------------------------------------------------------- push.*

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

async function pushSubscribe(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const endpoint = v.text(b.endpoint, "endpoint", 20, 2048);
  const p256dh = v.text(b.p256dh, "p256dh", 20, 200);
  const auth = v.text(b.auth, "auth", 10, 100);
  if (!isAllowedPushEndpoint(endpoint)) throw new HttpError(400, "Unsupported push service");
  if (!B64URL.test(p256dh) || !B64URL.test(auth)) throw new HttpError(400, "Invalid subscription keys");
  const userAgent = typeof b.userAgent === "string" ? b.userAgent.slice(0, 250) : null;

  // An endpoint identifies a browser profile. If another account used it before (shared device),
  // ownership moves to the person who is signed in now: the previous user stops receiving it.
  const { error } = await admin.from("push_subscriptions").upsert(
    { user_id: caller.id, endpoint, p256dh, auth, user_agent: userAgent, last_seen_at: new Date().toISOString() },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
  await prunePushSubscriptions(admin, caller.id, userAgent);
  return { success: true, configured: pushConfigured() };
}

// Each reinstall / re-enable on the same device creates a new subscription and leaves the old one behind, which then
// buzzes the phone again for every message. Devices of the same kind share a user agent and cannot be told apart, so
// we never collapse to one (a second PC would lose its alerts): we keep the newest few per user agent and drop
// anything not seen for 60 days. Best effort: a failure here must never break subscribing.
const MAX_SUBS_PER_DEVICE_TYPE = 3;
const STALE_AFTER_DAYS = 60;

async function prunePushSubscriptions(admin: SupabaseClient, userId: string, userAgent: string | null) {
  try {
    const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 864e5).toISOString();
    await admin.from("push_subscriptions").delete().eq("user_id", userId).lt("last_seen_at", cutoff);
    if (!userAgent) return;
    const { data } = await admin.from("push_subscriptions").select("id")
      .eq("user_id", userId).eq("user_agent", userAgent).order("last_seen_at", { ascending: false });
    const extra = (data ?? []).slice(MAX_SUBS_PER_DEVICE_TYPE).map((r: { id: string }) => r.id);
    if (extra.length) await admin.from("push_subscriptions").delete().in("id", extra);
  } catch (err) {
    console.error("push prune failed:", (err as Error)?.message);
  }
}

async function pushUnsubscribe(admin: SupabaseClient, caller: Caller, b: Record<string, unknown>) {
  const endpoint = v.text(b.endpoint, "endpoint", 20, 2048);
  const { error } = await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", caller.id);
  if (error) throw error;
  return { success: true };
}

async function pushTest(admin: SupabaseClient, caller: Caller) {
  if (!pushConfigured()) throw new HttpError(503, "Push notifications are not configured on the server yet");
  const { count } = await admin.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", caller.id);
  if (!count) throw new HttpError(409, "This device is not subscribed yet. Enable notifications first.");
  const result = await sendPush(admin, caller.id, {
    title: "Kite System", body: "Notifications are working on this device.", url: "#dashboard", tag: "push-test",
  });
  if (result.sent === 0) throw new HttpError(502, "The push service did not accept the message. Try turning notifications off and on again.");
  return { success: true, sent: result.sent };
}
