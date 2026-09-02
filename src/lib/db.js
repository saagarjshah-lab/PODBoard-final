import { supabase } from './supabaseClient.js';

const DAY_COLS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * Fetches all ADMIN board state and reshapes it into the nested object the
 * admin render functions expect. Admin-only: RLS scopes `members` and
 * `assignments` to admins; a member session would get an empty/partial
 * result here, which is why the Member Workspace never calls this.
 *   { appName, tagline, capacity, logo, members:[{id,name,capacity,email,authUserId}],
 *     assignments: { [weekLabel]: { [memberId]: [ {id, project, deadline, days, priority, status} ] } } }
 */
export async function fetchBoard() {
  const [settingsRes, membersRes, assignmentsRes] = await Promise.all([
    supabase.from('app_settings').select('*').eq('id', 1).single(),
    supabase.from('members').select('*').order('created_at', { ascending: true }),
    supabase.from('assignments').select('*').order('created_at', { ascending: true }),
  ]);

  if (settingsRes.error) throw settingsRes.error;
  if (membersRes.error) throw membersRes.error;
  if (assignmentsRes.error) throw assignmentsRes.error;

  const settings = settingsRes.data;
  const members = membersRes.data.map((m) => ({
    id: m.id, name: m.name, capacity: Number(m.capacity), email: m.email || '', authUserId: m.auth_user_id || null,
  }));

  const assignments = {};
  for (const row of assignmentsRes.data) {
    if (!assignments[row.week_label]) assignments[row.week_label] = {};
    if (!assignments[row.week_label][row.member_id]) assignments[row.week_label][row.member_id] = [];
    assignments[row.week_label][row.member_id].push({
      id: row.id,
      project: row.project,
      deadline: row.deadline || '',
      days: { mon: Number(row.mon) || 0, tue: Number(row.tue) || 0, wed: Number(row.wed) || 0, thu: Number(row.thu) || 0, fri: Number(row.fri) || 0 },
      priority: row.priority,
      status: row.status,
    });
  }

  return {
    appName: settings.app_name,
    tagline: settings.tagline,
    capacity: Number(settings.default_capacity),
    logo: settings.logo_data || null,
    members,
    assignments,
  };
}

/**
 * Lightweight branding-only fetch used by the Member Workspace (which never
 * calls fetchBoard, since `members`/`assignments` are admin-scoped by RLS).
 * `app_settings` itself stays readable by any signed-in @adobe.com user —
 * it's just branding, nothing member-sensitive.
 */
export async function fetchAppSettingsOnly() {
  const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return {
    appName: data.app_name,
    tagline: data.tagline,
    capacity: Number(data.default_capacity),
    logo: data.logo_data || null,
  };
}

/* ---------------- app_settings (admin only, enforced by RLS) ---------------- */

export async function updateAppSettings(patch) {
  const { error } = await supabase.from('app_settings').update(patch).eq('id', 1);
  if (error) throw error;
}

/* ---------------- members (write = admin only, enforced by RLS) ---------------- */

export async function insertMember(name, capacity, email) {
  const payload = { name, capacity };
  if (email) payload.email = email;
  const { data, error } = await supabase.from('members').insert(payload).select().single();
  if (error) throw error;
  return { id: data.id, name: data.name, capacity: Number(data.capacity), email: data.email || '', authUserId: data.auth_user_id || null };
}

export async function updateMemberCapacity(id, capacity) {
  const { error } = await supabase.from('members').update({ capacity }).eq('id', id);
  if (error) throw error;
}

export async function updateMemberEmail(id, email) {
  const { error } = await supabase.from('members').update({ email: email || null }).eq('id', id);
  if (error) throw error;
}

