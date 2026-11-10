// Report and expense operations. Every function checks access through access.js first.

import { q, pool, insertExpense, logActivity } from './db.js';
import { ACTIVE_DELEGATION, AppError, STATUS_FILTERS, loadReportFor } from './access.js';
import { CATEGORIES, FLAG_KINDS, LIMITS, PAYOUT_MODES, policyFlag } from './policy.js';

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export function validateExpense(raw) {
  const spent_on = String(raw.spent_on ?? raw.date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spent_on) || isNaN(Date.parse(spent_on))) throw new AppError(`Invalid date "${spent_on}". Use YYYY-MM-DD.`, 400);
  const merchant = String(raw.merchant ?? '').trim();
  if (!merchant) throw new AppError('Merchant is required.', 400);
  if (merchant.length > 140) throw new AppError('Merchant name is too long.', 400);
  const category = CATEGORIES.find((c) => c.toLowerCase() === String(raw.category ?? '').trim().toLowerCase());
  if (!category) throw new AppError(`Invalid category "${raw.category}". Use one of: ${CATEGORIES.join(', ')}.`, 400);
  const amount = Math.round(Number(raw.amount) * 100) / 100;
  if (!(amount > 0) || amount > 10000000) throw new AppError('Amount must be a positive number (INR).', 400);
  const gst = raw.gst === undefined || raw.gst === '' || raw.gst === null ? 0 : Math.round(Number(raw.gst) * 100) / 100;
  if (!(gst >= 0) || gst > amount) throw new AppError('GST must be between 0 and the amount.', 400);
  const notes = raw.notes ? String(raw.notes).trim().slice(0, 500) : null;
  return { spent_on, merchant, category, amount, gst, notes };
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const touch = (client, id) => client.query(`UPDATE reports SET updated_at = now() WHERE id = $1`, [id]);

// statuses: optional ['approved'] / ['pending'] filter from the dashboard boxes (pending = submitted or being revised).
// scope: 'mine' (own), 'team' (manager: own reportees, submitted only), 'delegated' (manager: teams of
// managers who are out of office and delegated to you), 'finance' (finance: reports escalated for second approval).
// statuses: optional ['approved'] / ['pending'] filter from the dashboard boxes.
export async function listReports(user, { scope = 'mine', status, statuses } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (user.role === 'finance') {
    if (scope !== 'finance') throw new AppError('Finance can see department-level totals only. The only individual reports Finance sees are those escalated for second approval (scope "finance").');
    where.push('r.escalated_at IS NOT NULL');
  } else if (scope === 'finance') {
    throw new AppError('Only Finance can list reports escalated for second approval.');
  } else if (scope === 'team') {
    if (user.role !== 'manager') throw new AppError('Only managers can list team reports.');
    where.push(`u.manager_id = ${p(user.id)}`);
    where.push(`r.status <> 'draft'`); // drafts stay private to the employee
  } else if (scope === 'delegated') {
    if (user.role !== 'manager') throw new AppError('Only managers can cover approvals for another manager.');
    where.push(`m.delegate_id = ${p(user.id)}`, `m.${ACTIVE_DELEGATION}`, `r.status <> 'draft'`);
  } else {
    where.push(`r.owner_id = ${p(user.id)}`);
  }
  if (status) where.push(`r.status = ${p(status)}`);
  if (statuses && statuses.length) where.push(`r.status = ANY(${p(statuses.flatMap((k) => STATUS_FILTERS[k] || []))})`);
  const { rows } = await q(
    `SELECT r.id, r.title, r.status, r.created_via, r.created_at, r.submitted_at, r.decided_at, r.paid_on, r.paid_mode,
            u.name AS owner_name, u.department, m.name AS manager_name,
            GREATEST(0, (now()::date - r.submitted_at::date))::int AS days_waiting,
            COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.report_id = r.id), 0) AS total,
            (SELECT COUNT(*)::int FROM expenses e WHERE e.report_id = r.id) AS items,
            (SELECT COUNT(*)::int FROM expenses e WHERE e.report_id = r.id AND e.policy_flag IS NOT NULL) AS flags,
            (SELECT COUNT(*)::int FROM flags f WHERE f.report_id = r.id AND f.resolved_at IS NULL) AS open_flags,
            COALESCE((SELECT array_agg(DISTINCT f.kind) FROM flags f WHERE f.report_id = r.id AND f.resolved_at IS NULL), '{}') AS flag_kinds,
            (SELECT COUNT(*)::int FROM comments c WHERE c.report_id = r.id) AS comments,
            (SELECT cu.name FROM comments c JOIN users cu ON cu.id = c.author_id
              WHERE c.report_id = r.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_commenter
       FROM reports r
       JOIN users u ON u.id = r.owner_id
       LEFT JOIN users m ON m.id = u.manager_id
      WHERE ${where.join(' AND ')}
      ORDER BY (r.status = 'submitted') DESC, (r.status = 'finance_review') DESC, (r.status = 'revising') DESC, r.created_at DESC`,
    params
  );
  return rows;
}

