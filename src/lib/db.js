import { supabase } from './supabaseClient.js';

const DAY_COLS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * Fetches all board state and reshapes it into the nested object the
 * original app's render functions expect:
 *   { appName, tagline, capacity, logo, members:[{id,name,capacity}],
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
  const members = membersRes.data.map((m) => ({ id: m.id, name: m.name, capacity: Number(m.capacity) }));

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

/* ---------------- app_settings (admin only, enforced by RLS) ---------------- */

export async function updateAppSettings(patch) {
  const { error } = await supabase.from('app_settings').update(patch).eq('id', 1);
  if (error) throw error;
}

/* ---------------- members (write = admin only, enforced by RLS) ---------------- */

export async function insertMember(name, capacity) {
  const { data, error } = await supabase.from('members').insert({ name, capacity }).select().single();
  if (error) throw error;
  return { id: data.id, name: data.name, capacity: Number(data.capacity) };
}

export async function updateMemberCapacity(id, capacity) {
  const { error } = await supabase.from('members').update({ capacity }).eq('id', id);
  if (error) throw error;
}

export async function deleteMember(id) {
  // ON DELETE CASCADE on assignments.member_id removes their rows too.
  const { error } = await supabase.from('members').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- assignments / projects (any signed-in @adobe.com user) ---------------- */

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
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export { DAY_COLS };
