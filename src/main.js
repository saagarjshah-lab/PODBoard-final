import * as XLSX from 'xlsx';
import { initAuth, isAdmin, getSession } from './lib/auth.js';
import { ALLOWED_DOMAIN } from './lib/supabaseClient.js';
import {
  fetchBoard, fetchAppSettingsOnly, updateAppSettings, insertMember, updateMemberCapacity, updateMemberEmail, deleteMember,
  upsertAssignment, deleteAssignment, subscribeToBoard,
  fetchProjects, insertProject, updateProjectStatus, deleteProjectRow,
  assignMemberToProject, unassignMemberFromProject, getMemberIdForAuthUser,
  fetchTimeLogs, insertTimeLog, updateTimeLog,
} from './lib/db.js';

/* ================= State (admin workspace) ================= */
let data = { appName: 'POD Board', tagline: 'Weekly Capacity Tracker', capacity: 40, members: [], assignments: {} };
let weeks = [];
let selectedWeek = null;
let editCtx = null; // {memberId, projectId|null}
let unsubscribeRealtime = null;
let projects = []; // [{id,name,description,status,memberIds}] — RLS-scoped: all for admin, assigned-only for members
let projectFilter = ''; // '' = all projects; else a project name (admin ongoing-projects dropdown)
let myMemberId = null; // members.id linked to the current auth user, if any

const PRIORITIES = ["Urgent", "According to SLA's", "Not started"];
const STATUSES = ['Not started', 'In progress', 'In review', 'Done', 'Blocked'];
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let rollupScope = 'month';

function projectHours(p) { return DAYS.reduce((s, [k]) => s + (Number(p.days?.[k]) || 0), 0); }
function parseWeekMonday(label) {
  const first = label.split(' to ')[0].trim();
  const [d, mon, y] = first.split('-');
  const mi = MONTHS.indexOf(mon);
  if (mi < 0) return null;
  return new Date(parseInt(y), mi, parseInt(d));
}
function periodKeyOf(date, scope) {
  if (!date) return null;
  const y = date.getFullYear();
  if (scope === 'month') return `${y}-${pad(date.getMonth() + 1)}`;
  return `${y}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}
function periodLabelOf(key, scope) {
  if (scope === 'month') { const [y, m] = key.split('-'); return `${MONTHS[parseInt(m) - 1]} ${y}`; }
  const [y, q] = key.split('-'); return `${q} ${y}`;
}
function allTrackedWeeks() {
  const set = new Set(weeks);
  Object.keys(data.assignments).forEach((w) => set.add(w));
  return [...set];
}
function weeksInPeriod(scope, key) {
  return allTrackedWeeks().filter((w) => periodKeyOf(parseWeekMonday(w), scope) === key);
}
function aggregateProjects() {
  const map = {};
  allTrackedWeeks().forEach((w) => {
    const monday = parseWeekMonday(w);
    const wk = data.assignments[w]; if (!wk) return;
    Object.keys(wk).forEach((mid) => {
      const member = data.members.find((m) => m.id === mid); if (!member) return;
      getProjects(w, mid).forEach((p) => {
        const key = (p.project || '').trim().toLowerCase(); if (!key) return;
        if (!map[key]) map[key] = { name: (p.project || '').trim(), hours: 0, members: new Set(), latestDate: null, latestStatus: 'Not started', deadline: p.deadline || '' };
        const rec = map[key];
        rec.hours += projectHours(p);
        rec.members.add(member.name);
        if (!rec.latestDate || (monday && monday > rec.latestDate)) {
          rec.latestDate = monday; rec.latestStatus = p.status || 'Not started';
          if (p.deadline) rec.deadline = p.deadline;
        }
      });
    });
  });
  return Object.values(map);
}

/* ================= Week generation ================= */
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDMY(d) { return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`; }
function weekLabel(monday) { const fri = new Date(monday); fri.setDate(monday.getDate() + 4); return `${fmtDMY(monday)} to ${fmtDMY(fri)}`; }
function buildWeeks() {
  const start = new Date(2026, 7, 10); // Monday 10-Aug-2026, matches the original sheet
  weeks = [];
  for (let i = 0; i < 52; i++) { const m = new Date(start); m.setDate(start.getDate() + i * 7); weeks.push(weekLabel(m)); }
}
function currentWeekLabel() {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const day = now.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now); mon.setDate(now.getDate() + diff);
  return weekLabel(mon);
}

/* ================= Data load (Supabase) — admin workspace ================= */
async function loadData() {
  data = await fetchBoard();
  Object.keys(data.assignments).forEach((w) => { if (!weeks.includes(w)) weeks.push(w); });
  try { projects = await fetchProjects(); } catch (e) { projects = []; }
}
async function reload() {
  if (isAdmin()) { await loadData(); render(); }
  else { await loadMemberWorkspaceData(); renderMemberWorkspace(); }
}