export async function getReport(user, id) {
  const r = await loadReportFor(user, id);
  r.expenses = (await q(`SELECT * FROM expenses WHERE report_id = $1 ORDER BY spent_on, id`, [r.id])).rows;
  r.activity = (await q(
    `SELECT a.*, u.name AS actor_name FROM activity a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.report_id = $1 ORDER BY a.at DESC, a.id DESC`,
    [r.id]
  )).rows;
  r.total = Math.round(r.expenses.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  r.gst_total = Math.round(r.expenses.reduce((s, e) => s + e.gst, 0) * 100) / 100;
  r.flag_count = r.expenses.filter((e) => e.policy_flag).length;
  r.flags = (await q(
    `SELECT f.id, f.expense_id, f.kind, f.message, f.via, f.created_at, f.resolved_at, f.resolution,
            ru.name AS raised_by_name, ru.role AS raised_by_role, xu.name AS resolved_by_name, e.merchant AS expense_merchant
       FROM flags f LEFT JOIN users ru ON ru.id = f.raised_by LEFT JOIN users xu ON xu.id = f.resolved_by
       LEFT JOIN expenses e ON e.id = f.expense_id
      WHERE f.report_id = $1 ORDER BY (f.resolved_at IS NULL) DESC, f.created_at, f.id`,
    [r.id]
  )).rows.map((f) => ({ ...f, label: FLAG_KINDS[f.kind] || f.kind }));
  r.open_flags = r.flags.filter((f) => !f.resolved_at).length;
  r.comments = (await q(
    `SELECT c.id, c.body, c.via, c.created_at, u.name AS author_name, u.role AS author_role
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.report_id = $1 ORDER BY c.created_at, c.id`,
    [r.id]
  )).rows;
  return r;
}

export async function createReport(user, { title, expenses = [], via = 'web' }) {
  if (user.role !== 'employee') throw new AppError('In this demo only employees file expense reports (managers approve, finance reviews totals).');
  const t = String(title ?? '').trim();
  if (!t) throw new AppError('Report title is required.', 400);
  const items = expenses.map(validateExpense);
  return tx(async (client) => {
    const id = (await client.query(
      `INSERT INTO reports (owner_id, title, created_via) VALUES ($1, $2, $3) RETURNING id`,
      [user.id, t.slice(0, 140), via]
    )).rows[0].id;
    for (const e of items) await insertExpense(client, id, e);
    await logActivity(client, id, user.id, via, `Created report with ${items.length} expense${items.length === 1 ? '' : 's'}`);
    return id;
  });
}

// Reopen a submitted report for editing: it becomes 'revising', which the manager can see but not approve
// until the employee resubmits. This is the web "Edit" button, and happens automatically when the owner
// edits a submitted report through Claude.
export async function startRevision(user, reportId, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (r.status === 'revising' && r.rel === 'owner') return r.id;
  if (!r.can.start_edit) throw new AppError(r.status === 'approved' ? 'This report is approved and locked.' : 'Only the employee who filed a submitted report can reopen it for editing.');
  await tx(async (client) => {
    await client.query(`UPDATE reports SET status = 'revising', updated_at = now() WHERE id = $1`, [r.id]);
    await logActivity(client, r.id, user.id, via, 'Reopened for editing (approval paused until resubmitted)');
  });
  return r.id;
}

const notEditable = (r) => new AppError(r.status === 'approved' ? 'This report is approved and locked; it can no longer be edited.' : `This report is ${r.status} and can't be edited by you right now.`);

// Load a report for an edit; an owner editing a submitted report reopens it first.
async function loadEditable(user, reportId, via) {
  let r = await loadReportFor(user, reportId);
  if (r.can.start_edit) {
    await startRevision(user, r.id, via);
    r = await loadReportFor(user, r.id);
  }
  if (!r.can.edit) throw notEditable(r);
  return r;
}

export async function addExpenses(user, reportId, expenses, via = 'web') {
  const items0 = expenses.map(validateExpense); // validate before reopening anything
  const r = await loadEditable(user, reportId, via);
  const items = items0;
  return tx(async (client) => {
    const ids = [];
    for (const e of items) ids.push(await insertExpense(client, r.id, e));
    await logActivity(client, r.id, user.id, via, `Added ${items.length} expense${items.length === 1 ? '' : 's'}: ${items.map((e) => `${e.merchant} ${inr(e.amount)}`).join(', ')}`);
    await touch(client, r.id);
    return ids;
  });
}

async function loadExpense(user, expenseId, via) {
  const e = (await q(`SELECT * FROM expenses WHERE id = $1`, [Number(expenseId)])).rows[0];
  if (!e) throw new AppError('Expense not found.', 404);
  const r = await loadEditable(user, e.report_id, via);
  return { e, r };
}

export async function updateExpense(user, expenseId, fields, via = 'web') {
  const { e, r } = await loadExpense(user, expenseId, via);
  const merged = validateExpense({ ...e, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
  const changes = ['spent_on', 'merchant', 'category', 'amount', 'gst', 'notes']
    .filter((k) => String(merged[k] ?? '') !== String(e[k] ?? ''))
    .map((k) => `${k}: ${k === 'amount' || k === 'gst' ? inr(e[k]) : e[k] ?? '—'} → ${k === 'amount' || k === 'gst' ? inr(merged[k]) : merged[k] ?? '—'}`);
  if (!changes.length) return r.id;
  return tx(async (client) => {
    await client.query(
      `UPDATE expenses SET spent_on=$2, merchant=$3, category=$4, amount=$5, gst=$6, notes=$7, policy_flag=$8 WHERE id=$1`,
      [e.id, merged.spent_on, merged.merchant, merged.category, merged.amount, merged.gst, merged.notes, policyFlag(merged)]
    );
    await logActivity(client, r.id, user.id, via, `Edited "${e.merchant}" (${changes.join('; ')})`);
    await touch(client, r.id);
    return r.id;
  });
}

export async function deleteExpense(user, expenseId, via = 'web') {
  const { e, r } = await loadExpense(user, expenseId, via);
  return tx(async (client) => {
    await client.query(`DELETE FROM expenses WHERE id = $1`, [e.id]);
    await logActivity(client, r.id, user.id, via, `Removed "${e.merchant}" ${inr(e.amount)}`);
    await touch(client, r.id);
  });
  return r.id;
}

export async function renameReport(user, reportId, title, via = 'web') {
  const pre = await loadReportFor(user, reportId);
  if (pre.rel !== 'owner') throw new AppError('Only the owner can rename a report.');
  const r = await loadEditable(user, reportId, via);
  const t = String(title ?? '').trim().slice(0, 140);
  if (!t) throw new AppError('Title is required.', 400);
  await tx(async (client) => {
    await client.query(`UPDATE reports SET title = $2, updated_at = now() WHERE id = $1`, [r.id, t]);
    await logActivity(client, r.id, user.id, via, `Renamed to "${t}"`);
  });
}

export async function submitReport(user, reportId, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.submit) throw new AppError(`Only the owner can submit a draft, rejected or being-revised report (this one is ${r.status}).`);
  const n = (await q(`SELECT COUNT(*)::int AS n FROM expenses WHERE report_id = $1`, [r.id])).rows[0].n;
  if (!n) throw new AppError('Add at least one expense before submitting.', 400);
  await tx(async (client) => {
    await client.query(
      `UPDATE reports SET status='submitted', submitted_at=now(), decided_by=NULL, decided_at=NULL, decision_note=NULL,
              manager_approved_by=NULL, manager_approved_at=NULL, escalated_at=NULL, updated_at=now() WHERE id=$1`,
      [r.id]
    );
    await logActivity(client, r.id, user.id, via, r.status === 'draft' ? 'Submitted for approval' : 'Resubmitted for approval');
  });
}

// Two-level approval: the manager (or their out-of-office delegate) decides first. Reports totalling more than
// LIMITS.financeApproval then go to Finance ('finance_review') for a second approval.
export async function decideReport(user, reportId, decision, note, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.decide) {
    throw new AppError(r.rel === 'owner' ? "You can't approve your own report."
      : r.status === 'revising' ? `${r.owner_name} is revising this report. It can be approved or rejected once they resubmit it.`
      : r.status === 'finance_review' ? 'You have approved this report; it is now waiting for Finance\'s second approval.'
      : r.rel === 'finance' ? `This report is ${r.status}; Finance decides only reports waiting for second approval.`
      : `This report is ${r.status}; only submitted reports can be approved or rejected.`);
  }
  if (!['approve', 'reject'].includes(decision)) throw new AppError('Decision must be "approve" or "reject".', 400);
  const n = note ? String(note).trim().slice(0, 500) : null;
  if (decision === 'reject' && !n) throw new AppError('Please give a reason when rejecting.', 400);
  const onBehalf = r.rel === 'delegate' ? ` (on behalf of ${r.owner_manager_name}, out of office)` : '';
  const total = Number((await q(`SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE report_id = $1`, [r.id])).rows[0].t);
  let status;
  await tx(async (client) => {
    if (decision === 'reject') {
      status = 'rejected';
      await client.query(`UPDATE reports SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3, updated_at=now() WHERE id=$1`, [r.id, user.id, n]);
      await logActivity(client, r.id, user.id, via, `Rejected${r.rel === 'finance' ? ' by Finance' : ''}${onBehalf}: "${n}"`);
    } else if (r.rel !== 'finance' && total > LIMITS.financeApproval) {
      status = 'finance_review';
      await client.query(
        `UPDATE reports SET status='finance_review', manager_approved_by=$2, manager_approved_at=now(), escalated_at=now(), decision_note=$3, updated_at=now() WHERE id=$1`,
        [r.id, user.id, n]
      );
      await logActivity(client, r.id, user.id, via, `Approved by manager${onBehalf}${n ? `: "${n}"` : ''}. Over ${inr(LIMITS.financeApproval)}, so sent to Finance for second approval`);
    } else {
      status = 'approved';
      const managerStep = r.rel === 'finance' ? '' : ', manager_approved_by=$2, manager_approved_at=now()';
      await client.query(`UPDATE reports SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3${managerStep}, updated_at=now() WHERE id=$1`, [r.id, user.id, n]);
      await logActivity(client, r.id, user.id, via, `${r.rel === 'finance' ? 'Approved by Finance (second approval)' : 'Approved'}${onBehalf}${n ? `: "${n}"` : ''}`);
    }
  });
  return status;
}

export async function deleteReport(user, reportId) {
  const r = await loadReportFor(user, reportId);
  if (!r.can.delete) throw new AppError('Only the owner can delete a draft report.');
  await q(`DELETE FROM reports WHERE id = $1`, [r.id]);
}

// ---------- Flags: issues raised on a report (usually by Claude after checking receipts) ----------
export async function addFlag(user, reportId, { kind, expense_id, message }, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.flag) throw new AppError(`This report is ${r.status}; issues can't be flagged on it any more.`);
  if (!FLAG_KINDS[kind]) throw new AppError(`Flag type must be one of: ${Object.keys(FLAG_KINDS).join(', ')}.`, 400);
  const msg = String(message ?? '').trim().slice(0, 500);
  if (!msg) throw new AppError('Describe the issue in a sentence.', 400);
  let expenseId = null;
  if (expense_id !== undefined && expense_id !== null && expense_id !== '') {
    expenseId = Number(expense_id);
    const ok = (await q(`SELECT 1 FROM expenses WHERE id = $1 AND report_id = $2`, [expenseId, r.id])).rows.length;
    if (!ok) throw new AppError(`Expense #${expense_id} is not on this report.`, 400);
  }
  return tx(async (client) => {
    const id = (await client.query(
      `INSERT INTO flags (report_id, expense_id, kind, message, raised_by, via) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [r.id, expenseId, kind, msg, user.id, via]
    )).rows[0].id;
    await logActivity(client, r.id, user.id, via, `Flagged ${FLAG_KINDS[kind]}: ${msg}`);
    return id;
  });
}

export async function resolveFlag(user, flagId, note, via = 'web') {
  const f = (await q(`SELECT * FROM flags WHERE id = $1`, [Number(flagId)])).rows[0];
  if (!f) throw new AppError('Flag not found.', 404);
  const r = await loadReportFor(user, f.report_id);
  if (!r.can.resolve_flag) throw new AppError('Access denied: only the approving manager can resolve flags, while the report is submitted.');
  if (f.resolved_at) throw new AppError('This flag is already resolved.', 400);
  const n = note ? String(note).trim().slice(0, 500) : null;
  await tx(async (client) => {
    await client.query(`UPDATE flags SET resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1`, [f.id, user.id, n]);
    await logActivity(client, r.id, user.id, via, `Resolved flag "${FLAG_KINDS[f.kind] || f.kind}"${n ? `: ${n}` : ''}`);
  });
  return r.id;
}

// ---------- Conversation between the employee and their manager ----------
export async function addComment(user, reportId, body, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.comment) throw new AppError("You can't comment on this report.");
  const text = String(body ?? '').trim().slice(0, 2000);
  if (!text) throw new AppError('Comment is empty.', 400);
  return tx(async (client) => {
    const id = (await client.query(
      `INSERT INTO comments (report_id, author_id, body, via) VALUES ($1,$2,$3,$4) RETURNING id`,
      [r.id, user.id, text, via]
    )).rows[0].id;
    await logActivity(client, r.id, user.id, via, 'Commented');
    await touch(client, r.id);
    return id;
  });
}

// ---------- Payouts: Finance records that an approved claim has been paid ----------
// Deliberate guardrail exception: the payout queue shows payee name, amount and dates (no expense lines),
// because nobody can pay a claim without knowing whom to pay.
export async function payoutQueue(user) {
  if (user.role !== 'finance') throw new AppError('Access denied: only Finance can see the payout queue.');
  const base = `SELECT r.id, r.title, u.name AS payee, u.department, r.decided_at::date AS approved_on, r.paid_on, r.paid_mode, r.paid_ref,
                       COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.report_id = r.id), 0) AS amount,
                       GREATEST(0, (now()::date - r.decided_at::date))::int AS days_since_approval
                  FROM reports r JOIN users u ON u.id = r.owner_id WHERE r.status = 'approved'`;
  const unpaid = (await q(`${base} AND r.paid_on IS NULL ORDER BY r.decided_at`)).rows;
  const paid = (await q(`${base} AND r.paid_on IS NOT NULL ORDER BY r.paid_on DESC, r.id DESC LIMIT 10`)).rows;
  return { unpaid, recently_paid: paid, total_unpaid: Math.round(unpaid.reduce((t, x) => t + x.amount, 0) * 100) / 100 };
}

export async function markPaid(user, reportId, { paid_on, mode, ref }, via = 'web') {
  if (user.role !== 'finance') throw new AppError('Access denied: only Finance can record payouts.');
  const r = (await q(`SELECT r.id, r.status, r.paid_on, r.decided_at::date AS approved_on, u.name AS payee FROM reports r JOIN users u ON u.id = r.owner_id WHERE r.id = $1`, [Number(reportId)])).rows[0];
  if (!r) throw new AppError('Report not found.', 404);
  if (r.status !== 'approved') throw new AppError(`Report #${r.id} is ${r.status}; only fully approved reports can be paid.`, 400);
  if (r.paid_on) throw new AppError(`Report #${r.id} was already paid on ${r.paid_on}.`, 400);
  const today = new Date().toISOString().slice(0, 10);
  const date = String(paid_on || today).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw new AppError('Payment date must be YYYY-MM-DD.', 400);
  if (date > today) throw new AppError('Payment date cannot be in the future.', 400);
  if (r.approved_on && date < r.approved_on) throw new AppError(`Payment date can't be before the approval date (${r.approved_on}).`, 400);
  const m = PAYOUT_MODES.find((x) => x.toLowerCase() === String(mode || '').trim().toLowerCase());
  if (!m) throw new AppError(`Payment mode must be one of: ${PAYOUT_MODES.join(', ')}.`, 400);
  const reference = String(ref ?? '').trim().slice(0, 40);
  if (m !== 'Cash' && !reference) throw new AppError('Add the payment reference (UTR / UPI ref / cheque no.).', 400);
  await tx(async (client) => {
    await client.query(`UPDATE reports SET paid_on=$2, paid_mode=$3, paid_ref=$4, paid_by=$5, paid_recorded_at=now(), updated_at=now() WHERE id=$1`, [r.id, date, m, reference || null, user.id]);
    await logActivity(client, r.id, user.id, via, `Paid via ${m} on ${date}${reference ? ` (ref ${reference})` : ''}`);
  });
  return { report_id: r.id, payee: r.payee, paid_on: date, mode: m, ref: reference || null };
}

// ---------- Out of office: a manager hands approvals to another manager until a date ----------
export async function setDelegate(user, { delegate, until }) {
  if (user.role !== 'manager') throw new AppError('Only managers can set an out-of-office delegate.');
  if (!delegate) {
    await q(`UPDATE users SET delegate_id = NULL, delegate_until = NULL WHERE id = $1`, [user.id]);
    return { delegate: null };
  }
  const d = (await q(
    `SELECT id, name FROM users WHERE role = 'manager' AND id <> $1 AND (lower(name) = lower($2) OR lower(split_part(name, ' ', 1)) = lower($2) OR lower(email) = lower($2) OR id::text = $2)`,
    [user.id, String(delegate).trim()]
  )).rows;
  if (d.length !== 1) throw new AppError('Delegate must be exactly one other manager (name or email).', 400);
  const today = new Date().toISOString().slice(0, 10);
  const end = String(until || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || isNaN(Date.parse(end))) throw new AppError('"until" must be a date (YYYY-MM-DD).', 400);
  if (end < today) throw new AppError('"until" must be today or later.', 400);
  if (end > new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)) throw new AppError('Delegation can last at most 90 days.', 400);
  await q(`UPDATE users SET delegate_id = $2, delegate_until = $3 WHERE id = $1`, [user.id, d[0].id, end]);
  return { delegate: d[0].name, until: end };
}

export async function delegationFor(user) {
  if (user.role !== 'manager') return null;
  const mine = (await q(`SELECT u.delegate_until, d.name AS delegate_name, (u.${ACTIVE_DELEGATION}) AS active FROM users u LEFT JOIN users d ON d.id = u.delegate_id WHERE u.id = $1`, [user.id])).rows[0];
  const covering = (await q(`SELECT name, delegate_until FROM users WHERE delegate_id = $1 AND ${ACTIVE_DELEGATION} ORDER BY name`, [user.id])).rows;
  const managers = (await q(`SELECT id, name FROM users WHERE role = 'manager' AND id <> $1 ORDER BY name`, [user.id])).rows;
  return { out_of_office: mine?.active ? { delegate: mine.delegate_name, until: mine.delegate_until } : null, covering_for: covering, managers };
}

// ---------- "What needs my attention": one role-aware to-do list (web + MCP) ----------
export async function attention(user, { budgetStatus }) {
  const brief = (r) => ({ id: r.id, title: r.title, owner: r.owner_name, status: r.status, total_inr: r.total, days_waiting: r.days_waiting, open_flags: r.open_flags });
  const items = [];
  if (user.role === 'employee') {
    const mine = await listReports(user);
    const add = (label, rows, hint) => rows.length && items.push({ label, count: rows.length, hint, reports: rows.map(brief) });
    add('Drafts not yet submitted', mine.filter((r) => r.status === 'draft'), 'Submit them when ready (submit_report).');
    add('Being revised by you', mine.filter((r) => r.status === 'revising'), 'Resubmit so your manager can approve them.');
    add('Rejected: fix and resubmit', mine.filter((r) => r.status === 'rejected'), 'Read the reason, edit, then resubmit.');
    add('Open flags or questions on your reports', mine.filter((r) => r.open_flags || (r.comments && r.last_commenter && r.last_commenter !== user.name)), 'Reply in the conversation (add_comment).');
    add('Approved, waiting for payment', mine.filter((r) => r.status === 'approved' && !r.paid_on), 'Finance will record the payout.');
    add('Paid recently', mine.filter((r) => r.paid_on).slice(0, 5), null);
  } else if (user.role === 'manager') {
    const team = await listReports(user, { scope: 'team' });
    const delegated = await listReports(user, { scope: 'delegated' });
    const add = (label, rows, hint) => rows.length && items.push({ label, count: rows.length, hint, reports: rows.map(brief) });
    const waiting = team.filter((r) => r.status === 'submitted');
    add('Waiting for your approval', waiting, 'Oldest first; over 3 days counts as overdue.');
    add('Overdue (waiting more than 3 days)', waiting.filter((r) => r.days_waiting > 3), 'Approve, reject or ask a question.');
    add('Delegated to you (manager out of office)', delegated.filter((r) => r.status === 'submitted'), 'You can approve or reject these on their behalf.');
    add('Being revised by the employee', team.filter((r) => r.status === 'revising'), 'Nothing to do until they resubmit.');
    add('Waiting for Finance second approval', team.filter((r) => r.status === 'finance_review'), null);
    const d = await delegationFor(user);
    if (d.out_of_office) items.push({ label: `You are out of office: approvals go to ${d.out_of_office.delegate} until ${d.out_of_office.until}`, count: 1 });
  } else {
    const fin = await listReports(user, { scope: 'finance' });
    const review = fin.filter((r) => r.status === 'finance_review');
    if (review.length) items.push({ label: 'Waiting for your second approval (over the finance threshold)', count: review.length, reports: review.map(brief) });
    const pay = await payoutQueue(user);
    if (pay.unpaid.length) items.push({ label: 'Approved claims to pay', count: pay.unpaid.length, total_inr: pay.total_unpaid, oldest_days: pay.unpaid[0].days_since_approval, reports: pay.unpaid.map((x) => ({ id: x.id, payee: x.payee, amount_inr: x.amount, approved_on: x.approved_on, days_since_approval: x.days_since_approval })) });
  }
  if (user.role !== 'employee') {
    const b = await budgetStatus(user, {});
    const hot = b.rows.filter((x) => x.state === 'near limit' || x.state === 'over');
    if (hot.length) items.push({ label: `Budgets near or over limit (${b.quarter_label})`, count: hot.length, departments: hot.map((x) => ({ department: x.department, pct_used: x.pct_used, state: x.state })) });
  }
  return { for: `${user.name} (${user.role})`, items, all_clear: items.length === 0 };
}
