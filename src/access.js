// GUARDRAILS. Every read and write, from the web app or from Claude (MCP), goes through here.
// Claude never decides who can see what; the app does.
//
//   Employee : own reports and own spend only.
//   Manager  : own direct reportees' submitted reports (view, correct, approve/reject) and spend by
//              department / by reportee for their own team only. While a manager is out of office, the
//              colleague they delegate to can review and decide those reports (logged "on behalf of").
//   Finance  : department-level totals across the company, never per-person spend. Two narrow,
//              deliberate exceptions so finance can do its job: (1) reports over the second-approval
//              threshold that are escalated to finance, and (2) the payout queue (payee, amount, dates).

import { q } from './db.js';
import { LIMITS } from './policy.js';

export class AppError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

const USER_COLS = 'id, name, email, role, department, title, manager_id, mcp_token, password_hash, delegate_id, delegate_until';
export const getUserById = async (id) => (await q(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id])).rows[0] || null;
export const getUserByEmail = async (email) => (await q(`SELECT ${USER_COLS} FROM users WHERE lower(email)=lower($1)`, [email])).rows[0] || null;
export const getUserByToken = async (token) => (await q(`SELECT ${USER_COLS} FROM users WHERE mcp_token=$1`, [token])).rows[0] || null;
export const getTeam = async (managerId) =>
  (await q(`SELECT id, name, department, title FROM users WHERE manager_id=$1 ORDER BY department, name`, [managerId])).rows;

// Managers who have delegated their approvals to `userId` right now (out of office until a date, inclusive).
export const ACTIVE_DELEGATION = `delegate_until >= (now() AT TIME ZONE 'Asia/Kolkata')::date`;
export const getDelegators = async (userId) =>
  (await q(`SELECT id, name, delegate_until FROM users WHERE delegate_id = $1 AND ${ACTIVE_DELEGATION} ORDER BY name`, [userId])).rows;

export function describeAccess(user, team = []) {
  if (user.role === 'employee') return 'You can create, edit and submit your own expense reports, see your own spend and see when approved claims are paid.';
  if (user.role === 'manager') {
    const depts = [...new Set(team.map((t) => t.department))];
    return `You can see and approve reports from your direct reportees (${team.map((t) => t.name).join(', ') || 'none'}) and see spend for your departments (${depts.join(', ') || 'none'}), by department or by person, plus your departments' budgets, compliance and KPIs. You can set an out-of-office delegate, and review reports delegated to you. You cannot see other teams. Reports over ₹${LIMITS.financeApproval.toLocaleString('en-IN')} go to Finance for a second approval after yours.`;
  }
  return `You can see department-level spend across the company (by department, approving manager, category or month), set quarterly department budgets, track policy compliance and KPIs, and pull the GST ledger. You also give the second approval on reports over ₹${LIMITS.financeApproval.toLocaleString('en-IN')} and record payouts from the payout queue. Other individual reports and per-person spend are hidden from Finance by design.`;
}

// Who is this user to the report?
//   owner    : filed it
//   manager  : owner's manager, once submitted (drafts are private)
//   delegate : a manager covering for the owner's manager while they are out of office
//   finance  : finance, only for reports escalated for second approval
function relation(user, r) {
  if (r.owner_id === user.id) return 'owner';
  if (r.status === 'draft') return null;
  if (user.role === 'manager' && r.owner_manager_id === user.id) return 'manager';
  if (user.role === 'manager' && r.manager_delegate_id === user.id && r.delegation_active) return 'delegate';
  if (user.role === 'finance' && r.escalated_at) return 'finance';
  return null;
}

