// Report and expense operations. Every function checks access through access.js first.

import { q, pool, insertExpense, logActivity } from './db.js';
import { AppError, loadReportFor } from './access.js';
import { CATEGORIES, policyFlag } from './policy.js';

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

export async function listReports(user, { scope = 'mine', status } = {}) {
  if (user.role === 'finance') throw new AppError('Finance can see department-level totals only, not individual reports. Use the spend summary instead.');
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (scope === 'team') {
    if (user.role !== 'manager') throw new AppError('Only managers can list team reports.');
    where.push(`u.manager_id = ${p(user.id)}`);
  } else {
    where.push(`r.owner_id = ${p(user.id)}`);
  }
  if (status) where.push(`r.status = ${p(status)}`);
  const { rows } = await q(
    `SELECT r.id, r.title, r.status, r.created_via, r.created_at, r.submitted_at,
            u.name AS owner_name, u.department,
            COALESCE(SUM(e.amount), 0) AS total, COUNT(e.id)::int AS items, COUNT(e.policy_flag)::int AS flags
       FROM reports r
       JOIN users u ON u.id = r.owner_id
       LEFT JOIN expenses e ON e.report_id = r.id
      WHERE ${where.join(' AND ')}
      GROUP BY r.id, u.name, u.department
      ORDER BY (r.status = 'submitted') DESC, r.created_at DESC`,
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

export async function addExpenses(user, reportId, expenses, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.edit) throw new AppError(`This report is ${r.status} and can't be edited by you right now.`);
  const items = expenses.map(validateExpense);
  return tx(async (client) => {
    const ids = [];
    for (const e of items) ids.push(await insertExpense(client, r.id, e));
    await logActivity(client, r.id, user.id, via, `Added ${items.length} expense${items.length === 1 ? '' : 's'}: ${items.map((e) => `${e.merchant} ${inr(e.amount)}`).join(', ')}`);
    await touch(client, r.id);
    return ids;
  });
}

async function loadExpense(user, expenseId) {
  const e = (await q(`SELECT * FROM expenses WHERE id = $1`, [Number(expenseId)])).rows[0];
  if (!e) throw new AppError('Expense not found.', 404);
  const r = await loadReportFor(user, e.report_id);
  if (!r.can.edit) throw new AppError(`This report is ${r.status} and can't be edited by you right now.`);
  return { e, r };
}

export async function updateExpense(user, expenseId, fields, via = 'web') {
  const { e, r } = await loadExpense(user, expenseId);
  const merged = validateExpense({ ...e, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
  const changes = ['spent_on', 'merchant', 'category', 'amount', 'gst', 'notes']
    .filter((k) => String(merged[k] ?? '') !== String(e[k] ?? ''))
    .map((k) => `${k}: ${k === 'amount' || k === 'gst' ? inr(e[k]) : e[k] ?? '—'} → ${k === 'amount' || k === 'gst' ? inr(merged[k]) : merged[k] ?? '—'}`);
  if (!changes.length) return e.id;
  return tx(async (client) => {
    await client.query(
      `UPDATE expenses SET spent_on=$2, merchant=$3, category=$4, amount=$5, gst=$6, notes=$7, policy_flag=$8 WHERE id=$1`,
      [e.id, merged.spent_on, merged.merchant, merged.category, merged.amount, merged.gst, merged.notes, policyFlag(merged)]
    );
    await logActivity(client, r.id, user.id, via, `Edited "${e.merchant}" (${changes.join('; ')})`);
    await touch(client, r.id);
    return e.id;
  });
}

export async function deleteExpense(user, expenseId, via = 'web') {
  const { e, r } = await loadExpense(user, expenseId);
  return tx(async (client) => {
    await client.query(`DELETE FROM expenses WHERE id = $1`, [e.id]);
    await logActivity(client, r.id, user.id, via, `Removed "${e.merchant}" ${inr(e.amount)}`);
    await touch(client, r.id);
  });
}

export async function renameReport(user, reportId, title, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (r.rel !== 'owner' || !r.can.edit) throw new AppError('Only the owner can rename a draft or rejected report.');
  const t = String(title ?? '').trim().slice(0, 140);
  if (!t) throw new AppError('Title is required.', 400);
  await tx(async (client) => {
    await client.query(`UPDATE reports SET title = $2, updated_at = now() WHERE id = $1`, [r.id, t]);
    await logActivity(client, r.id, user.id, via, `Renamed to "${t}"`);
  });
}

export async function submitReport(user, reportId, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.submit) throw new AppError(`Only the owner can submit a draft or rejected report (this one is ${r.status}).`);
  const n = (await q(`SELECT COUNT(*)::int AS n FROM expenses WHERE report_id = $1`, [r.id])).rows[0].n;
  if (!n) throw new AppError('Add at least one expense before submitting.', 400);
  await tx(async (client) => {
    await client.query(
      `UPDATE reports SET status='submitted', submitted_at=now(), decided_by=NULL, decided_at=NULL, decision_note=NULL, updated_at=now() WHERE id=$1`,
      [r.id]
    );
    await logActivity(client, r.id, user.id, via, 'Submitted for approval');
  });
}

export async function decideReport(user, reportId, decision, note, via = 'web') {
  const r = await loadReportFor(user, reportId);
  if (!r.can.decide) {
    throw new AppError(r.rel === 'owner' ? "You can't approve your own report." : `This report is ${r.status}; only submitted reports can be approved or rejected.`);
  }
  if (!['approve', 'reject'].includes(decision)) throw new AppError('Decision must be "approve" or "reject".', 400);
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const n = note ? String(note).trim().slice(0, 500) : null;
  if (status === 'rejected' && !n) throw new AppError('Please give a reason when rejecting.', 400);
  await tx(async (client) => {
    await client.query(
      `UPDATE reports SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, updated_at=now() WHERE id=$1`,
      [r.id, status, user.id, n]
    );
    await logActivity(client, r.id, user.id, via, `${status === 'approved' ? 'Approved' : 'Rejected'}${n ? `: "${n}"` : ''}`);
  });
  return status;
}

export async function deleteReport(user, reportId) {
  const r = await loadReportFor(user, reportId);
  if (!r.can.delete) throw new AppError('Only the owner can delete a draft report.');
  await q(`DELETE FROM reports WHERE id = $1`, [r.id]);
}
