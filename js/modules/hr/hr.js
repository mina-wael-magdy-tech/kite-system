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
      const today = new Date().toISOString().split('T')[0];
      const { data: attendance } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('user_id', this.app.currentUser.id)
        .eq('date', today)
        .maybeSingle();

      this.attendanceToday = attendance;
      this.updateAttendanceUI();

      // 2. Fetch Leave Types
      const { data: leaveTypes } = await supabase.from('leave_types').select('*').eq('is_active', true);
      this.leaveTypes = leaveTypes || [];

      // 3. Fetch Leave Requests (Filtered by RLS)
      const { data: requests } = await supabase
        .from('leave_requests')
        .select(`
          *,
          profiles!leave_requests_user_id_fkey(full_name),
          leave_types(name)
        `)
        .order('created_at', { ascending: false });

      this.leaveRequests = requests || [];
      this.renderLeaveRequests();
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

  async handleCheckIn() {
    const supabase = getSupabase();
    if (!supabase) return;

    const today = new Date().toISOString().split('T')[0];
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

  renderLeaveRequests() {
    const tbody = document.getElementById('leaveRequestsTableBody');
    const badge = document.getElementById('leaveCountBadge');
    if (!tbody) return;

    if (badge) badge.textContent = `${this.leaveRequests.length} Requests`;

    const canReview = Permissions.isAdmin() || Permissions.hasRole('hr_manager');

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

  openLeaveModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

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
      const totalDays = Math.max(1, Math.ceil((en - s) / (1000 * 60 * 60 * 24)) + 1);

      const supabase = getSupabase();
      try {
        const { error } = await supabase.from('leave_requests').insert({
          user_id: this.app.currentUser.id,
          leave_type_id: leaveTypeId,
          start_date: startDate,
          end_date: endDate,
          total_days: totalDays,
          reason,
          status: 'pending'
        });

        if (error) throw error;
        Toast.success('Time off request submitted to studio manager', 'Submitted');
        modalBackdrop.classList.remove('active');
        await this.loadHrData();
      } catch (err) {
        console.error('Leave submit error:', err);
        Toast.error(err.message || 'Submission failed', 'Error');
      }
    });
  }
}
