import * as XLSX from 'xlsx';
import { initAuth, isAdmin } from './lib/auth.js';
import {
  fetchBoard, updateAppSettings, insertMember, updateMemberCapacity, deleteMember,
  upsertAssignment, deleteAssignment, subscribeToBoard,
} from './lib/db.js';

/* ================= State ================= */
let data = { appName: 'POD Board', tagline: 'Weekly Capacity Tracker', capacity: 40, members: [], assignments: {} };
let weeks = [];
let selectedWeek = null;
let editCtx = null; // {memberId, projectId|null}
let unsubscribeRealtime = null;

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

/* ================= Data load (Supabase) ================= */
async function loadData() {
  data = await fetchBoard();
  Object.keys(data.assignments).forEach((w) => { if (!weeks.includes(w)) weeks.push(w); });
}
async function reload() { await loadData(); render(); }

/* ================= Helpers ================= */
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

/* ================= Tabs / controls ================= */
window.switchTab = function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  ['board', 'overview', 'rollup', 'team'].forEach((t) => { document.getElementById('tab-' + t).style.display = t === tab ? 'block' : 'none'; });
  if (tab === 'rollup') renderRollup();
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

/* ================= Members ================= */
window.addMember = async function addMember() {
  const el = document.getElementById('newMemberName');
  const name = el.value.trim();
  if (!name) { showToast('Enter a name'); return; }
  try {
    const m = await insertMember(name, data.capacity);
    data.members.push(m);
    el.value = ''; render(); showToast('Member added');
  } catch (e) { showToast('Only admins can add members'); }
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

/* ================= Projects ================= */
window.openModal = function openModal(memberId, projectId) {
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
    mp.value = ''; md.value = ''; mpr.value = 'Not started'; mst.value = 'Not started';
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

/* ================= Render ================= */
function render() {
  const ws = document.getElementById('weekSelect');
  if (ws.options.length !== weeks.length) {
    ws.innerHTML = weeks.map((w) => `<option value="${w}">${w}${w === currentWeekLabel() ? '  •' : ''}</option>`).join('');
  }
  ws.value = selectedWeek;
  document.getElementById('capacity').value = data.capacity;
  document.getElementById('capNote').textContent = data.capacity;

  renderStats();
  renderPeople();
  renderOverview();
  renderTeam();
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
  grid.innerHTML = data.members.map((m) => {
    const cap = memberCapacity(m);
    const hrs = memberHours(selectedWeek, m.id);
    const pct = cap > 0 ? Math.round(hrs / cap * 100) : 0;
    const projects = getProjects(selectedWeek, m.id);
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
        ${projects.length ? projects.map((p) => {
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
    <div class="ov-row" style="grid-template-columns:1fr auto auto;gap:18px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar">${initials(m.name)}</div>
        <span class="ov-name">${esc(m.name)}</span>
      </div>
      <div class="cap-cell admin-only">
        Capacity
        <input type="number" min="1" step="1" value="${memberCapacity(m)}" onchange="setMemberCapacity('${m.id}', this.value)"> hrs/wk
      </div>
      <span class="person-del admin-only" onclick="removeMember('${m.id}')">Remove</span>
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

  const projects = aggregateProjects();
  const delivered = projects.filter((p) => p.latestStatus === 'Done');
  const pipeline = projects.filter((p) => p.latestStatus !== 'Done');
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

/* ================= Import / Export ================= */
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
    if (!mid) {
      if (!admin) { continue; } // only admins can create new members; skip row for unknown members
      try {
        const nm = await insertMember(curMember, data.capacity);
        data.members.push(nm); nameToId[curMember.toLowerCase()] = nm.id; mid = nm.id;
      } catch (e) { continue; }
    }
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
  showToast(`Imported ${added} project row(s)${admin ? '' : ' (new members skipped — admin only)'}`);
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
      const projects = getProjects(w, m.id);
      const hrs = memberHours(w, m.id);
      const pct = cap > 0 ? Math.round(hrs / cap * 100) + '%' : '';
      const rowsForMember = Math.max(projects.length, 1);
      for (let i = 0; i < rowsForMember; i++) {
        const p = projects[i]; const d = p && p.days ? p.days : {};
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

/* ================= Branding (admin only) ================= */
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

/* ================= Init (after auth) ================= */
let initialized = false;
async function initApp() {
  if (unsubscribeRealtime) unsubscribeRealtime();
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
  unsubscribeRealtime = subscribeToBoard(reload);
  initialized = true;
}

initAuth({
  onAuthed: () => { initApp(); },
  onSignedOut: () => {
    if (unsubscribeRealtime) { unsubscribeRealtime(); unsubscribeRealtime = null; }
    initialized = false;
  },
});
