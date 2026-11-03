/**
 * KITE SYSTEM — Module F: Campaign Management
 * Cross-department Studio Campaigns coordinating Branding, BTL, Digital, Media & Web Dev.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { Permissions } from '../../permissions/permission-service.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';
import { ContentPlansSection, ContentPlanEditor } from './content-plan.js';

export class CampaignsModule {
  constructor(app) {
    this.app = app;
    this.campaigns = [];
  }

  async render(container, query) {
    // #campaigns?plan=<id> opens the content-plan editor (also reached from notifications and the calendar)
    const params = new URLSearchParams(query || '');
    if (params.get('plan')) {
      return new ContentPlanEditor(this.app).render(container, params.get('plan'), params.get('post'));
    }

    this.plansSection = new ContentPlansSection(this.app);
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Studio Campaigns</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Multi-department campaigns harmonizing Branding, BTL, Digital, Media, and Web Development.
            </p>
          </div>

          <button type="button" class="btn btn-primary btn-sm" id="btnCreateCampaign">
            <i data-lucide="plus"></i> New Studio Campaign
          </button>
        </div>

        <div id="campaignsContainer" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--space-4);">
          <!-- Dynamic Campaign Cards -->
          <div class="empty-state" style="border:none; padding: 40px 0; grid-column: 1 / -1;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading studio campaigns...</div>
          </div>
        </div>

        ${this.plansSection.html()}
      </div>
    `;

    document.getElementById('btnCreateCampaign')?.addEventListener('click', () => {
      this.openCampaignModal();
    });

    await this.loadCampaigns();
    Realtime.watch(['campaigns'], () => this.loadCampaigns()); // live updates for everyone
    await this.plansSection.mount();
  }

  async loadCampaigns() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: campaigns, error } = await supabase
        .from('campaigns')
        .select(`
          *,
          client:clients(name, company_name),
          tasks(id, status, department_id, departments!tasks_department_id_fkey(name))
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      this.campaigns = campaigns || [];
      this.renderCampaigns();
    } catch (err) {
      console.warn('Campaigns fetch error:', err);
      this.renderCampaigns();
    }
  }

  renderCampaigns() {
    const container = document.getElementById('campaignsContainer');
    if (!container) return;

    const displayCampaigns = this.campaigns;
    if (displayCampaigns.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">📣</div>
          <div class="empty-state-title">No campaigns yet</div>
          <div class="empty-state-desc">Create a cross-department campaign to coordinate branding, media, web and digital work.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = displayCampaigns.map(c => `
      <div class="card entity-card" style="display: flex; flex-direction: column; justify-content: space-between;">
        <div class="card-header">
          <div>
            <span class="card-actions" style="float: right;">
              ${this.canEdit(c) ? `<button type="button" class="card-act card-act-edit" data-id="${c.id}" title="Edit campaign" aria-label="Edit campaign"><i data-lucide="pencil"></i></button>` : ''}
              ${Permissions.isAdmin() ? `<button type="button" class="card-act card-act-delete" data-id="${c.id}" title="Delete campaign" aria-label="Delete campaign"><i data-lucide="trash-2"></i></button>` : ''}
            </span>
            <span class="badge badge-indigo font-bold">${escapeHTML(c.client?.company_name || c.client?.name || 'No client assigned')}</span>
            <div class="card-title" style="margin-top: 6px;">${escapeHTML(c.name)}</div>
          </div>
          <span class="badge badge-emerald font-mono">📅 ${formatDate(c.end_date)}</span>
        </div>

        <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
          <p class="text-xs text-muted line-clamp-2">${escapeHTML(c.description || '')}</p>

          <div>
            <span class="text-2xs font-bold text-dim uppercase tracking-wider block mb-1">Involved Studio Departments</span>
            <div style="display: flex; flex-wrap: wrap; gap: 4px;">
              ${[...new Set((c.tasks || []).map(t => t.departments?.name).filter(Boolean))].map(n => `<span class="badge badge-indigo">${escapeHTML(n)}</span>`).join('') || '<span class="text-2xs text-dim">No deliverables assigned yet</span>'}
            </div>
          </div>
        </div>

        <div class="card-footer">
          <div style="display: flex; gap: var(--space-2); width: 100%;">
            <a href="#tasks" class="btn btn-secondary btn-sm" style="flex: 1;">Deliverables →</a>
            <button type="button" class="btn btn-primary btn-sm" style="flex: 1;" data-content-plan="${c.id}"><i data-lucide="calendar-days"></i> Content plan</button>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-content-plan]').forEach(b => b.addEventListener('click', () => this.openContentPlan(b.dataset.contentPlan)));
    container.querySelectorAll('.card-act-edit').forEach(b => b.addEventListener('click', () => this.openEditDialog(b.dataset.id)));
    container.querySelectorAll('.card-act-delete').forEach(b => b.addEventListener('click', () => this.deleteCampaign(b.dataset.id)));
    if (window.lucide) window.lucide.createIcons();
  }

  /** One plan: open it. None yet: start one for this campaign. Several: show them in the list below. */
  openContentPlan(campaignId) {
    const plans = (this.plansSection?.plans || []).filter(p => p.campaign_id === campaignId);
    if (plans.length === 1) { window.location.hash = `#campaigns?plan=${plans[0].id}`; return; }
    if (!plans.length) { this.plansSection?.openCreate(campaignId); return; }
    document.getElementById('plansContainer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    Toast.info(`This campaign has ${plans.length} content plans — pick one below.`, 'Content plans');
  }

  canEdit(c) {
    const me = this.app.currentUser.id;
    return Permissions.isAdmin() || c.manager_id === me || c.created_by === me;
  }

  async openEditDialog(id) {
    const c = this.campaigns.find(x => x.id === id);
    if (!c) return;
    const { data: clientRows } = await getSupabase().from('clients').select('id, company_name').order('company_name', { ascending: true });
    formDialog({
      title: `Edit ${c.name}`,
      subtitle: 'Change the campaign name, client, status, launch date or objective.',
      fields: [
        { name: 'name', label: 'Campaign name', required: true, value: c.name, maxlength: 160 },
        { name: 'client_id', label: 'Client', type: 'select', half: true, value: c.client_id || '', options: [
          { value: '', label: 'No client (internal)' }, ...(clientRows || []).map(r => ({ value: r.id, label: r.company_name }))] },
        { name: 'status', label: 'Status', type: 'select', half: true, value: c.status, options: [
          { value: 'planning', label: 'Planning' }, { value: 'active', label: 'Active' }, { value: 'on_hold', label: 'On hold' },
          { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }] },
        { name: 'end_date', label: 'Target launch date', type: 'date', half: true, value: (c.end_date || '').slice(0, 10) },
        { name: 'description', label: 'Objective', type: 'textarea', value: c.description || '', rows: 3 }
      ],
      onSubmit: async (v) => {
        const { data, error } = await getSupabase().from('campaigns')
          .update({ name: v.name, client_id: v.client_id, status: v.status, end_date: v.end_date, description: v.description })
          .eq('id', id).select('id');
        if (error) throw new Error(error.message);
        if (!data?.length) throw new Error('You do not have permission to edit this campaign.');
        Toast.success('Campaign updated', 'Saved');
        await this.loadCampaigns();
      }
    });
  }

  async deleteCampaign(id) {
    const c = this.campaigns.find(x => x.id === id);
    if (!c) return;
    const ok = await confirmDialog({ title: 'Delete this campaign?', message: `"${c.name}" will be removed. Linked tasks and projects are kept.`, confirmLabel: 'Delete campaign', danger: true });
    if (!ok) return;
    const { data, error } = await getSupabase().from('campaigns').delete().eq('id', id).select('id');
    if (error || !data?.length) { Toast.error(error?.message || 'Only an administrator can delete campaigns.', 'Delete refused'); return; }
    Toast.success('Campaign deleted', 'Deleted');
    await this.loadCampaigns();
  }

  async openCampaignModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    // Real client list (RLS-scoped) instead of free text that was never saved
    const { data: clientRows } = await getSupabase()
      .from('clients')
      .select('id, company_name')
      .order('company_name', { ascending: true });
    const clients = clientRows || [];

    modalDialog.style.maxWidth = '500px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Create Cross-Dept Campaign</h2>
        <button type="button" class="modal-close-btn" id="btnCancelCamp">&times;</button>
      </div>

      <form id="createCampaignForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="campName">Campaign Name *</label>
            <input id="campName" type="text" required placeholder="e.g. Apex Global Autumn Rebrand" class="form-control" />
          </div>

          <div class="form-group">
            <label class="form-label" for="campClient">Client</label>
            <select id="campClient" class="form-control">
              <option value="">No client (internal campaign)</option>
              ${clients.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.company_name)}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="campDate">Target Launch Date</label>
            <input id="campDate" type="date" required class="form-control" />
          </div>

          <div class="form-group">
            <label class="form-label" for="campDesc">Campaign Objective</label>
            <textarea id="campDesc" rows="3" placeholder="Define deliverables across the 5 studio departments..." class="form-control"></textarea>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelCampAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Create Campaign</button>
        </div>
      </form>
    `;

    const d = new Date();
    d.setDate(d.getDate() + 20);
    const dateInput = document.getElementById('campDate');
    if (dateInput) dateInput.value = d.toISOString().split('T')[0];

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelCamp')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelCampAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createCampaignForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('campName').value.trim();
      const clientId = document.getElementById('campClient').value || null;
      const endDate = document.getElementById('campDate').value;
      const description = document.getElementById('campDesc').value.trim();

      const supabase = getSupabase();
      try {
        const { error } = await supabase.from('campaigns').insert({
          name,
          client_id: clientId,
          end_date: endDate,
          description,
          status: 'active',
          created_by: this.app.currentUser.id
        });

        if (error) throw error;

        Toast.success(`Campaign "${name}" created!`, 'Studio Campaign');
        modalBackdrop.classList.remove('active');
        await this.loadCampaigns();
      } catch (err) {
        console.error('Campaign error:', err);
        Toast.error(err.message || 'Failed to create campaign', 'Error');
      }
    });
  }
}
