// PULSE STUDIO OS — Edge Function: workflow
//
// All business rules for state-changing operations live HERE, not in SQL:
//   task.create | task.set_status | task.reassign | expense.decide | leave.decide
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
import { adminClient, audit, Caller, getCaller, notify, requireStaff, userClient } from "../_shared/auth.ts";
import * as v from "../_shared/validate.ts";

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
    case "expense.decide": return json(req, await expenseDecide(req, admin, caller, body));
    case "leave.decide": return json(req, await leaveDecide(req, admin, caller, body));
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

  if (projectId) {
    // RLS decides whether this caller may see (and therefore attach to) the project.
    const { data } = await userClient(caller.token).from("projects").select("id").eq("id", projectId).maybeSingle();
    if (!data) throw new HttpError(404, "Project not found");
  }

  const { data: task, error } = await admin.from("tasks").insert({
    title,
    description,
    assigned_to: assignedTo,
    department_id: assignee.department_id, // derived server-side, never client-supplied
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

  if (!(caller.isAdmin || caller.has("finance_manager"))) {
    throw new HttpError(403, "Finance privilege required");
  }
  const { data: exp } = await admin.from("expenses").select("id, title, status, submitted_by").eq("id", expenseId).maybeSingle();
  if (!exp) throw new HttpError(404, "Expense not found");
  if (exp.submitted_by === caller.id) throw new HttpError(403, "You cannot decide on your own expense");
  if (exp.status !== "submitted") throw new HttpError(409, `Expense is already ${exp.status}`);

  const { data: updated, error } = await admin.from("expenses")
    .update({ status: decision }).eq("id", expenseId).eq("status", "submitted").select("id").maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, "Expense was already decided");

  await admin.from("expense_approvals").insert({ expense_id: expenseId, approver_id: caller.id, action: decision, notes });
  await notify(admin, {
    userId: exp.submitted_by, type: "expense_decision",
    title: `Expense ${decision}`, content: exp.title, link: "#finance",
  });
  await audit(admin, { userId: caller.id, action: `EXPENSE_${decision.toUpperCase()}`, entityType: "expenses", entityId: expenseId, oldData: { status: "submitted" }, newData: { status: decision } }, req);
  return { success: true, status: decision };
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
  });
  await audit(admin, { userId: caller.id, action: `LEAVE_${decision.toUpperCase()}`, entityType: "leave_requests", entityId: leaveId, oldData: { status: "pending" }, newData: { status: decision } }, req);
  return { success: true, status: decision };
}