/* ================= Helpers (shared) ================= */
function showToast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); }
function initials(name) { return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }
function getProjects(week, memberId) { return (data.assignments[week] && data.assignments[week][memberId]) || []; }
function memberHours(week, memberId) { return getProjects(week, memberId).reduce((s, p) => s + projectHours(p), 0); }
function memberCapacity(m) { const c = Number(m.capacity); return (c > 0) ? c : data.capacity; }
function statusBadge(s) {
  const map = { 'Not started': 'st-notstarted', 'In progress': 'st-progress', 'In review': 'st-review', Done: 'st-done', Blocked: 'st-blocked' };
  return `<span class="st ${map[s] || 'st-notstarted'}">${esc(s || 'Not started')}</span>`;
}
function loadColor(pct) { if (pct > 100) return 'var(--danger)'; if (pct >= 90) return 'var(--accent)'; if (pct >= 70) return 'var(--teal)'; if (pct > 0) return 'var(--blue)'; return 'var(--surface3)'; }
function priorityBadge(p) {
  if (p === 'Urgent') return '<span class="badge b-urgent">Urgent</span>';
  if (p === "According to SLA's") return '<span class="badge b-sla">Per SLA</span>';
  return '<span class="badge b-notstarted">Not started</span>';
}
function deadlineInfo(dl) {
  if (!dl) return { txt: 'No deadline', cls: '' };
  const d = new Date(dl + 'T00:00:00'); if (isNaN(d)) return { txt: 'No deadline', cls: '' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const label = `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;
  if (days < 0) return { txt: `${label} · overdue`, cls: 'over' };
  if (days === 0) return { txt: `${label} · due today`, cls: 'soon' };
  if (days <= 2) return { txt: `${label} · ${days}d left`, cls: 'soon' };
  return { txt: `${label} · ${days}d left`, cls: '' };
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function utilFlag(pct) {
  if (pct > 100) return '<span class="flag flag-over">Overloaded</span>';
  if (pct >= 90) return '<span class="flag flag-full">Full</span>';
  if (pct >= 70) return '<span class="flag flag-ok">Healthy</span>';
  return '<span class="flag flag-free">Has availability</span>';
}
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function formatLogDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ================= Tabs / controls (admin workspace) ================= */
window.switchTab = function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  ['board', 'overview', 'rollup', 'team', 'projects', 'livetracking'].forEach((t) => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'rollup') renderRollup();
  if (tab === 'projects') renderProjectsAdmin();
  if (tab === 'livetracking') { populateLiveTrackProjectOptions(); renderLiveTracking(); }
};
window.setScope = function setScope(scope) {
  rollupScope = scope;
  document.getElementById('scopeMonth').classList.toggle('active', scope === 'month');
  document.getElementById('scopeQuarter').classList.toggle('active', scope === 'quarter');
  buildPeriodOptions(); renderRollup();
};
function buildPeriodOptions() {
  const sel = document.getElementById('periodSelect');
  const keys = [...new Set(allTrackedWeeks().map((w) => periodKeyOf(parseWeekMonday(w), rollupScope)).filter(Boolean))].sort();
  const prev = sel.value;
  sel.innerHTML = keys.map((k) => `<option value="${k}">${periodLabelOf(k, rollupScope)}</option>`).join('');
  const curKey = periodKeyOf(new Date(), rollupScope);
  if (keys.includes(prev)) sel.value = prev; else if (keys.includes(curKey)) sel.value = curKey;
}
window.onWeekChange = function onWeekChange() { selectedWeek = document.getElementById('weekSelect').value; render(); };
window.onCapacityChange = async function onCapacityChange() {
  const v = parseFloat(document.getElementById('capacity').value);
  const capacity = (v > 0 ? v : 40);
  try { await updateAppSettings({ default_capacity: capacity }); data.capacity = capacity; }
  catch (e) { showToast('Only admins can change weekly capacity'); }
  document.getElementById('capNote').textContent = data.capacity;
  render();
};

/* ================= Members (admin workspace) ================= */
window.addMember = async function addMember() {
  const el = document.getElementById('newMemberName');
  const emailEl = document.getElementById('newMemberEmail');
  const name = el.value.trim();
  const email = (emailEl?.value || '').trim().toLowerCase();
  if (!name) { showToast('Enter a name'); return; }
  if (!email || !email.endsWith(ALLOWED_DOMAIN)) { showToast(`A valid ${ALLOWED_DOMAIN} email is required`); return; }
  try {
    const m = await insertMember(name, data.capacity, email);
    data.members.push(m);
    el.value = ''; if (emailEl) emailEl.value = '';
    render(); showToast('Member added');
  } catch (e) { showToast(/duplicate|unique/i.test(e?.message || '') ? 'That email is already in use' : 'Only admins can add members'); }
};
window.setMemberEmail = async function setMemberEmail(id, val) {
  const email = (val || '').trim().toLowerCase();
  if (email && !email.endsWith(ALLOWED_DOMAIN)) { showToast(`Email must end with ${ALLOWED_DOMAIN}`); render(); return; }
  const m = data.members.find((x) => x.id === id); if (!m) return;
  try { await updateMemberEmail(id, email); m.email = email; showToast(email ? 'Email saved — they can now sign in and see their projects' : 'Email cleared'); }
  catch (e) { showToast('Only admins can edit member email'); }
  render();
};
window.setMemberCapacity = async function setMemberCapacity(id, val) {
  const m = data.members.find((x) => x.id === id); if (!m) return;
  const v = parseFloat(val); const capacity = (v > 0 ? v : data.capacity);
  try { await updateMemberCapacity(id, capacity); m.capacity = capacity; render(); }
  catch (e) { showToast('Only admins can change capacity'); render(); }
};
window.removeMember = async function removeMember(id) {
  if (!confirm('Remove this member and all their assignments across every week?')) return;
  try {
    await deleteMember(id);
    data.members = data.members.filter((m) => m.id !== id);
    Object.keys(data.assignments).forEach((w) => { delete data.assignments[w][id]; });
    render(); showToast('Member removed');
  } catch (e) { showToast('Only admins can remove members'); }
};

/* ================= Project entities: admin CRUD + assignment + filter ================= */
/* Note: these are distinct from the per-week "project" text field logged in
   the modal below. A `projects` row is a durable entity an admin creates
   once and staffs members onto; the modal still logs actual hours per week
   against a project *name* (kept as free text for backward compatibility
   with the existing board/rollup/import-export logic). */

window.onProjectFilterChange = function onProjectFilterChange() {
  projectFilter = document.getElementById('projectFilterSelect').value || '';
  render();
  if (document.getElementById('tab-rollup').style.display !== 'none') renderRollup();
};

function populateProjectFilterOptions() {
  const sel = document.getElementById('projectFilterSelect');
  if (!sel) return;
  const prev = sel.value;
  const ongoing = projects.filter((p) => p.status === 'ongoing');
  sel.innerHTML = '<option value="">All projects</option>' + ongoing.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev; else { sel.value = ''; projectFilter = ''; }
}

window.addProject = async function addProject() {
  const nameEl = document.getElementById('newProjectName');
  const statusEl = document.getElementById('newProjectStatus');
  const name = nameEl.value.trim();
  if (!name) { showToast('Enter a project name'); return; }
  try {
    const p = await insertProject({ name, status: statusEl.value });
    projects.push(p);
    nameEl.value = ''; statusEl.value = 'ongoing';
    renderProjectsAdmin(); populateProjectFilterOptions();
    showToast('Project added');
  } catch (e) { showToast('Only admins can add projects'); }
};

window.setProjectStatus = async function setProjectStatus(id, status) {
  const p = projects.find((x) => x.id === id); if (!p) return;
  try { await updateProjectStatus(id, status); p.status = status; renderProjectsAdmin(); populateProjectFilterOptions(); }
  catch (e) { showToast('Only admins can change project status'); renderProjectsAdmin(); }
};

window.deleteProjectAdmin = async function deleteProjectAdmin(id) {
  if (!confirm('Delete this project and its member assignments?')) return;
  try {
    await deleteProjectRow(id);
    projects = projects.filter((p) => p.id !== id);
    renderProjectsAdmin(); populateProjectFilterOptions();
    showToast('Project deleted');
  } catch (e) { showToast('Only admins can delete projects'); }
};

window.toggleProjectMember = async function toggleProjectMember(projectId, memberId) {
  const p = projects.find((x) => x.id === projectId); if (!p) return;
  const assigned = p.memberIds.includes(memberId);
  try {
    if (assigned) { await unassignMemberFromProject(projectId, memberId); p.memberIds = p.memberIds.filter((id) => id !== memberId); }
    else { await assignMemberToProject(projectId, memberId); p.memberIds.push(memberId); }
    renderProjectsAdmin();
  } catch (e) { showToast('Only admins can change project staffing'); }
};

function renderProjectsAdmin() {
  const el = document.getElementById('projectAdminList');
  const countEl = document.getElementById('projectCount');
  if (!el || !countEl) return;
  countEl.textContent = projects.length;
  el.innerHTML = projects.length ? projects.map((p) => `
    <div class="project-admin-card">
      <div class="project-admin-top">
        <div>
          <div class="project-admin-name">${esc(p.name)}</div>
          <div class="project-admin-desc">${p.memberIds.length} member${p.memberIds.length === 1 ? '' : 's'} assigned</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <select class="mini-select" onchange="setProjectStatus('${p.id}', this.value)">
            <option value="ongoing" ${p.status === 'ongoing' ? 'selected' : ''}>Ongoing</option>
            <option value="on_hold" ${p.status === 'on_hold' ? 'selected' : ''}>On hold</option>
            <option value="completed" ${p.status === 'completed' ? 'selected' : ''}>Completed</option>
          </select>
          <span class="project-del-sm" onclick="deleteProjectAdmin('${p.id}')">✕ Delete</span>
        </div>
      </div>
      <div class="chip-list">
        ${data.members.length ? data.members.map((m) => `
          <span class="chip ${p.memberIds.includes(m.id) ? 'active' : ''}" onclick="toggleProjectMember('${p.id}', '${m.id}')">${p.memberIds.includes(m.id) ? '✓ ' : ''}${esc(m.name)}</span>
        `).join('') : '<span class="project-admin-desc">Add team members in the Team tab first.</span>'}
      </div>
    </div>`).join('') : '<div class="empty">No projects yet — add one below.</div>';
}

/* ================= Live Tracking (admin workspace, NEW) ================= */
function populateLiveTrackProjectOptions() {
  const sel = document.getElementById('liveTrackProjectSelect');
  if (!sel) return;
  const prev = sel.value;
  const ongoing = projects.filter((p) => p.status === 'ongoing');
  sel.innerHTML = ongoing.length
    ? ongoing.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">No ongoing projects</option>';
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function renderLiveTracking() {
  const sel = document.getElementById('liveTrackProjectSelect');
  const statsEl = document.getElementById('liveTrackStats');
  const membersEl = document.getElementById('liveTrackMembers');
  const logsEl = document.getElementById('liveTrackLogs');
  if (!sel || !statsEl || !membersEl || !logsEl) return;
  const projectId = sel.value;
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    statsEl.innerHTML = ''; membersEl.innerHTML = '<div class="empty">Create an ongoing project to see live tracking.</div>'; logsEl.innerHTML = '';
    return;
  }

  let logs = [];
  try { logs = await fetchTimeLogs({ projectId }); } catch (e) { logs = []; }

  const assignedMembers = data.members.filter((m) => project.memberIds.includes(m.id));
  const hoursByAuthUser = {};
  logs.forEach((l) => { hoursByAuthUser[l.userId] = (hoursByAuthUser[l.userId] || 0) + l.duration; });
  const totalSeconds = logs.reduce((s, l) => s + l.duration, 0);

  statsEl.innerHTML = `
    <div class="stat"><div class="label">Assigned members</div><div class="value">${assignedMembers.length}</div></div>
    <div class="stat"><div class="label">Total logged</div><div class="value teal">${formatDuration(totalSeconds)}</div></div>
    <div class="stat"><div class="label">Time entries</div><div class="value">${logs.length}</div></div>
    <div class="stat"><div class="label">Status</div><div class="value">${esc(project.status.replace('_', ' '))}</div></div>
  `;

  membersEl.innerHTML = assignedMembers.length ? assignedMembers.map((m) => {
    const secs = m.authUserId ? (hoursByAuthUser[m.authUserId] || 0) : 0;
    return `<div class="livetrack-member-row"><span>${esc(m.name)}</span><span class="lt-hours">${formatDuration(secs)}</span></div>`;
  }).join('') : '<div class="empty">No one is assigned to this project yet — assign members in the Projects tab.</div>';

  const nameFor = (authUserId) => (data.members.find((m) => m.authUserId === authUserId)?.name) || 'Unknown member';
  logsEl.innerHTML = logs.length ? logs.slice(0, 25).map((l) => `
    <div class="log-item">
      <div>
        <div class="lname">${esc(nameFor(l.userId))}</div>
        <div class="lmeta">${formatLogDate(l.startTime)}${l.notes ? ' · ' + esc(l.notes) : ''}<span class="log-tag">${l.isManual ? 'manual' : 'timer'}</span></div>
      </div>
      <div class="lhrs">${formatDuration(l.duration)}</div>
    </div>`).join('') : '<div class="empty">No time logged against this project yet.</div>';
}

/* ================= Projects (per-week hour logging — admin workspace) ================= */
window.openModal = function openModal(memberId, projectId, prefillProject) {
  editCtx = { memberId, projectId };
  const member = data.members.find((m) => m.id === memberId);
  document.getElementById('modalWho').textContent = `${member.name} · ${selectedWeek}`;
  const mp = document.getElementById('mProject'), md = document.getElementById('mDeadline'),
    mpr = document.getElementById('mPriority'), mst = document.getElementById('mStatus');
  const dayInputs = document.querySelectorAll('#mDays input');
  if (projectId) {
    const p = getProjects(selectedWeek, memberId).find((x) => x.id === projectId);
    document.getElementById('modalTitle').textContent = 'Edit project';
    mp.value = p.project || ''; md.value = p.deadline || ''; mpr.value = p.priority || 'Not started'; mst.value = p.status || 'Not started';
    dayInputs.forEach((inp) => { inp.value = (p.days && p.days[inp.dataset.day]) ? p.days[inp.dataset.day] : ''; });
  } else {
    document.getElementById('modalTitle').textContent = 'Add project';
    mp.value = prefillProject || ''; md.value = ''; mpr.value = 'Not started'; mst.value = 'Not started';
    dayInputs.forEach((inp) => inp.value = '');
  }
  updateDayTotal();
  dayInputs.forEach((inp) => inp.oninput = updateDayTotal);
  document.getElementById('modalBg').classList.add('show');
  setTimeout(() => mp.focus(), 50);
};
function updateDayTotal() {
  let t = 0;
  document.querySelectorAll('#mDays input').forEach((inp) => t += parseFloat(inp.value) || 0);
  document.getElementById('mDayTotal').textContent = `Weekly total: ${t}h`;
}
window.fillAllDays = function fillAllDays() {
  const inputs = document.querySelectorAll('#mDays input');
  const monVal = inputs[0].value;
  if (monVal === '') { showToast('Enter Monday hours first'); return; }
  inputs.forEach((inp) => inp.value = monVal);
  updateDayTotal();
};
window.closeModal = function closeModal() { document.getElementById('modalBg').classList.remove('show'); editCtx = null; };
window.saveProject = async function saveProject() {
  const project = document.getElementById('mProject').value.trim();
  if (!project) { showToast('Project name required'); return; }
  const deadline = document.getElementById('mDeadline').value;
  const days = {};
  document.querySelectorAll('#mDays input').forEach((inp) => { days[inp.dataset.day] = parseFloat(inp.value) || 0; });
  const priority = document.getElementById('mPriority').value;
  const status = document.getElementById('mStatus').value;
  const { memberId, projectId } = editCtx;
  try {
    const id = await upsertAssignment({ id: projectId, weekLabel: selectedWeek, memberId, project, deadline, days, priority, status });
    if (!data.assignments[selectedWeek]) data.assignments[selectedWeek] = {};
    if (!data.assignments[selectedWeek][memberId]) data.assignments[selectedWeek][memberId] = [];
    const list = data.assignments[selectedWeek][memberId];
    if (projectId) { const p = list.find((x) => x.id === projectId); Object.assign(p, { project, deadline, days, priority, status }); }
    else { list.push({ id, project, deadline, days, priority, status }); }
    closeModal(); render(); showToast('Saved');
  } catch (e) { showToast('Could not save — check your connection'); }
};
window.deleteProject = async function deleteProject(memberId, projectId) {
  try {
    await deleteAssignment(projectId);
    const list = getProjects(selectedWeek, memberId);
    data.assignments[selectedWeek][memberId] = list.filter((p) => p.id !== projectId);
    render();
  } catch (e) { showToast('Could not delete'); }
};

/* ================= Render (admin workspace) ================= */
function render() {
  const ws = document.getElementById('weekSelect');
  if (ws.options.length !== weeks.length) {
    ws.innerHTML = weeks.map((w) => `<option value="${w}">${w}${w === currentWeekLabel() ? '  •' : ''}</option>`).join('');
  }
  ws.value = selectedWeek;
  document.getElementById('capacity').value = data.capacity;
  document.getElementById('capNote').textContent = data.capacity;
  populateProjectFilterOptions();

  renderStats();
  renderPeople();
  renderOverview();
  renderTeam();
  if (document.getElementById('tab-projects') && document.getElementById('tab-projects').style.display !== 'none') renderProjectsAdmin();
  if (document.getElementById('tab-livetracking') && document.getElementById('tab-livetracking').style.display !== 'none') { populateLiveTrackProjectOptions(); renderLiveTracking(); }
}

function renderStats() {
  let totalHrs = 0, overloaded = 0, active = 0, teamCap = 0;
  data.members.forEach((m) => {
    const cap = memberCapacity(m);
    const h = memberHours(selectedWeek, m.id);
    totalHrs += h; teamCap += cap;
    if (h > cap) overloaded++;
    if (getProjects(selectedWeek, m.id).length) active++;
  });
  const pct = teamCap > 0 ? Math.round(totalHrs / teamCap * 100) : 0;
  document.getElementById('statStrip').innerHTML = `
    <div class="stat"><div class="label">Team hours logged</div><div class="value teal">${totalHrs}h</div></div>
    <div class="stat"><div class="label">Team utilization</div><div class="value accent">${pct}%</div></div>
    <div class="stat"><div class="label">Overloaded</div><div class="value ${overloaded ? 'danger' : ''}">${overloaded}</div></div>
    <div class="stat"><div class="label">Active members</div><div class="value">${active}/${data.members.length}</div></div>
  `;
}

function renderPeople() {
  const grid = document.getElementById('peopleGrid');
  if (!data.members.length) { grid.innerHTML = '<div class="empty">No team members yet. Add some in the Team tab.</div>'; return; }
  const filterActive = isAdmin() && projectFilter;
  let visibleMembers = data.members;
  if (filterActive) {
    visibleMembers = data.members.filter((m) => getProjects(selectedWeek, m.id).some((p) => (p.project || '').trim().toLowerCase() === projectFilter.trim().toLowerCase()));
  }
  if (filterActive && !visibleMembers.length) { grid.innerHTML = `<div class="empty">No one is logging hours against "${esc(projectFilter)}" this week.</div>`; return; }
  grid.innerHTML = visibleMembers.map((m) => {
    const cap = memberCapacity(m);
    const hrs = memberHours(selectedWeek, m.id);
    const pct = cap > 0 ? Math.round(hrs / cap * 100) : 0;
    const projectsForMember = filterActive
      ? getProjects(selectedWeek, m.id).filter((p) => (p.project || '').trim().toLowerCase() === projectFilter.trim().toLowerCase())
      : getProjects(selectedWeek, m.id);
    return `
    <div class="person">
      <div class="person-head">
        <div class="person-id">
          <div class="avatar">${initials(m.name)}</div>
          <div class="person-name">${esc(m.name)}</div>
        </div>
      </div>
      <div class="load-bar-wrap">
        <div class="load-meta">
          <span class="load-pct" style="color:${loadColor(pct)}">${pct}%</span>
          <span class="load-hours">${hrs}h / ${cap}h</span>
        </div>
        <div class="load-track"><div class="load-fill" style="width:${Math.min(pct, 100)}%;background:${loadColor(pct)}"></div>${pct >= 100 ? '<div class="load-tick"></div>' : ''}</div>
      </div>
      <ul class="projects">
        ${projectsForMember.length ? projectsForMember.map((p) => {
          const dl = deadlineInfo(p.deadline);
          return `
          <li class="project">
            <div class="project-top">
              <div class="project-name" onclick="openModal('${m.id}','${p.id}')" style="cursor:pointer;">${esc(p.project)}</div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="project-hours">${projectHours(p)}h</span>
                <span class="project-del" onclick="deleteProject('${m.id}','${p.id}')">✕</span>
              </div>
            </div>
            <div class="project-meta">
              ${priorityBadge(p.priority)}
              ${statusBadge(p.status)}
              <span class="deadline ${dl.cls}">${dl.txt}</span>
            </div>
            <div class="daygrid">
              ${DAYS.map(([k, label]) => `<div class="daycell ${p.days[k] ? 'filled' : 'empty'}"><div class="d">${label}</div><div class="v">${p.days[k] || '–'}</div></div>`).join('')}
            </div>
          </li>`;
        }).join('') : '<div class="no-proj">No projects logged this week.</div>'}
      </ul>
      <button class="add-proj-btn" onclick="openModal('${m.id}', null)">+ Add project</button>
    </div>`;
  }).join('');
}

function renderOverview() {
  const el = document.getElementById('ovList');
  if (!data.members.length) { el.innerHTML = '<div class="empty">No team members yet.</div>'; return; }
  el.innerHTML = data.members.map((m) => {
    const cap = memberCapacity(m); const hrs = memberHours(selectedWeek, m.id);
    const pct = cap > 0 ? Math.round(hrs / cap * 100) : 0;
    return `
    <div class="ov-row">
      <span class="ov-name">${esc(m.name)}</span>
      <div class="ov-track"><div class="ov-fill" style="width:${Math.min(pct, 100)}%;background:${loadColor(pct)}"></div>${pct >= 100 ? '<div class="ov-100"></div>' : ''}</div>
      <div class="ov-right"><div>${pct}%</div><div class="h">${hrs}h / ${cap}h</div></div>
    </div>`;
  }).join('');
}

function renderTeam() {
  document.getElementById('memberCount').textContent = data.members.length;
  const el = document.getElementById('teamList');
  el.innerHTML = data.members.length ? data.members.map((m) => `
    <div class="ov-row" style="grid-template-columns:1fr auto auto auto;gap:18px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar">${initials(m.name)}</div>
        <span class="ov-name">${esc(m.name)}</span>
      </div>
      <div class="email-cell">
        <input type="email" placeholder="email@adobe.com" value="${esc(m.email || '')}" onchange="setMemberEmail('${m.id}', this.value)">
      </div>
      <div class="cap-cell">
        Capacity
        <input type="number" min="1" step="1" value="${memberCapacity(m)}" onchange="setMemberCapacity('${m.id}', this.value)"> hrs/wk
      </div>
      <span class="person-del" onclick="removeMember('${m.id}')">Remove</span>
    </div>`).join('') : '<div class="empty">No members yet.</div>';
}

function renderRollup() {
  if (!document.getElementById('periodSelect').options.length) buildPeriodOptions();
  const key = document.getElementById('periodSelect').value;
  if (!key) { document.getElementById('rollupTable').innerHTML = '<tr><td colspan="5" class="empty">No data for this period.</td></tr>'; return; }
  const pWeeks = weeksInPeriod(rollupScope, key);
  const nW = pWeeks.length || 1;
  document.getElementById('rollupTableTitle').textContent = `Utilization by person · ${periodLabelOf(key, rollupScope)} (${pWeeks.length} week${pWeeks.length === 1 ? '' : 's'})`;

  let teamHours = 0, teamCap = 0, over = 0, free = 0;
  const rows = data.members.map((m) => {
    const cap = memberCapacity(m);
    let hrs = 0; pWeeks.forEach((w) => hrs += memberHours(w, m.id));
    const periodCap = cap * nW;
    const pct = periodCap > 0 ? Math.round(hrs / periodCap * 100) : 0;
    teamHours += hrs; teamCap += periodCap;
    if (pct > 100) over++; if (pct < 70) free++;
    return { name: m.name, hrs, periodCap, pct };
  }).sort((a, b) => b.pct - a.pct);

  const teamPct = teamCap > 0 ? Math.round(teamHours / teamCap * 100) : 0;
  document.getElementById('rollupStats').innerHTML = `
    <div class="stat"><div class="label">Hours logged</div><div class="value teal">${teamHours}h</div></div>
    <div class="stat"><div class="label">Avg utilization</div><div class="value accent">${teamPct}%</div></div>
    <div class="stat"><div class="label">Overloaded</div><div class="value ${over ? 'danger' : ''}">${over}</div></div>
    <div class="stat"><div class="label">Has availability</div><div class="value">${free}</div></div>
  `;
  document.getElementById('rollupTable').innerHTML = rows.length ? rows.map((r) => `
    <tr><td class="nm">${esc(r.name)}</td><td>${r.hrs}h</td><td>${r.periodCap}h</td><td style="color:${loadColor(r.pct)}">${r.pct}%</td><td>${utilFlag(r.pct)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No team members.</td></tr>';

  let aggregated = aggregateProjects();
  if (isAdmin() && projectFilter) aggregated = aggregated.filter((p) => p.name.trim().toLowerCase() === projectFilter.trim().toLowerCase());
  const delivered = aggregated.filter((p) => p.latestStatus === 'Done');
  const pipeline = aggregated.filter((p) => p.latestStatus !== 'Done');
  document.getElementById('pipelineCount').textContent = pipeline.length;
  document.getElementById('deliveredCount').textContent = delivered.length;
  const dlInfo = (p) => p.deadline ? deadlineInfo(p.deadline).txt : '';
  document.getElementById('pipelineList').innerHTML = pipeline.length ? pipeline.sort((a, b) => (b.latestDate || 0) - (a.latestDate || 0)).map((p) => `
    <div class="proj-item"><div><div class="pname">${esc(p.name)}</div><div class="pmeta">${statusBadge(p.latestStatus)} · ${[...p.members].join(', ')}${p.deadline ? ' · ' + dlInfo(p) : ''}</div></div><div class="phrs">${p.hours}h</div></div>`).join('')
    : '<div class="empty">Nothing in the pipeline.</div>';
  document.getElementById('deliveredList').innerHTML = delivered.length ? delivered.sort((a, b) => (b.latestDate || 0) - (a.latestDate || 0)).map((p) => `
    <div class="proj-item"><div><div class="pname">${esc(p.name)}</div><div class="pmeta">${[...p.members].join(', ')}</div></div><div class="phrs">${p.hours}h</div></div>`).join('')
    : '<div class="empty">Nothing delivered yet.</div>';
}
window.renderRollup = renderRollup;
window.renderLiveTracking = renderLiveTracking;

/* ================= Import / Export (admin workspace) ================= */
document.getElementById('importFile').addEventListener('change', function (e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const wb = XLSX.read(ev.target.result, { type: 'binary', cellDates: true });
      const sheet = wb.Sheets['Weekly Update'] || wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      importRows(rows);
    } catch (err) { showToast('Could not read that file'); }
  };
  reader.readAsBinaryString(file);
  e.target.value = '';
});