export async function loadReportFor(user, reportId) {
  const id = Number(reportId);
  if (!Number.isInteger(id)) throw new AppError('Report not found.', 404);
  const r = (await q(
    `SELECT r.*, u.name AS owner_name, u.department AS owner_department, u.manager_id AS owner_manager_id,
            m.name AS owner_manager_name, m.delegate_id AS manager_delegate_id,
            (m.${ACTIVE_DELEGATION}) AS delegation_active,
            d.name AS decided_by_name, ma.name AS manager_approved_by_name, pb.name AS paid_by_name
       FROM reports r JOIN users u ON u.id = r.owner_id
       LEFT JOIN users m ON m.id = u.manager_id
       LEFT JOIN users d ON d.id = r.decided_by
       LEFT JOIN users ma ON ma.id = r.manager_approved_by
       LEFT JOIN users pb ON pb.id = r.paid_by
      WHERE r.id = $1`,
    [id]
  )).rows[0];
  if (!r) throw new AppError('Report not found.', 404);

  const rel = relation(user, r);
  if (!rel) {
    if (user.role === 'finance') throw new AppError('Access denied: Finance sees department-level totals only. Individual reports are visible to Finance only when escalated for second approval.');
    // Same message for another team's report and a reportee's draft: reveal neither whose it is nor that it exists.
    if (user.role === 'manager') throw new AppError('Access denied: managers can only see reports that their direct reportees have submitted.');
    throw new AppError('You can only see your own expense reports.');
  }
  r.rel = rel;
  const reviewer = rel === 'manager' || rel === 'delegate';
  r.can = {
    // Owners edit drafts, rejected and 'being revised' reports. A submitted report must be reopened first
    // (start_edit), which moves it to 'revising' so the manager can't approve half-edited data.
    // The manager can correct lines while a report waits for them. Approved reports are locked for everyone.
    edit: (rel === 'owner' && ['draft', 'rejected', 'revising'].includes(r.status)) || (rel === 'manager' && r.status === 'submitted'),
    start_edit: rel === 'owner' && r.status === 'submitted',
    submit: rel === 'owner' && ['draft', 'rejected', 'revising'].includes(r.status),
    decide: (reviewer && r.status === 'submitted') || (rel === 'finance' && r.status === 'finance_review'),
    delete: rel === 'owner' && r.status === 'draft',
    comment: true,
    flag: r.status !== 'approved',
    resolve_flag: (reviewer && r.status === 'submitted') || (rel === 'finance' && r.status === 'finance_review'),
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

// Approved / Pending filter (the dashboard boxes). Pending = submitted, being revised or waiting for Finance.
export const STATUS_FILTERS = { approved: ['approved'], pending: ['submitted', 'revising', 'finance_review'] };
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
            COALESCE(SUM(e.amount) FILTER (WHERE r.status IN ('submitted','revising','finance_review')), 0) AS pending,
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
            COALESCE(SUM(e.amount) FILTER (WHERE r.status IN ('submitted','revising','finance_review')), 0) AS pending
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

// ---------- Process KPIs (Finance: company and by department; managers: own team) ----------
// submit -> final approval days, approval -> payment days, % of reports flagged, % sent back for revision.
export async function kpiSummary(user, { from, to } = {}) {
  if (user.role === 'employee') throw new AppError('KPIs are visible to managers and Finance only.');
  const { where, params, p, scope } = await scopeFor(user, {});
  where.push(`r.status <> 'draft'`, 'r.submitted_at IS NOT NULL');
  if (from) where.push(`r.submitted_at >= ${p(from)}`);
  if (to) where.push(`r.submitted_at < (${p(to)}::date + 1)`);
  const { rows } = await q(
    `WITH base AS (
       SELECT r.id, u.department, r.status, r.submitted_at, r.decided_at, r.paid_on,
              (EXISTS (SELECT 1 FROM expenses e WHERE e.report_id = r.id AND e.policy_flag IS NOT NULL)
               OR EXISTS (SELECT 1 FROM flags f WHERE f.report_id = r.id)) AS flagged,
              EXISTS (SELECT 1 FROM activity a WHERE a.report_id = r.id
                       AND (a.action LIKE 'Reopened for editing%' OR a.action LIKE 'Rejected%')) AS sent_back
         FROM reports r JOIN users u ON u.id = r.owner_id
        WHERE ${where.join(' AND ')})
     SELECT department, GROUPING(department) AS is_total,
            COUNT(*)::int AS reports,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE paid_on IS NOT NULL)::int AS paid,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (decided_at - submitted_at)) / 86400)
              FILTER (WHERE status = 'approved' AND decided_at IS NOT NULL) AS median_submit_to_approve_days,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY (paid_on - (decided_at AT TIME ZONE 'Asia/Kolkata')::date))
              FILTER (WHERE paid_on IS NOT NULL AND decided_at IS NOT NULL) AS median_approve_to_paid_days,
            ROUND(100.0 * AVG(flagged::int))::int AS pct_flagged,
            ROUND(100.0 * AVG(sent_back::int))::int AS pct_sent_back
       FROM base
      GROUP BY GROUPING SETS ((department), ())
      ORDER BY GROUPING(department), department`,
    params
  );
  const fmt = (x) => ({
    reports: x.reports, approved: x.approved, paid: x.paid,
    median_submit_to_approve_days: x.median_submit_to_approve_days == null ? null : Math.round(Number(x.median_submit_to_approve_days) * 10) / 10,
    median_approve_to_paid_days: x.median_approve_to_paid_days == null ? null : Math.round(Number(x.median_approve_to_paid_days) * 10) / 10,
    pct_flagged: x.pct_flagged, pct_sent_back: x.pct_sent_back,
  });
  const total = rows.find((x) => x.is_total) || { reports: 0, approved: 0, paid: 0, pct_flagged: 0, pct_sent_back: 0 };
  return {
    scope,
    filters: { from: from || null, to: to || null },
    overall: fmt(total),
    by_department: rows.filter((x) => !x.is_total).map((x) => ({ department: x.department, ...fmt(x) })),
    note: 'Reports submitted in the period (drafts excluded). Flagged = any policy breach or review flag. Sent back = rejected or reopened for editing at least once. Days are calendar days; medians ignore reports not yet approved / paid.',
  };
}
