/**
 * KITE SYSTEM — Module H: HR Operations
 * Attendance check-in/out, leave requests, manager approvals & studio holiday calendar.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';

export class HrModule {
  constructor(app) {
    this.app = app;
    this.attendanceToday = null;
    this.leaveRequests = [];
    this.leaveTypes = [];
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">HR Operations & Attendance</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Manage daily studio attendance, request leaves, and review staff time off.
            </p>
          </div>

          <button type="button" class="btn btn-primary btn-sm" id="btnRequestLeave">
            <i data-lucide="calendar-plus"></i> Request Time Off
          </button>
        </div>

        <!-- Attendance Quick Check-In Card -->
        <div class="glass-panel" style="padding: var(--space-5); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <div style="width: 44px; height: 44px; border-radius: var(--radius-xl); background: var(--studio-850); border: 1px solid var(--border-medium); display: flex; align-items: center; justify-content: center; color: var(--color-emerald-light);">
              <i data-lucide="clock" style="width: 22px; height: 22px;"></i>
            </div>
            <div>
              <div class="font-display font-bold text-sm text-white" id="attendanceStatusTitle">Today's Studio Shift</div>
              <p class="text-xs text-muted" id="attendanceStatusSub">Check in to record your daily working hours.</p>
            </div>
          </div>

          <div style="display: flex; gap: var(--space-2-5);">
            <button type="button" class="btn btn-primary" id="btnCheckIn">
              <i data-lucide="log-in"></i> Check In Now
            </button>
            <button type="button" class="btn btn-secondary" id="btnCheckOut" style="display: none;">
              <i data-lucide="log-out"></i> Check Out
            </button>
          </div>
        </div>

        <!-- Attendance Log -->
        <div class="card">
          <div class="card-header" style="flex-wrap: wrap; gap: var(--space-2);">
            <div class="card-title">Attendance Log</div>
            <div style="display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center;">
              <input type="month" id="attMonth" class="form-control" style="height: 34px; width: auto;" aria-label="Month" />
              ${this.canSeeAll() ? '<select id="attPerson" class="form-control" style="height: 34px; width: auto;" aria-label="Employee"><option value="">Everyone</option></select>' : ''}
              <button type="button" class="btn btn-secondary btn-sm" id="btnAttExport"><i data-lucide="download"></i> Export CSV</button>
            </div>
          </div>
          <div id="attSummary" style="display: flex; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-3) var(--space-4) 0;"></div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead><tr><th>Date</th><th>Specialist</th><th>Check in</th><th>Check out</th><th>Hours</th><th>Status</th></tr></thead>
                <tbody id="attTableBody"><tr><td colspan="6" style="text-align:center; color: var(--text-dim); padding: var(--space-6);">Loading attendance…</td></tr></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Leave Requests Table -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">Leave & Time-Off Requests</div>
            <span class="badge badge-slate" id="leaveCountBadge">0 Requests</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Specialist</th>
                    <th>Leave Type</th>
                    <th>Duration</th>
                    <th>Reason</th>
                    <th>Status</th>
                    ${Permissions.isAdmin() || Permissions.hasRole('hr_manager') ? '<th style="text-align: right;">Action</th>' : ''}
                  </tr>
                </thead>
                <tbody id="leaveRequestsTableBody">
                  <tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading leave requests...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
    this.setupAttendanceLog();
    await this.loadHrData();
    Realtime.watch(['leave_requests', 'attendance_records'], () => this.loadHrData()); // live updates for everyone
  }

  attachEventListeners() {
    document.getElementById('btnCheckIn')?.addEventListener('click', async () => {
      await this.handleCheckIn();
    });

    document.getElementById('btnCheckOut')?.addEventListener('click', async () => {
      await this.handleCheckOut();
    });

    document.getElementById('btnRequestLeave')?.addEventListener('click', () => {
      this.openLeaveModal();
    });
  }

  async loadHrData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Check today's attendance record
      const today = this.localDate();
      const { data: attendance } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('user_id', this.app.currentUser.id)
        .eq('date', today)
        .maybeSingle();

      this.attendanceToday = attendance;
      this.updateAttendanceUI();

      // 2. Fetch Leave Types
      const { data: leaveTypes, error: typesErr } = await supabase.from('leave_types').select('*').eq('is_active', true).order('name');
      if (typesErr) console.warn('Leave types error:', typesErr);
      this.leaveTypes = leaveTypes || [];

      // 3. Fetch Leave Requests (Filtered by RLS)
      let { data: requests, error: reqErr } = await supabase
        .from('leave_requests')
        .select(`
          *,
          profiles!leave_requests_user_id_fkey(full_name),
          leave_types(name)
        `)
        .order('created_at', { ascending: false });

      if (reqErr) {
        // the names are a nicety: if the joined query fails, fall back to the plain list and fill the names in here
        console.warn('Leave requests (joined) error:', reqErr);
        const plain = await supabase.from('leave_requests').select('*').order('created_at', { ascending: false });
        if (plain.error) { this.renderLeaveRequests(plain.error.message); return; }
        const typeName = new Map(this.leaveTypes.map(t => [t.id, t.name]));
        requests = (plain.data || []).map(r => ({
          ...r, leave_types: { name: typeName.get(r.leave_type_id) },
          profiles: r.user_id === this.app.currentUser.id ? { full_name: this.app.currentUser.full_name } : null
        }));
      }

      this.leaveRequests = requests || [];
      this.renderLeaveRequests();
      await this.loadAttendanceLog();
    } catch (err) {
      console.warn('HR data fetch error:', err);
      this.renderLeaveRequests();
    }
  }

  updateAttendanceUI() {
    const title = document.getElementById('attendanceStatusTitle');
    const sub = document.getElementById('attendanceStatusSub');
    const btnIn = document.getElementById('btnCheckIn');
    const btnOut = document.getElementById('btnCheckOut');

    if (!title || !sub || !btnIn || !btnOut) return;

    if (!this.attendanceToday) {
      title.textContent = "Today's Studio Shift: Not Checked In";
      sub.textContent = 'Record your presence for today.';
      btnIn.style.display = 'inline-flex';
      btnOut.style.display = 'none';
    } else if (this.attendanceToday.check_out) {
      title.textContent = `Today's Studio Shift: Completed (${this.attendanceToday.total_hours || '8.0'} hrs)`;
      sub.textContent = 'You have checked out for the day. Great work!';
      btnIn.style.display = 'none';
      btnOut.style.display = 'none';
    } else {
      title.textContent = `Today's Studio Shift: Checked In at ${formatDate(this.attendanceToday.check_in, true)}`;
      sub.textContent = 'Shift currently active.';
      btnIn.style.display = 'none';
      btnOut.style.display = 'inline-flex';
    }
  }


  // ---------------------------------------------------------------- attendance log
  /** Today's date in the user's own time zone (YYYY-MM-DD). toISOString() would give the UTC day, which is wrong after midnight in Cairo. */
  localDate(d = new Date()) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  }

  canSeeAll() { return Permissions.isAdmin() || Permissions.hasRole('hr_manager'); }

  setupAttendanceLog() {
    this.attMonth = this.localDate().slice(0, 7);
    this.attPerson = '';
    this.attRows = [];
    const month = document.getElementById('attMonth');
    if (month) { month.value = this.attMonth; month.addEventListener('change', () => { this.attMonth = month.value || this.attMonth; this.loadAttendanceLog(); }); }
    document.getElementById('attPerson')?.addEventListener('change', (e) => { this.attPerson = e.target.value; this.renderAttendanceLog(); });
    document.getElementById('btnAttExport')?.addEventListener('click', () => this.exportAttendance());
    if (window.lucide) window.lucide.createIcons();
  }

  async loadAttendanceLog() {
    const sb = getSupabase(); if (!sb || !document.getElementById('attTableBody')) return;
    const [y, m] = this.attMonth.split('-').map(Number);
    const from = `${this.attMonth}-01`, to = this.localDate(new Date(y, m, 0)); // last day of that month
    let q = sb.from('attendance_records').select('id, user_id, date, check_in, check_out, total_hours, status')
      .gte('date', from).lte('date', to).order('date', { ascending: false }).order('check_in', { ascending: false }).limit(2000);
    if (!this.canSeeAll()) q = q.eq('user_id', this.app.currentUser.id); // everyone else sees only their own days
    const { data, error } = await q;
    if (error) {
      document.getElementById('attTableBody').innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--kite-red-500, #e01b28); padding: var(--space-6);">Could not load attendance: ${escapeHTML(error.message)}</td></tr>`;
      return;
    }
    this.attRows = data || [];
    const ids = [...new Set(this.attRows.map(r => r.user_id))];
    this.attNames = new Map();
    if (ids.length) {
      const { data: people } = await sb.from('profiles').select('id, full_name').in('id', ids);
      (people || []).forEach(p => this.attNames.set(p.id, p.full_name));
    }
    const sel = document.getElementById('attPerson');
    if (sel) {
      sel.innerHTML = '<option value="">Everyone</option>' + [...this.attNames].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
        .map(([id, name]) => `<option value="${id}">${escapeHTML(name || 'Unknown')}</option>`).join('');
      sel.value = this.attNames.has(this.attPerson) ? this.attPerson : '';
      this.attPerson = sel.value;
    }
    this.renderAttendanceLog();
  }

  visibleAttendance() { return this.attPerson ? this.attRows.filter(r => r.user_id === this.attPerson) : this.attRows; }

  renderAttendanceLog() {
    const body = document.getElementById('attTableBody'), sum = document.getElementById('attSummary');
    if (!body) return;
    const rows = this.visibleAttendance();
    const time = (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
    const name = (id) => (id === this.app.currentUser.id ? 'You' : this.attNames?.get(id) || 'Specialist');

    // totals per person for the month
    const per = new Map();
    rows.forEach(r => { const e = per.get(r.user_id) || { days: 0, hours: 0 }; e.days++; e.hours += Number(r.total_hours) || 0; per.set(r.user_id, e); });
    const chip = (t) => `<span class="badge badge-slate" style="font-size: 11px;">${t}</span>`;
    if (!per.size) sum.innerHTML = '';
    else if (per.size === 1) {
      const [id, e] = [...per][0];
      sum.innerHTML = chip(`${escapeHTML(name(id))}: <b>${e.days}</b> day${e.days === 1 ? '' : 's'} · <b>${e.hours.toFixed(1)}</b> hrs`);
    } else {
      sum.innerHTML = chip(`${per.size} people · <b>${rows.length}</b> check-ins`) + [...per].sort((a, b) => b[1].hours - a[1].hours).slice(0, 8)
        .map(([id, e]) => chip(`${escapeHTML(name(id))}: ${e.days} d · ${e.hours.toFixed(1)} h`)).join('');
    }

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-dim); padding: var(--space-6);">No attendance recorded for this month. Press “Check In Now” above to record today.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => `
      <tr>
        <td class="font-mono text-2xs">${escapeHTML(r.date)}</td>
        <td class="font-semibold text-white">${escapeHTML(name(r.user_id))}</td>
        <td class="font-mono text-2xs">${time(r.check_in)}</td>
        <td class="font-mono text-2xs">${r.check_out ? time(r.check_out) : '<span class="badge badge-amber">Still in</span>'}</td>
        <td class="font-mono text-2xs">${r.check_out ? (Number(r.total_hours) || 0).toFixed(2) : '—'}</td>
        <td><span class="badge ${r.status === 'present' ? 'badge-emerald' : 'badge-amber'}">${escapeHTML(String(r.status).replace('_', ' '))}</span></td>
      </tr>`).join('');
  }

  exportAttendance() {
    const rows = this.visibleAttendance();
    if (!rows.length) { Toast.info('Nothing to export for this month.', 'Attendance'); return; }
    // a cell that starts with = + - @ would run as a formula in Excel: prefix it with an apostrophe
    const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
    const lines = [['Date', 'Specialist', 'Check in', 'Check out', 'Hours', 'Status'],
      ...rows.map(r => [r.date, this.attNames?.get(r.user_id) || '', hhmm(r.check_in), hhmm(r.check_out), r.check_out ? Number(r.total_hours) || 0 : '', r.status])]
      .map(l => l.map(cell).join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `attendance-${this.attMonth}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async handleCheckIn() {
    const supabase = getSupabase();
    if (!supabase) return;

    const today = this.localDate();
    try {
      const { error } = await supabase.from('attendance_records').insert({
        user_id: this.app.currentUser.id,
        check_in: new Date().toISOString(),
        date: today,
        status: 'present'
      });

      if (error) throw error;
      Toast.success('Checked in for today!', 'Attendance');
      await this.loadHrData();
    } catch (err) {
      console.error('Check-in error:', err);
      Toast.error(err.message || 'Check-in failed', 'Error');
    }
  }

  async handleCheckOut() {
    const supabase = getSupabase();
    if (!supabase || !this.attendanceToday) return;

    try {
      const checkInTime = new Date(this.attendanceToday.check_in);
      const checkOutTime = new Date();
      const diffHours = ((checkOutTime - checkInTime) / (1000 * 60 * 60)).toFixed(2);

      const { error } = await supabase
        .from('attendance_records')
        .update({
          check_out: checkOutTime.toISOString(),
          total_hours: Number(diffHours)
        })
        .eq('id', this.attendanceToday.id);

      if (error) throw error;
      Toast.success(`Checked out! Total hours: ${diffHours}h`, 'Attendance');
      await this.loadHrData();
    } catch (err) {
      console.error('Check-out error:', err);
      Toast.error(err.message || 'Check-out failed', 'Error');
    }
  }

  renderLeaveRequests(loadError = null) {
    const tbody = document.getElementById('leaveRequestsTableBody');
    const badge = document.getElementById('leaveCountBadge');
    if (!tbody) return;

    if (badge) badge.textContent = `${this.leaveRequests.length} Requests`;

    const canReview = Permissions.isAdmin() || Permissions.hasRole('hr_manager');

    if (loadError) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--kite-red-500, #e01b28); padding: var(--space-6);">
        Could not load leave requests: ${escapeHTML(loadError)}<br><span class="text-2xs text-dim">If this mentions a missing table or permission, run the SQL migrations in Supabase.</span></td></tr>`;
      return;
    }

    if (this.leaveRequests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No leave requests submitted.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.leaveRequests.map(r => `
      <tr>
        <td class="font-semibold text-white">${escapeHTML(r.profiles?.full_name || 'Specialist')}</td>
        <td><span class="badge badge-indigo">${escapeHTML(r.leave_types?.name || 'Leave')}</span></td>
        <td class="font-mono text-2xs text-muted">${formatDate(r.start_date)} → ${formatDate(r.end_date)} (${r.total_days} days)</td>
        <td class="text-xs text-muted line-clamp-2">${escapeHTML(r.reason)}</td>
        <td>
          <span class="badge ${r.status === 'approved' ? 'badge-emerald' : (r.status === 'rejected' ? 'badge-rose' : 'badge-amber')}">
            ${escapeHTML(r.status.toUpperCase())}
          </span>
        </td>
        ${canReview ? `
          <td style="text-align: right; white-space: nowrap;">
            ${r.status === 'pending' ? `
              <button type="button" class="btn btn-primary btn-sm btn-approve-leave" data-id="${r.id}">Approve</button>
              <button type="button" class="btn btn-danger btn-sm btn-reject-leave" data-id="${r.id}">Reject</button>
            ` : '<span class="text-2xs text-dim">Reviewed</span>'}
          </td>
        ` : ''}
      </tr>
    `).join('');

    // Attach review handlers
    if (canReview) {
      tbody.querySelectorAll('.btn-approve-leave').forEach(btn => {
        btn.addEventListener('click', () => this.handleReviewLeave(btn.getAttribute('data-id'), 'approved'));
      });
      tbody.querySelectorAll('.btn-reject-leave').forEach(btn => {
        btn.addEventListener('click', () => this.handleReviewLeave(btn.getAttribute('data-id'), 'rejected'));
      });
    }
  }

  async handleReviewLeave(leaveId, decision) {
    try {
      await Api.decideLeave(leaveId, decision);
      Toast.success(`Leave request ${decision}!`, 'HR Decision');
      await this.loadHrData();
    } catch (err) {
      console.error('Review leave error:', err);
      Toast.error(err.message || 'Action failed', 'Error');
    }
  }

  /** First-time setup: the standard leave types (same list as seed.sql). Only an admin / HR can add them. */
  async createStandardLeaveTypes() {
    const { error } = await getSupabase().from('leave_types').insert([
      { name: 'Annual Leave', description: 'Paid time off for holidays and vacation', default_days: 21 },
      { name: 'Sick Leave', description: 'Medical or health recuperation leave', default_days: 10 },
      { name: 'Personal / Emergency', description: 'Short-notice emergency family or personal matters', default_days: 5 },
      { name: 'Remote Work Request', description: 'Configured remote execution days', default_days: 12 }
    ]);
    if (error) { Toast.error(error.message, 'Could not create leave types'); return false; }
    await this.loadHrData();
    return true;
  }

  openLeaveModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    // No leave types yet: the form could never be submitted, so say why instead of showing an empty list
    if (!this.leaveTypes.length) {
      const canSetUp = Permissions.isAdmin() || Permissions.hasRole('hr_manager');
      modalDialog.style.maxWidth = '440px';
      modalDialog.innerHTML = `
        <div class="modal-header"><h2 class="modal-title font-display">Time off is not set up yet</h2>
          <button type="button" class="modal-close-btn" id="btnCancelLeave">&times;</button></div>
        <div class="modal-body"><p class="text-sm text-muted">There are no leave types (annual, sick…) in the system, so a request cannot be made.
          ${canSetUp ? 'You can add the standard ones now.' : 'Please ask an administrator or HR to add them.'}</p></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelLeaveAction">Close</button>
          ${canSetUp ? '<button type="button" class="btn btn-primary btn-sm" id="btnSeedLeaveTypes">Add standard leave types</button>' : ''}
        </div>`;
      modalBackdrop.classList.add('active');
      document.getElementById('btnCancelLeave')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
      document.getElementById('btnCancelLeaveAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
      document.getElementById('btnSeedLeaveTypes')?.addEventListener('click', async () => {
        if (await this.createStandardLeaveTypes()) this.openLeaveModal();
      });
      return;
    }

    modalDialog.style.maxWidth = '480px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Request Studio Time Off</h2>
        <button type="button" class="modal-close-btn" id="btnCancelLeave">&times;</button>
      </div>

      <form id="requestLeaveForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="leaveTypeSelect">Leave Type *</label>
            <select id="leaveTypeSelect" required class="form-control">
              ${this.leaveTypes.map(t => `<option value="${t.id}">${escapeHTML(t.name)} (${t.default_days} days/yr)</option>`).join('')}
            </select>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="leaveStartDate">Start Date *</label>
              <input id="leaveStartDate" type="date" required class="form-control" />
            </div>
            <div class="form-group">
              <label class="form-label" for="leaveEndDate">End Date *</label>
              <input id="leaveEndDate" type="date" required class="form-control" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="leaveReason">Reason / Handoff Plan *</label>
            <textarea id="leaveReason" required rows="3" placeholder="Provide details and confirm your deliverables are covered..." class="form-control"></textarea>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelLeaveAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Submit Request</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelLeave')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelLeaveAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('requestLeaveForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const leaveTypeId = document.getElementById('leaveTypeSelect').value;
      const startDate = document.getElementById('leaveStartDate').value;
      const endDate = document.getElementById('leaveEndDate').value;
      const reason = document.getElementById('leaveReason').value.trim();

      const s = new Date(startDate);
      const en = new Date(endDate);
      if (!(en >= s)) { Toast.error('The end date cannot be before the start date.', 'Check the dates'); return; }
      const submitBtn = e.submitter || document.querySelector('#requestLeaveForm [type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      const totalDays = Math.max(1, Math.ceil((en - s) / (1000 * 60 * 60 * 24)) + 1);

      const supabase = getSupabase();
      try {
        const { data: created, error } = await supabase.from('leave_requests').insert({
          user_id: this.app.currentUser.id,
          leave_type_id: leaveTypeId,
          start_date: startDate,
          end_date: endDate,
          total_days: totalDays,
          reason,
          status: 'pending'
        }).select('id').single();

        if (error) throw error;
        Api.leaveSubmitted(created.id).catch(() => {}); // notify the approvers; never blocks the user
        Toast.success('Time off request submitted to studio manager', 'Submitted');
        modalBackdrop.classList.remove('active');
        await this.loadHrData();
      } catch (err) {
        console.error('Leave submit error:', err);
        Toast.error(err.message || 'Submission failed', 'Error');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}