function toISO(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return `${d.y}-${pad(d.m)}-${pad(d.d)}`; }
  if (v) { const d = new Date(v); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
  return '';
}

async function importRows(rows) {
  let hdr = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map((x) => String(x).toLowerCase().trim());
    if (r.includes('name') && r.includes('project')) { hdr = i; break; }
  }
  if (hdr < 0) { showToast('Could not find the header row'); return; }
  const H = rows[hdr].map((x) => String(x).toLowerCase().trim());
  const ci = {
    week: H.findIndex((x) => x.startsWith('week')), name: H.indexOf('name'), project: H.indexOf('project'),
    timeline: H.findIndex((x) => x.startsWith('timeline')),
    hours: H.findIndex((x) => x.includes('no of hour') || (x.includes('hour') && !x.includes('capacity') && !x.includes('total'))),
    mon: H.indexOf('mon'), tue: H.indexOf('tue'), wed: H.indexOf('wed'), thu: H.indexOf('thu'), fri: H.indexOf('fri'),
    priority: H.indexOf('priority'), status: H.indexOf('status'), capacity: H.findIndex((x) => x.includes('capacity')),
  };
  const hasDays = ci.mon >= 0 && ci.fri >= 0;
  let curWeek = '', curMember = '', added = 0;
  const nameToId = {}; data.members.forEach((m) => nameToId[m.name.toLowerCase()] = m.id);
  const admin = isAdmin();

  for (let i = hdr + 1; i < rows.length; i++) {
    const row = rows[i];
    const wv = ci.week >= 0 ? String(row[ci.week]).trim() : '';
    const nv = ci.name >= 0 ? String(row[ci.name]).trim() : '';
    if (wv) curWeek = wv;
    if (nv) curMember = nv;
    const pv = ci.project >= 0 ? String(row[ci.project]).trim() : '';
    if (!pv) continue;
    if (!curWeek) continue;
    if (!weeks.includes(curWeek)) weeks.push(curWeek);

    let mid = nameToId[curMember.toLowerCase()];
    if (!mid) { continue; } // Team tab now requires an email at creation time; import never creates new members.
    if (ci.capacity >= 0 && admin) {
      const capv = parseFloat(row[ci.capacity]);
      if (capv > 0) { const mm = data.members.find((x) => x.id === mid); if (mm && mm.capacity !== capv) { try { await updateMemberCapacity(mid, capv); mm.capacity = capv; } catch (e) {} } }
    }
    const deadline = ci.timeline >= 0 ? toISO(row[ci.timeline]) : '';
    let days;
    if (hasDays) {
      days = { mon: parseFloat(row[ci.mon]) || 0, tue: parseFloat(row[ci.tue]) || 0, wed: parseFloat(row[ci.wed]) || 0, thu: parseFloat(row[ci.thu]) || 0, fri: parseFloat(row[ci.fri]) || 0 };
    } else {
      const h = ci.hours >= 0 ? (parseFloat(row[ci.hours]) || 0) : 0;
      const base = Math.floor(h / 5), rem = h - base * 5;
      days = { mon: base, tue: base, wed: base, thu: base, fri: base };
      ['mon', 'tue', 'wed', 'thu', 'fri'].slice(0, rem).forEach((k) => days[k] += 1);
    }
    let priority = ci.priority >= 0 ? String(row[ci.priority]).trim() : 'Not started';
    if (!PRIORITIES.includes(priority)) priority = 'Not started';
    let status = ci.status >= 0 ? String(row[ci.status]).trim() : 'Not started';
    if (!STATUSES.includes(status)) status = 'Not started';

    try {
      const id = await upsertAssignment({ weekLabel: curWeek, memberId: mid, project: pv, deadline, days, priority, status });
      if (!data.assignments[curWeek]) data.assignments[curWeek] = {};
      if (!data.assignments[curWeek][mid]) data.assignments[curWeek][mid] = [];
      data.assignments[curWeek][mid].push({ id, project: pv, deadline, days, priority, status });
      added++;
    } catch (e) { /* row skipped */ }
  }
  weeks.sort((a, b) => new Date(a.slice(0, 11).replace(/-/g, ' ')) - new Date(b.slice(0, 11).replace(/-/g, ' ')));
  render();
  showToast(`Imported ${added} project row(s) (rows for members not already in Team were skipped)`);
}

