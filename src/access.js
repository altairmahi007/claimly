// GUARDRAILS. Every read and write, from the web app or from Claude (MCP), goes through here.
// Claude never decides who can see what; the app does.
//
//   Employee : own reports and own spend only.
//   Manager  : own direct reportees' reports (view, edit while submitted, approve/reject)
//              and spend by department / by reportee, for their own team only.
//   Finance  : department-level totals across the company. No individual reports, no per-person spend.

import { q } from './db.js';

export class AppError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

const USER_COLS = 'id, name, email, role, department, title, manager_id, mcp_token, password_hash';
export const getUserById = async (id) => (await q(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id])).rows[0] || null;
export const getUserByEmail = async (email) => (await q(`SELECT ${USER_COLS} FROM users WHERE lower(email)=lower($1)`, [email])).rows[0] || null;
export const getUserByToken = async (token) => (await q(`SELECT ${USER_COLS} FROM users WHERE mcp_token=$1`, [token])).rows[0] || null;
export const getTeam = async (managerId) =>
  (await q(`SELECT id, name, department, title FROM users WHERE manager_id=$1 ORDER BY department, name`, [managerId])).rows;

export function describeAccess(user, team = []) {
  if (user.role === 'employee') return 'You can create, edit and submit your own expense reports, and see your own spend.';
  if (user.role === 'manager') {
    const depts = [...new Set(team.map((t) => t.department))];
    return `You can see and approve reports from your direct reportees (${team.map((t) => t.name).join(', ') || 'none'}) and see spend for your departments (${depts.join(', ') || 'none'}), by department or by person, plus your departments' budgets and policy compliance. You cannot see other teams.`;
  }
  return 'You can see department-level spend across the company (by department, approving manager, category or month), set quarterly department budgets, track policy compliance by department and pull the GST input-credit ledger. Individual reports and per-person spend are hidden from Finance by design.';
}

// Managers see a reportee's report only once it has been submitted: drafts are private to the employee.
function relation(user, ownerId, ownerManagerId, status) {
  if (ownerId === user.id) return 'owner';
  if (user.role === 'manager' && ownerManagerId === user.id && status !== 'draft') return 'manager';
  return null;
}

export async function loadReportFor(user, reportId) {
  const id = Number(reportId);
  if (!Number.isInteger(id)) throw new AppError('Report not found.', 404);
  const r = (await q(
    `SELECT r.*, u.name AS owner_name, u.department AS owner_department, u.manager_id AS owner_manager_id,
            d.name AS decided_by_name
       FROM reports r JOIN users u ON u.id = r.owner_id
       LEFT JOIN users d ON d.id = r.decided_by
      WHERE r.id = $1`,
    [id]
  )).rows[0];
  if (!r) throw new AppError('Report not found.', 404);

  const rel = relation(user, r.owner_id, r.owner_manager_id, r.status);
  if (!rel) {
    if (user.role === 'finance') throw new AppError('Finance can only see department-level totals, not individual expense reports.');
    // Same message for another team's report and a reportee's draft: reveal neither whose it is nor that it exists.
    if (user.role === 'manager') throw new AppError('Access denied: managers can only see reports that their direct reportees have submitted.');
    throw new AppError('You can only see your own expense reports.');
  }
  r.rel = rel;
  r.can = {
    // Owners edit drafts, rejected and 'being revised' reports. A submitted report must be reopened first
    // (start_edit), which moves it to 'revising' so the manager can't approve half-edited data.
    // Managers can correct lines while a report waits for them. Approved reports are locked for everyone.
    edit: (rel === 'owner' && ['draft', 'rejected', 'revising'].includes(r.status)) || (rel === 'manager' && r.status === 'submitted'),
    start_edit: rel === 'owner' && r.status === 'submitted',
    submit: rel === 'owner' && ['draft', 'rejected', 'revising'].includes(r.status),
    decide: rel === 'manager' && r.status === 'submitted',
    delete: rel === 'owner' && r.status === 'draft',
    comment: true,
    flag: r.status !== 'approved',
    resolve_flag: rel === 'manager' && r.status === 'submitted',
  };
  return r;
}

const GROUPS = {
  category: 'e.category',
  department: 'u.department',
  person: 'u.name',
  manager: "COALESCE(m.name, '(no manager)')", // the reportee's manager, i.e. who approves the spend
  month: "to_char(e.spent_on, 'YYYY-MM')",
};

