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
    return `You can see and approve reports from your direct reportees (${team.map((t) => t.name).join(', ') || 'none'}) and see spend for your departments (${depts.join(', ') || 'none'}), by department or by person. You cannot see other teams.`;
  }
  return 'You can see department-level spend totals across the company. Individual reports and per-person spend are hidden from Finance by design.';
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
    // Owners can keep editing until the report is approved; managers can correct lines while it waits for them.
    edit: (rel === 'owner' && r.status !== 'approved') || (rel === 'manager' && r.status === 'submitted'),
    submit: rel === 'owner' && ['draft', 'rejected'].includes(r.status),
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
  month: "to_char(e.spent_on, 'YYYY-MM')",
};

const sameName = (full, asked) => {
  const a = asked.trim().toLowerCase();
  return full.toLowerCase() === a || full.split(' ')[0].toLowerCase() === a;
};

// Spend summary with role-based scope. Counts submitted (pending) + approved reports.
export async function spendSummary(user, { group_by = 'category', department, person, from, to } = {}) {
  const groupExpr = GROUPS[group_by];
  if (!groupExpr) throw new AppError('group_by must be one of: category, department, person, month.', 400);

  const where = [`r.status IN ('submitted','approved')`];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  let scope;

  if (user.role === 'employee') {
    if (group_by === 'department' || group_by === 'person' || department || person) {
      throw new AppError('Employees can only see their own spend (group by category or month).');
    }
    where.push(`u.id = ${p(user.id)}`);
    scope = `${user.name}'s own expenses`;
  } else if (user.role === 'manager') {
    const team = await getTeam(user.id);
    const depts = [...new Set(team.map((t) => t.department))];
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
    if (department) where.push(`lower(u.department) = lower(${p(String(department).trim())})`);
    scope = 'All departments (department-level totals only)';
  } else {
    throw new AppError('Unknown role.');
  }

  if (from) where.push(`e.spent_on >= ${p(from)}`);
  if (to) where.push(`e.spent_on <= ${p(to)}`);

  const { rows } = await q(
    `SELECT ${groupExpr} AS grp,
            COALESCE(SUM(e.amount) FILTER (WHERE r.status = 'approved'), 0)  AS approved,
            COALESCE(SUM(e.amount) FILTER (WHERE r.status = 'submitted'), 0) AS pending,
            SUM(e.amount) AS total,
            COUNT(*)::int AS items
       FROM expenses e
       JOIN reports r ON r.id = e.report_id
       JOIN users u   ON u.id = r.owner_id
      WHERE ${where.join(' AND ')}
      GROUP BY grp
      ORDER BY total DESC`,
    params
  );

  const out = rows.map((r) => ({ group: r.grp, approved: r.approved, pending: r.pending, total: r.total, items: r.items }));
  const sum = (k) => Math.round(out.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return {
    scope,
    group_by,
    filters: { department: department || null, person: person || null, from: from || null, to: to || null },
    rows: out,
    totals: { approved: sum('approved'), pending: sum('pending'), total: sum('total'), items: out.reduce((s, r) => s + r.items, 0) },
    note: 'Amounts in INR. "pending" = submitted and awaiting approval; drafts and rejected reports are excluded.',
  };
}