window.exportExcel = function exportExcel() {
  const aoa = [
    ['POD Weekly Update'],
    ['One row per person per week. Each project logs actual hours per day (Mon-Fri), with deadline, priority, and status.'],
    [],
    ['Week (Mon-Fri)', 'Name', 'Project', 'Timeline (Deadline)', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Total Hours', 'Priority', 'Status', '', 'Weekly Capacity', '% Occupied'],
  ];
  const weeksWithData = weeks.filter((w) => data.assignments[w] && Object.keys(data.assignments[w]).some((mid) => getProjects(w, mid).length));
  const orderWeeks = weeksWithData.length ? weeksWithData : [selectedWeek];
  orderWeeks.forEach((w) => {
    data.members.forEach((m) => {
      const cap = memberCapacity(m);
      const projectsForMember = getProjects(w, m.id);
      const hrs = memberHours(w, m.id);
      const pct = cap > 0 ? Math.round(hrs / cap * 100) + '%' : '';
      const rowsForMember = Math.max(projectsForMember.length, 1);
      for (let i = 0; i < rowsForMember; i++) {
        const p = projectsForMember[i]; const d = p && p.days ? p.days : {};
        aoa.push([
          i === 0 ? w : '', i === 0 ? m.name : '', p ? p.project : '', p && p.deadline ? p.deadline : '',
          p ? (Number(d.mon) || 0) : '', p ? (Number(d.tue) || 0) : '', p ? (Number(d.wed) || 0) : '', p ? (Number(d.thu) || 0) : '', p ? (Number(d.fri) || 0) : '',
          p ? projectHours(p) : '', p ? p.priority : '', p ? (p.status || 'Not started') : '',
          '', i === 0 ? cap : '', i === 0 ? pct : '',
        ]);
      }
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 26 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 11 }, { wch: 16 }, { wch: 12 }, { wch: 3 }, { wch: 14 }, { wch: 11 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Weekly Update');
  XLSX.writeFile(wb, `POD_Weekly_Tracker_${new Date().toISOString().slice(0, 10)}.xlsx`);
};

/* ================= Branding (admin only to edit; both workspaces display it) ================= */
const DEFAULT_MARK_SVG = '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="20" cy="20" r="14.5" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M16.5 13.5 L16.5 26.5 L27 20 Z" fill="currentColor"/></svg>';
function applyLogo() {
  const mark = document.getElementById('brandMark');
  const staticMark = document.getElementById('brandMarkStatic');
  const reset = document.getElementById('markReset');
  const target = isAdmin() ? mark : staticMark;
  mark.style.display = isAdmin() ? 'flex' : 'none';
  staticMark.style.display = isAdmin() ? 'none' : 'flex';
  if (data.logo) { target.innerHTML = `<img src="${data.logo}" alt="logo">`; if (reset) reset.style.display = isAdmin() ? 'flex' : 'none'; }
  else { target.innerHTML = DEFAULT_MARK_SVG; if (reset) reset.style.display = 'none'; }
}
function setupLogo() {
  const mark = document.getElementById('brandMark');
  const input = document.getElementById('logoFile');
  const reset = document.getElementById('markReset');
  mark.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 1.5 * 1024 * 1024) { showToast('Image too large (max ~1.5MB)'); e.target.value = ''; return; }
    const r = new FileReader();
    r.onload = async () => {
      try { await updateAppSettings({ logo_data: r.result }); data.logo = r.result; applyLogo(); showToast('Logo updated'); }
      catch (err) { showToast('Only admins can change the logo'); }
    };
    r.readAsDataURL(f);
    e.target.value = '';
  });
  reset.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try { await updateAppSettings({ logo_data: null }); data.logo = null; applyLogo(); showToast('Logo reset'); }
    catch (err) { showToast('Only admins can change the logo'); }
  });
}
function applyAppName() {
  const name = (data.appName || 'POD Board').trim() || 'POD Board';
  const el = document.getElementById('brandName');
  if (el && document.activeElement !== el) el.textContent = name;
  const tag = (data.tagline || 'Weekly Capacity Tracker').trim() || 'Weekly Capacity Tracker';
  const tel = document.getElementById('brandTagline');
  if (tel && document.activeElement !== tel) tel.textContent = tag;
  document.title = name + ' — ' + tag;
}
async function commitAppName() {
  const el = document.getElementById('brandName');
  let name = el.textContent.replace(/\s+/g, ' ').trim(); if (!name) name = 'POD Board';
  try { await updateAppSettings({ app_name: name }); data.appName = name; el.textContent = name; applyAppName(); showToast('Renamed'); }
  catch (e) { showToast('Only admins can rename the board'); applyAppName(); }
}
async function commitTagline() {
  const el = document.getElementById('brandTagline');
  let tag = el.textContent.replace(/\s+/g, ' ').trim(); if (!tag) tag = 'Weekly Capacity Tracker';
  try { await updateAppSettings({ tagline: tag }); data.tagline = tag; el.textContent = tag; applyAppName(); showToast('Tagline updated'); }
  catch (e) { showToast('Only admins can edit the tagline'); applyAppName(); }
}
function setupRename() {
  const el = document.getElementById('brandName');
  el.contentEditable = isAdmin() ? 'true' : 'false';
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  el.addEventListener('blur', commitAppName);
  const tel = document.getElementById('brandTagline');
  tel.contentEditable = isAdmin() ? 'true' : 'false';
  tel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tel.blur(); } });
  tel.addEventListener('blur', commitTagline);
}

