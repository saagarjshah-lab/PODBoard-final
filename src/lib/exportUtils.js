import * as XLSX from 'xlsx';

/* This module is a pure formatting/serialization layer: it takes plain row
   arrays the caller has already assembled from app state and turns them
   into downloadable .xlsx workbooks or .csv files. It has no knowledge of
   Supabase, RLS, or the app's internal data shapes — that aggregation
   happens in src/main.js, which then calls these functions with tidy,
   already-computed rows. */

function stamp() { return new Date().toISOString().slice(0, 10); }

function downloadCSVFromAOA(aoa, filename) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * EXPORT 1 — Per Team Member.
 * `boardRows`: [{ member, week, project, mon, tue, wed, thu, fri, total, priority, status, capacity, utilizationPct }]
 *   — one row per project logged by a member in a given week (legacy Week Board data).
 * `timeLogRows`: [{ member, project, date, durationHrs, isManual, notes }]
 *   — one row per timer/manual time_logs entry, across all members.
 * `format`: 'xlsx' (multi-sheet workbook) or 'csv' (Weekly Breakdown sheet only — CSV has no concept of multiple sheets).
 */
export function exportPerMemberReport(boardRows, timeLogRows, format = 'xlsx') {
  const boardAoa = [
    ['Per Team Member Report — Weekly Board Breakdown'],
    ['Projects, daily logs, total hours, and weekly utilization % per person.'],
    [],
    ['Member', 'Week', 'Project', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Total Hours', 'Priority', 'Status', 'Capacity', 'Utilization %'],
    ...boardRows.map((r) => [r.member, r.week, r.project, r.mon, r.tue, r.wed, r.thu, r.fri, r.total, r.priority, r.status, r.capacity, r.utilizationPct]),
  ];

  if (format === 'csv') {
    downloadCSVFromAOA(boardAoa, `Per_Member_Report_${stamp()}.csv`);
    return;
  }

  const timeLogAoa = [
    ['Per Team Member Report — Time Log Entries (Live Timer + Manual)'],
    [],
    ['Member', 'Project', 'Date', 'Duration (hrs)', 'Source', 'Notes'],
    ...timeLogRows.map((r) => [r.member, r.project, r.date, r.durationHrs, r.isManual ? 'Manual' : 'Timer', r.notes || '']),
  ];

  const boardWs = XLSX.utils.aoa_to_sheet(boardAoa);
  boardWs['!cols'] = [{ wch: 18 }, { wch: 26 }, { wch: 20 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 12 }, { wch: 16 }, { wch: 13 }, { wch: 10 }, { wch: 14 }];

  const timeLogWs = XLSX.utils.aoa_to_sheet(timeLogAoa);
  timeLogWs['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 30 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, boardWs, 'Weekly Breakdown');
  XLSX.utils.book_append_sheet(wb, timeLogWs, 'Time Logs');
  XLSX.writeFile(wb, `Per_Member_Report_${stamp()}.xlsx`);
}

/**
 * EXPORT 2 — Per Project.
 * `rows`: [{ project, status, billable, contributors, hoursLoggedTimer, hoursLoggedBoard, startDate, targetDate, completedAt }]
 *   — one row per project entity, with a contributor breakdown, total hours
 *      burned from both tracking systems, deadlines, and milestone completion.
 * `format`: 'xlsx' or 'csv'.
 */
export function exportPerProjectReport(rows, format = 'xlsx') {
  const aoa = [
    ['Per Project Report'],
    ['Contributor breakdown, total hours burned, deadlines, and milestone completion.'],
    [],
    ['Project', 'Status', 'Billing', 'Contributors', 'Timer-Logged Hours', 'Weekly-Board Hours', 'Start Date', 'Target Date', 'Completed On'],
    ...rows.map((r) => [
      r.project, r.status, r.billable ? 'Billable' : 'Internal', r.contributors,
      r.hoursLoggedTimer, r.hoursLoggedBoard, r.startDate || '', r.targetDate || '', r.completedAt || '',
    ]),
  ];

  if (format === 'csv') {
    downloadCSVFromAOA(aoa, `Per_Project_Report_${stamp()}.csv`);
    return;
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 26 }, { wch: 12 }, { wch: 10 }, { wch: 34 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 13 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Per Project');
  XLSX.writeFile(wb, `Per_Project_Report_${stamp()}.xlsx`);
}