const sameName = (full, asked) => {
  const a = asked.trim().toLowerCase();
  return full.toLowerCase() === a || full.split(' ')[0].toLowerCase() === a;
};

// Approved / Pending filter (the dashboard boxes). Pending = submitted or being revised.
export const STATUS_FILTERS = { approved: ['approved'], pending: ['submitted', 'revising'] };
export function dbStatuses(statuses) {
  const keys = (statuses && statuses.length ? statuses : ['approved', 'pending']).filter((k) => STATUS_FILTERS[k]);
  if (!keys.length) throw new AppError('statuses must include "approved" and/or "pending".', 400);
  return { keys, db: keys.flatMap((k) => STATUS_FILTERS[k]) };
}

// The role-based WHERE clause shared by every aggregate (spend, budgets, compliance).
// Employees: own expenses. Managers: own direct reportees. Finance: everyone, but never per person.
async function scopeFor(user, { group_by, department, person } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  let scope;
  let depts = null;
  if (user.role === 'employee') {
    if (['department', 'person', 'manager'].includes(group_by) || department || person) {
      throw new AppError('Employees can only see their own spend (group by category or month).');
    }
    where.push(`u.id = ${p(user.id)}`);
    scope = `${user.name}'s own expenses`;
  } else if (user.role === 'manager') {
    const team = await getTeam(user.id);
    depts = [...new Set(team.map((t) => t.department))];
    where.push(`u.manager_id = ${p(user.id)}`);
    if (department) {
      const d = depts.find((x) => x.toLowerCase() === String(department).trim().toLowerCase());
      if (!d) throw new AppError(`Access denied: "${department}" is not one of your departments. You can only see spend for ${depts.join(', ') || 'your own team'}.`);
      where.push(`u.department = ${p(d)}`);
    }
    if (person) {
      const m = team.find((t) => sameName(t.name, String(person)));
      if (!m) throw new AppError(`Access denied: ${person} is not your direct reportee. You can only see spend for ${team.map((t) => t.name).join(', ') || 'your own team'}.`);
      where.push(`u.id = ${p(m.id)}`);
    }
    scope = `${user.name}'s team (${depts.join(', ')})`;
  } else if (user.role === 'finance') {
    if (group_by === 'person' || person) {
      throw new AppError('Access denied: Finance can see department-level totals only, not spend by individual employee.');
    }
    where.push(`u.role = 'employee'`);
    if (department) where.push(`lower(u.department) = lower(${p(String(department).trim())})`);
    scope = 'All departments (department-level totals only)';
  } else {
    throw new AppError('Unknown role.');
  }
  return { where, params, p, scope, depts };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Spend summary with role-based scope, for the selected statuses (approved and/or pending).
export async function spendSummary(user, { group_by = 'category', department, person, from, to, statuses } = {}) {
  const groupExpr = GROUPS[group_by];
  if (!groupExpr) throw new AppError(`group_by must be one of: ${Object.keys(GROUPS).join(', ')}.`, 400);
  const st = dbStatuses(statuses);
  const { where, params, p, scope } = await scopeFor(user, { group_by, department, person });
  where.push(`r.status = ANY(${p(st.db)})`);
  if (from) where.push(`e.spent_on >= ${p(from)}`);
  if (to) where.push(`e.spent_on <= ${p(to)}`);

  const { rows } = await q(
    `SELECT ${groupExpr} AS grp,
            COALESCE(SUM(e.amount) FILTER (WHERE r.status = 'approved'), 0)  AS approved,
            COALESCE(SUM(e.amount) FILTER (WHERE r.status IN ('submitted','revising')), 0) AS pending,
            SUM(e.amount) AS total,
            COALESCE(SUM(e.gst) FILTER (WHERE r.status = 'approved'), 0) AS gst_approved,
            COUNT(*)::int AS items
       FROM expenses e
       JOIN reports r ON r.id = e.report_id
       JOIN users u   ON u.id = r.owner_id
       LEFT JOIN users m ON m.id = u.manager_id
      WHERE ${where.join(' AND ')}
      GROUP BY grp
      ORDER BY total DESC`,
    params
  );

  const out = rows.map((r) => ({ group: r.grp, approved: r.approved, pending: r.pending, total: r.total, gst_approved: r.gst_approved, items: r.items }));
  const sum = (k) => round2(out.reduce((s, r) => s + r[k], 0));
  return {
    scope,
    group_by,
    statuses: st.keys,
    filters: { department: department || null, person: person || null, from: from || null, to: to || null },
    rows: out,
    totals: { approved: sum('approved'), pending: sum('pending'), total: sum('total'), gst_approved: sum('gst_approved'), items: out.reduce((s, r) => s + r.items, 0) },
    note: 'Amounts in INR. "pending" = submitted or being revised, awaiting approval; drafts and rejected reports are excluded. ' +
      '"gst_approved" = GST on approved expenses (claimable input credit).',
  };
}

// ---------- Department budgets (per quarter). Finance sets them; managers see their own departments. ----------
// Quarters follow the Indian financial year: Q1 = Apr–Jun, Q2 = Jul–Sep, Q3 = Oct–Dec, Q4 = Jan–Mar.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Any 'YYYY-MM' or 'YYYY-MM-DD' (default: today) -> the quarter containing it.
export function quarterOf(when) {
  const v = String(when || new Date().toISOString().slice(0, 10));
  const m = v.match(/^(\d{4})-(0[1-9]|1[0-2])(-\d{2})?$/);
  if (!m) throw new AppError('quarter must be a month (YYYY-MM) or date (YYYY-MM-DD) inside the quarter.', 400);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const startMonth = mo - ((mo - 1) % 3); // 1, 4, 7, 10
  const end = new Date(Date.UTC(y, startMonth + 2, 0));
  const fyStart = startMonth >= 4 ? y : y - 1;
  const qn = { 4: 1, 7: 2, 10: 3, 1: 4 }[startMonth];
  const key = `${y}-${String(startMonth).padStart(2, '0')}`;
  return {
    key,
    from: `${key}-01`,
    to: end.toISOString().slice(0, 10),
    label: `${MON[startMonth - 1]}–${MON[startMonth + 1]} ${y} (Q${qn} FY ${fyStart}-${String(fyStart + 1).slice(2)})`,
  };
}
// The current quarter and the ones before it, newest first (for the dropdown).
export function recentQuarters(n = 6) {
  const out = [];
  let q0 = quarterOf();
  for (let i = 0; i < n; i++) {
    out.push(q0);
    const [y, m] = q0.key.split('-').map(Number);
    q0 = quarterOf(new Date(Date.UTC(y, m - 4, 1)).toISOString().slice(0, 7));
  }
  return out;
}

export async function budgetStatus(user, { quarter, statuses } = {}) {
  if (user.role === 'employee') throw new AppError('Department budgets are visible to managers and Finance only.');
  const qtr = quarterOf(quarter);
  const st = dbStatuses(statuses);
  const { where, params, p, scope, depts } = await scopeFor(user, {});
  where.push(`r.status = ANY(${p(st.db)})`, `e.spent_on >= ${p(qtr.from)}`, `e.spent_on <= ${p(qtr.to)}`);
  const spend = (await q(
    `SELECT u.department AS dept,
            COALESCE(SUM(e.amount) FILTER (WHERE r.status = 'approved'), 0) AS approved,
            COALESCE(SUM(e.amount) FILTER (WHERE r.status IN ('submitted','revising')), 0) AS pending
       FROM expenses e JOIN reports r ON r.id = e.report_id JOIN users u ON u.id = r.owner_id
      WHERE ${where.join(' AND ')} GROUP BY u.department`,
    params
  )).rows;
  const deptList = depts || (await q(`SELECT DISTINCT department FROM users WHERE role = 'employee' ORDER BY department`)).rows.map((r) => r.department);
  const budgets = Object.fromEntries((await q(`SELECT department, quarterly_amount FROM budgets WHERE quarterly_amount IS NOT NULL`)).rows.map((b) => [b.department, b.quarterly_amount]));
  const rows = deptList.map((d) => {
    const s = spend.find((x) => x.dept === d) || { approved: 0, pending: 0 };
    const used = round2(s.approved + s.pending);
    const budget = budgets[d] ?? null;
    const pct = budget ? Math.round((used / budget) * 100) : null;
    const state = budget == null ? 'no budget' : pct > 100 ? 'over' : pct >= 80 ? 'near limit' : pct >= 60 ? 'watch' : 'ok';
    return { department: d, budget, approved: s.approved, pending: s.pending, used, remaining: budget == null ? null : round2(budget - used), pct_used: pct, state };
  });
  return {
    scope, quarter: qtr.key, quarter_label: qtr.label, from: qtr.from, to: qtr.to, statuses: st.keys, rows,
    note: 'Quarterly budget per department vs spend dated in that quarter (approved + pending unless filtered). States: ok (<60%), watch (60-79%), near limit (80-100%), over (>100%).',
  };
}

export async function setBudget(user, department, amount) {
  if (user.role !== 'finance') throw new AppError('Access denied: only Finance can set department budgets.');
  const d = (await q(`SELECT DISTINCT department FROM users WHERE role = 'employee' AND lower(department) = lower($1)`, [String(department ?? '').trim()])).rows[0];
  if (!d) throw new AppError(`Unknown department "${department}".`, 400);
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt >= 0) || amt > 1000000000) throw new AppError('Budget must be a number between 0 and 1,00,00,00,000 INR.', 400);
  await q(
    `INSERT INTO budgets (department, quarterly_amount, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (department) DO UPDATE SET quarterly_amount = EXCLUDED.quarterly_amount, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [d.department, amt, user.id]
  );
  return { department: d.department, quarterly_amount: amt };
}

// ---------- Policy compliance by department (no names) ----------
export async function complianceSummary(user, { from, to, statuses } = {}) {
  if (user.role === 'employee') throw new AppError('Compliance by department is visible to managers and Finance only.');
  const st = dbStatuses(statuses);
  const base = await scopeFor(user, {});
  base.where.push(`r.status = ANY(${base.p(st.db)})`);
  const lineWhere = [...base.where];
  const lp = [...base.params];
  const lpush = (v) => { lp.push(v); return `$${lp.length}`; };
  if (from) lineWhere.push(`e.spent_on >= ${lpush(from)}`);
  if (to) lineWhere.push(`e.spent_on <= ${lpush(to)}`);
  const lines = (await q(
    `SELECT u.department AS dept, COUNT(DISTINCT r.id)::int AS reports, COUNT(e.id)::int AS lines,
            COUNT(e.id) FILTER (WHERE e.policy_flag IS NOT NULL)::int AS policy_lines,
            COALESCE(SUM(e.amount) FILTER (WHERE e.policy_flag IS NOT NULL), 0) AS policy_value,
            COALESCE(SUM(e.amount), 0) AS total
       FROM expenses e JOIN reports r ON r.id = e.report_id JOIN users u ON u.id = r.owner_id
      WHERE ${lineWhere.join(' AND ')} GROUP BY u.department ORDER BY u.department`,
    lp
  )).rows;
  const flags = (await q(
    `SELECT u.department AS dept, COUNT(*) FILTER (WHERE f.resolved_at IS NULL)::int AS open_flags, COUNT(*)::int AS all_flags
       FROM flags f JOIN reports r ON r.id = f.report_id JOIN users u ON u.id = r.owner_id
      WHERE ${base.where.join(' AND ')} GROUP BY u.department`,
    base.params
  )).rows;
  const depts = [...new Set([...lines.map((l) => l.dept), ...flags.map((f) => f.dept)])].sort();
  const rows = depts.map((d) => {
    const l = lines.find((x) => x.dept === d) || { reports: 0, lines: 0, policy_lines: 0, policy_value: 0, total: 0 };
    const f = flags.find((x) => x.dept === d) || { open_flags: 0, all_flags: 0 };
    return {
      department: d, reports: l.reports, lines: l.lines, policy_breaches: l.policy_lines, policy_breach_value: l.policy_value,
      pct_lines_breaching: l.lines ? Math.round((l.policy_lines / l.lines) * 100) : 0, review_flags: f.all_flags, open_review_flags: f.open_flags,
    };
  });
  return {
    scope: base.scope, statuses: st.keys, filters: { from: from || null, to: to || null }, rows,
    note: 'policy_breaches = lines over a company limit (checked by the app). review_flags = issues raised in review, often by Claude.',
  };
}

// ---------- GST input credit, for the accountant (Finance only) ----------
export async function gstLedger(user, { from, to } = {}) {
  if (user.role !== 'finance') throw new AppError('Access denied: the GST ledger is for Finance.');
  const params = [];
  const where = [`r.status = 'approved'`, `u.role = 'employee'`];
  if (from) { params.push(from); where.push(`e.spent_on >= $${params.length}`); }
  if (to) { params.push(to); where.push(`e.spent_on <= $${params.length}`); }
  return (await q(
    `SELECT to_char(e.spent_on, 'YYYY-MM') AS month, u.department, e.category,
            SUM(e.amount) AS amount, SUM(e.gst) AS gst, COUNT(*)::int AS lines
       FROM expenses e JOIN reports r ON r.id = e.report_id JOIN users u ON u.id = r.owner_id
      WHERE ${where.join(' AND ')}
      GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3`,
    params
  )).rows;
}