/* ============================================================
   ================= MEMBER WORKSPACE (NEW) ===================
   ============================================================
   Strictly isolated from the admin workspace: never calls fetchBoard()
   (which is admin-scoped by RLS), only ever touches `projects` /
   `project_assignments` / `time_logs` rows the signed-in user is allowed
   to see, per the RLS policies in supabase/schema_update.sql. */

let memberProjects = []; // projects assigned to this member (already RLS-scoped)
let myTimeLogs = [];     // this member's own time log rows

const timerState = {
  running: false,
  projectId: null,
  projectName: '',
  firstStart: null,       // ISO timestamp of when the timer was first started (for this session)
  segmentStart: null,     // Date when the current running segment began (null while paused)
  accumulatedSeconds: 0,  // seconds banked from previous segments (before the current running one)
  intervalId: null,
};

function elapsedTimerSeconds() {
  const running = timerState.segmentStart ? (Date.now() - timerState.segmentStart.getTime()) / 1000 : 0;
  return timerState.accumulatedSeconds + running;
}
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = pad(Math.floor(s / 3600));
  const mm = pad(Math.floor((s % 3600) / 60));
  const ss = pad(s % 60);
  return `${hh}:${mm}:${ss}`;
}
function tickTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (el) el.textContent = formatClock(elapsedTimerSeconds());
}