export async function deleteMember(id) {
  // ON DELETE CASCADE on assignments.member_id / project_assignments.member_id removes their rows too.
  const { error } = await supabase.from('members').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- assignments (legacy per-week hour log; admin-only end to end) ---------------- */

export async function upsertAssignment({ id, weekLabel, memberId, project, deadline, days, priority, status }) {
  const row = {
    week_label: weekLabel,
    member_id: memberId,
    project,
    deadline: deadline || null,
    mon: Number(days.mon) || 0,
    tue: Number(days.tue) || 0,
    wed: Number(days.wed) || 0,
    thu: Number(days.thu) || 0,
    fri: Number(days.fri) || 0,
    priority,
    status,
    updated_at: new Date().toISOString(),
  };
  if (id) {
    const { error } = await supabase.from('assignments').update(row).eq('id', id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from('assignments').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function deleteAssignment(id) {
  const { error } = await supabase.from('assignments').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- member <-> auth-user linking ---------------- */

/**
 * If a `members` row exists whose email matches the given email and that
 * row isn't linked to an auth user yet, links it to the given auth user id.
 * No-ops (returns null) if no such row exists or it's already claimed by
 * someone else — safe to call on every login.
 */
export async function claimMemberByEmail(email, authUserId) {
  if (!email || !authUserId) return null;
  const { data: rows, error } = await supabase
    .from('members')
    .select('id')
    .ilike('email', email)
    .is('auth_user_id', null)
    .limit(1);
  if (error || !rows || !rows.length) return null;
  const { error: updErr } = await supabase.from('members').update({ auth_user_id: authUserId }).eq('id', rows[0].id);
  if (updErr) return null;
  return rows[0].id;
}

/** Returns the members.id linked to the given auth user id, or null. */
export async function getMemberIdForAuthUser(authUserId) {
  if (!authUserId) return null;
  const { data, error } = await supabase.from('members').select('id').eq('auth_user_id', authUserId).maybeSingle();
  if (error || !data) return null;
  return data.id;
}

/* ---------------- projects (read scoped by RLS: admin = all, member = assigned only) ---------------- */

/** Fetches projects visible to the current user, along with which member ids are staffed on each. */
export async function fetchProjects() {
  const [projRes, assignRes] = await Promise.all([
    supabase.from('projects').select('*').order('created_at', { ascending: true }),
    supabase.from('project_assignments').select('project_id, member_id'),
  ]);
  if (projRes.error) throw projRes.error;
  if (assignRes.error) throw assignRes.error;

  const memberIdsByProject = {};
  for (const row of assignRes.data) {
    if (!memberIdsByProject[row.project_id]) memberIdsByProject[row.project_id] = [];
    memberIdsByProject[row.project_id].push(row.member_id);
  }
  return projRes.data.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    status: p.status,
    memberIds: memberIdsByProject[p.id] || [],
  }));
}

export async function insertProject({ name, description, status }) {
  const { data, error } = await supabase
    .from('projects')
    .insert({ name, description: description || null, status: status || 'ongoing' })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, description: data.description || '', status: data.status, memberIds: [] };
}

export async function updateProjectStatus(id, status) {
  const { error } = await supabase.from('projects').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function deleteProjectRow(id) {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

export async function assignMemberToProject(projectId, memberId) {
  const { error } = await supabase.from('project_assignments').insert({ project_id: projectId, member_id: memberId });
  if (error) throw error;
}

export async function unassignMemberFromProject(projectId, memberId) {
  const { error } = await supabase.from('project_assignments').delete().eq('project_id', projectId).eq('member_id', memberId);
  if (error) throw error;
}

/* ---------------- time_logs (member: own rows only; admin: all rows) ---------------- */

/**
 * Fetches time log rows, newest first. Pass `userId` and/or `projectId` to
 * narrow the query — RLS enforces that a non-admin can only ever get their
 * own rows back regardless of what filters are passed.
 */
export async function fetchTimeLogs({ userId, projectId } = {}) {
  let q = supabase.from('time_logs').select('*').order('start_time', { ascending: false });
  if (userId) q = q.eq('user_id', userId);
  if (projectId) q = q.eq('project_id', projectId);
  const { data, error } = await q;
  if (error) throw error;
  return data.map((r) => ({
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    duration: Number(r.duration) || 0,
    startTime: r.start_time,
    endTime: r.end_time,
    notes: r.notes || '',
    isManual: !!r.is_manual,
  }));
}

export async function insertTimeLog({ userId, projectId, durationSeconds, startTime, endTime, notes, isManual }) {
  const { data, error } = await supabase
    .from('time_logs')
    .insert({
      user_id: userId,
      project_id: projectId,
      duration: Math.max(0, Math.round(durationSeconds) || 0),
      start_time: startTime || new Date().toISOString(),
      end_time: endTime || null,
      notes: notes || null,
      is_manual: !!isManual,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateTimeLog(id, patch) {
  const { error } = await supabase.from('time_logs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

/* ---------------- realtime ---------------- */

/** Subscribes to changes on all board tables; calls onChange() (debounced) for any of them. */
export function subscribeToBoard(onChange) {
  let timer = null;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(onChange, 250); };

  const channel = supabase
    .channel('pod-board-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'project_assignments' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'time_logs' }, debounced)
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export { DAY_COLS };
