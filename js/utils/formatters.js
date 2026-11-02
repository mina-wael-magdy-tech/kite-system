/**
 * KITE SYSTEM — Display Formatters
 * Badge rendering, status indicators, and UI formatting mappings.
 */

import { escapeHTML } from './helpers.js';

export function formatTaskStatusBadge(status) {
  const map = {
    backlog:           { label: 'Backlog',           cls: 'badge-slate' },
    todo:              { label: 'To Do',              cls: 'badge-slate' },
    in_progress:       { label: 'In Production',      cls: 'badge-sky' },
    under_review:      { label: 'Creative Review',    cls: 'badge-amber' },
    changes_requested: { label: 'Changes Requested', cls: 'badge-rose' },
    approved:          { label: 'Approved',           cls: 'badge-emerald' },
    completed:         { label: 'Completed',          cls: 'badge-emerald' },
    cancelled:         { label: 'Cancelled',          cls: 'badge-rose' },
    on_hold:           { label: 'On Hold',            cls: 'badge-slate' }
  };

  const item = map[status] || { label: status, cls: 'badge-slate' };
  return `<span class="badge ${item.cls}">${escapeHTML(item.label)}</span>`;
}

export function formatPriorityBadge(priority) {
  const map = {
    urgent: { label: '🔥 Urgent', cls: 'badge-rose' },
    high:   { label: '⚡ High',   cls: 'badge-amber' },
    medium: { label: '📌 Medium', cls: 'badge-sky' },
    low:    { label: '🌿 Low',    cls: 'badge-slate' }
  };

  const key = String(priority || '').toLowerCase();
  const item = map[key] || map.medium;
  return `<span class="badge ${item.cls}">${escapeHTML(item.label)}</span>`;
}

export function formatEmploymentStatusBadge(status) {
  const map = {
    active:     { label: 'Active',     cls: 'badge-emerald' },
    onboarding: { label: 'Onboarding', cls: 'badge-sky' },
    suspended:  { label: 'Suspended',  cls: 'badge-rose' },
    inactive:   { label: 'Inactive',   cls: 'badge-slate' }
  };

  const item = map[status] || { label: status, cls: 'badge-slate' };
  return `<span class="badge ${item.cls}">${escapeHTML(item.label)}</span>`;
}

export function formatExpenseStatusBadge(status) {
  const map = {
    draft:     { label: 'Draft',     cls: 'badge-slate' },
    submitted: { label: 'Submitted', cls: 'badge-amber' },
    approved:  { label: 'Approved',  cls: 'badge-sky' },
    rejected:  { label: 'Rejected',  cls: 'badge-rose' },
    paid:      { label: 'Paid',      cls: 'badge-emerald' }
  };

  const item = map[status] || { label: status, cls: 'badge-slate' };
  return `<span class="badge ${item.cls}">${escapeHTML(item.label)}</span>`;
}

export function formatLeadStageBadge(stage) {
  const map = {
    new:           { label: 'New Lead',      cls: 'badge-slate' },
    contacted:     { label: 'Contacted',     cls: 'badge-sky' },
    qualified:     { label: 'Qualified',     cls: 'badge-indigo' },
    proposal_sent: { label: 'Proposal Sent', cls: 'badge-purple' },
    negotiation:   { label: 'Negotiation',   cls: 'badge-amber' },
    won:           { label: 'Won',           cls: 'badge-emerald' },
    lost:          { label: 'Lost',          cls: 'badge-rose' }
  };

  const item = map[stage] || { label: stage, cls: 'badge-slate' };
  return `<span class="badge ${item.cls}">${escapeHTML(item.label)}</span>`;
}