window.startTimer = function startTimer() {
  const sel = document.getElementById('timerProjectSelect');
  if (!sel || !sel.value) { showToast('Choose a project first'); return; }
  timerState.running = true;
  timerState.projectId = sel.value;
  timerState.projectName = sel.options[sel.selectedIndex]?.text || '';
  timerState.firstStart = new Date().toISOString();
  timerState.accumulatedSeconds = 0;
  timerState.segmentStart = new Date();
  timerState.intervalId = setInterval(tickTimerDisplay, 1000);
  tickTimerDisplay();
  sel.disabled = true;
  document.getElementById('timerStartBtn').style.display = 'none';
  document.getElementById('timerPauseBtn').style.display = '';
  document.getElementById('timerResumeBtn').style.display = 'none';
  document.getElementById('timerStopBtn').style.display = '';
};
window.pauseTimer = function pauseTimer() {
  if (!timerState.segmentStart) return;
  timerState.accumulatedSeconds += (Date.now() - timerState.segmentStart.getTime()) / 1000;
  timerState.segmentStart = null;
  timerState.running = false;
  clearInterval(timerState.intervalId); timerState.intervalId = null;
  tickTimerDisplay();
  document.getElementById('timerPauseBtn').style.display = 'none';
  document.getElementById('timerResumeBtn').style.display = '';
};
window.resumeTimer = function resumeTimer() {
  timerState.segmentStart = new Date();
  timerState.running = true;
  timerState.intervalId = setInterval(tickTimerDisplay, 1000);
  document.getElementById('timerPauseBtn').style.display = '';
  document.getElementById('timerResumeBtn').style.display = 'none';
};
window.stopTimer = async function stopTimer() {
  const totalSeconds = elapsedTimerSeconds();
  clearInterval(timerState.intervalId); timerState.intervalId = null;
  const session = getSession();
  if (session && timerState.projectId && totalSeconds >= 1) {
    try {
      await insertTimeLog({
        userId: session.user.id,
        projectId: timerState.projectId,
        durationSeconds: totalSeconds,
        startTime: timerState.firstStart,
        endTime: new Date().toISOString(),
        notes: null,
        isManual: false,
      });
      showToast(`Saved ${formatDuration(totalSeconds)} on ${timerState.projectName}`);
    } catch (e) { showToast('Could not save your time — check your connection'); }
  }
  timerState.running = false; timerState.projectId = null; timerState.projectName = '';
  timerState.firstStart = null; timerState.segmentStart = null; timerState.accumulatedSeconds = 0;
  const sel = document.getElementById('timerProjectSelect');
  if (sel) sel.disabled = false;
  const disp = document.getElementById('timerDisplay'); if (disp) disp.textContent = '00:00:00';
  document.getElementById('timerStartBtn').style.display = '';
  document.getElementById('timerPauseBtn').style.display = 'none';
  document.getElementById('timerResumeBtn').style.display = 'none';
  document.getElementById('timerStopBtn').style.display = 'none';
  await loadMemberWorkspaceData();
  renderMemberWorkspace();
};

window.submitManualEntry = async function submitManualEntry() {
  const sel = document.getElementById('manualProjectSelect');
  const dateEl = document.getElementById('manualDate');
  const hrsEl = document.getElementById('manualHours');
  const minsEl = document.getElementById('manualMinutes');
  const notesEl = document.getElementById('manualNotes');
  if (!sel || !sel.value) { showToast('Choose a project'); return; }
  const hours = parseInt(hrsEl.value, 10) || 0;
  const minutes = parseInt(minsEl.value, 10) || 0;
  const durationSeconds = hours * 3600 + minutes * 60;
  if (durationSeconds <= 0) { showToast('Enter hours and/or minutes'); return; }
  const dateVal = dateEl.value || new Date().toISOString().slice(0, 10);
  const session = getSession();
  if (!session) return;
  try {
    await insertTimeLog({
      userId: session.user.id,
      projectId: sel.value,
      durationSeconds,
      startTime: `${dateVal}T12:00:00`,
      endTime: null,
      notes: notesEl.value.trim() || null,
      isManual: true,
    });
    hrsEl.value = ''; minsEl.value = ''; notesEl.value = '';
    showToast('Time logged');
    await loadMemberWorkspaceData();
    renderMemberWorkspace();
  } catch (e) { showToast('Could not save — check your connection'); }
};

window.editTimeLogNotes = async function editTimeLogNotes(id) {
  const log = myTimeLogs.find((l) => l.id === id); if (!log) return;
  const next = window.prompt('Edit notes for this time entry:', log.notes || '');
  if (next === null) return;
  try {
    await updateTimeLog(id, { notes: next.trim() || null });
    log.notes = next.trim();
    renderMemberLogsList();
    showToast('Notes updated');
  } catch (e) { showToast('Could not update this entry'); }
};

function populateMemberProjectSelects() {
  const options = memberProjects.length
    ? memberProjects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">No projects assigned</option>';
  ['timerProjectSelect', 'manualProjectSelect'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = options;
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  });
  const dateEl = document.getElementById('manualDate');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
}

function renderMemberStats() {
  const el = document.getElementById('memberStatStrip');
  if (!el) return;
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now); mon.setDate(now.getDate() + (day === 0 ? -6 : 1 - day)); mon.setHours(0, 0, 0, 0);
  const weekSeconds = myTimeLogs.filter((l) => new Date(l.startTime) >= mon).reduce((s, l) => s + l.duration, 0);
  const totalSeconds = myTimeLogs.reduce((s, l) => s + l.duration, 0);
  el.innerHTML = `
    <div class="stat"><div class="label">This week</div><div class="value teal">${formatDuration(weekSeconds)}</div></div>
    <div class="stat"><div class="label">All-time logged</div><div class="value accent">${formatDuration(totalSeconds)}</div></div>
    <div class="stat"><div class="label">Assigned projects</div><div class="value">${memberProjects.length}</div></div>
    <div class="stat"><div class="label">Total entries</div><div class="value">${myTimeLogs.length}</div></div>
  `;
}

function renderMemberProjectsList() {
  const el = document.getElementById('memberProjectsList');
  if (!el) return;
  if (!myMemberId) {
    el.innerHTML = '<div class="empty">Your login isn\'t linked to a team member yet. Ask your admin to add your email in the Team tab.</div>';
    return;
  }
  if (!memberProjects.length) { el.innerHTML = '<div class="empty">No projects assigned to you yet.</div>'; return; }
  el.innerHTML = memberProjects.map((p) => {
    const secs = myTimeLogs.filter((l) => l.projectId === p.id).reduce((s, l) => s + l.duration, 0);
    return `
    <div class="proj-item">
      <div>
        <div class="pname">${esc(p.name)}</div>
        <div class="pmeta">Status: ${esc(p.status.replace('_', ' '))} · ${formatDuration(secs)} logged total</div>
      </div>
    </div>`;
  }).join('');
}

function renderMemberLogsList() {
  const el = document.getElementById('memberLogsList');
  if (!el) return;
  if (!myTimeLogs.length) { el.innerHTML = '<div class="empty">No time logged yet — start the timer or log time manually above.</div>'; return; }
  const nameFor = (id) => (memberProjects.find((p) => p.id === id)?.name) || 'Unknown project';
  el.innerHTML = myTimeLogs.slice(0, 30).map((l) => `
    <div class="log-item">
      <div>
        <div class="lname">${esc(nameFor(l.projectId))}</div>
        <div class="lmeta">${formatLogDate(l.startTime)}${l.notes ? ' · ' + esc(l.notes) : ''}<span class="log-tag">${l.isManual ? 'manual' : 'timer'}</span><span class="log-edit" onclick="editTimeLogNotes('${l.id}')">Edit notes</span></div>
      </div>
      <div class="lhrs">${formatDuration(l.duration)}</div>
    </div>`).join('');
}

function renderMemberWorkspace() {
  populateMemberProjectSelects();
  renderMemberStats();
  renderMemberProjectsList();
  renderMemberLogsList();
}

async function loadMemberWorkspaceData() {
  const session = getSession();
  myMemberId = session ? await getMemberIdForAuthUser(session.user.id) : null;
  try { memberProjects = await fetchProjects(); } catch (e) { memberProjects = []; }
  try {
    myTimeLogs = session ? await fetchTimeLogs({ userId: session.user.id }) : [];
  } catch (e) { myTimeLogs = []; }
}

/* ================= Init (after auth) ================= */
let initialized = false;

async function initAdminWorkspace() {
  buildWeeks();
  await loadData();
  const cur = currentWeekLabel();
  selectedWeek = weeks.includes(cur) ? cur : (Object.keys(data.assignments)[0] || weeks[0]);
  applyAppName();
  applyLogo();
  setupRename();
  setupLogo();
  buildPeriodOptions();
  render();
}

async function initMemberWorkspace() {
  // Branding only — never touches the admin-scoped `members`/`assignments` tables.
  try { data = { ...data, ...(await fetchAppSettingsOnly()) }; } catch (e) { /* keep defaults */ }
  applyAppName();
  applyLogo();
  await loadMemberWorkspaceData();
  renderMemberWorkspace();
}

async function initApp() {
  if (unsubscribeRealtime) unsubscribeRealtime();
  if (isAdmin()) await initAdminWorkspace();
  else await initMemberWorkspace();
  unsubscribeRealtime = subscribeToBoard(reload);
  initialized = true;
}

initAuth({
  onAuthed: () => { initApp(); },
  onSignedOut: () => {
    if (unsubscribeRealtime) { unsubscribeRealtime(); unsubscribeRealtime = null; }
    if (timerState.intervalId) { clearInterval(timerState.intervalId); timerState.intervalId = null; }
    initialized = false;
  },
});
