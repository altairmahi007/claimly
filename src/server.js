import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initDb, q } from './db.js';
import { makeSession, newToken, parseCookies, readSession, verifyPassword } from './auth.js';
import { AppError, getTeam, getUserByEmail, getUserById, getUserByToken, spendSummary } from './access.js';
import {
  addComment, addExpenses, addFlag, createReport, decideReport, deleteExpense, deleteReport, getReport, listReports, renameReport, resolveFlag,
  startRevision, submitReport, updateExpense,
} from './repo.js';
import { buildMcpServer } from './mcp.js';
import * as V from './views.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const baseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- MCP endpoint (one link per user; the token identifies who is calling) ----------
app.post('/mcp/:token', h(async (req, res) => {
  const user = await getUserByToken(req.params.token);
  if (!user) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked Claimly MCP link. Copy a fresh link from the Connect page.' }, id: null });
  }
  const server = buildMcpServer(user, baseUrl(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}));
const mcpNotAllowed = (req, res) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp/:token', mcpNotAllowed);
app.delete('/mcp/:token', mcpNotAllowed);

// ---------- Web session ----------
app.use(h(async (req, res, next) => {
  const id = readSession(parseCookies(req.headers.cookie).sid);
  req.user = id ? await getUserById(id) : null;
  next();
}));
const setCookie = (req, res, value, maxAge) =>
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const back = (res, path, msg) => res.redirect(`${path}${msg ? `${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : ''}`);

const CAN = {
  employee: 'Own reports and own spend',
  manager: 'Direct reportees only: approve, by department and by person',
  finance: 'Department totals only, no individuals',
};
async function demoAccounts() {
  const { rows } = await q(`SELECT name, email, role, title FROM users ORDER BY CASE role WHEN 'employee' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, id`);
  return rows.map((r) => ({ ...r, can: CAN[r.role] }));
}

app.get('/login', h(async (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(V.loginPage({ accounts: await demoAccounts() }));
}));
app.post('/login', h(async (req, res) => {
  const u = await getUserByEmail(String(req.body.email || '').trim());
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    return res.status(401).send(V.loginPage({ error: 'Wrong email or password.', accounts: await demoAccounts() }));
  }
  setCookie(req, res, makeSession(u.id), 7 * 24 * 3600);
  res.redirect('/');
}));
app.post('/logout', (req, res) => {
  setCookie(req, res, '', 0);
  res.redirect('/login');
});

// ---------- Dashboard (different view per role, same guardrails as MCP) ----------
function periodRange(p) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (p === 'this_month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
  if (p === 'last_month') return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  if (p === 'last_90') return { from: iso(new Date(Date.now() - 90 * 864e5)), to: iso(now) };
  return {};
}

app.get('/', requireLogin, h(async (req, res) => {
  const user = req.user;
  const period = ['this_month', 'last_month', 'last_90'].includes(req.query.period) ? req.query.period : 'all';
  const range = periodRange(period);
  const flash = req.query.msg;
  if (user.role === 'employee') {
    const [reports, byCategory] = await Promise.all([listReports(user), spendSummary(user, { group_by: 'category', ...range })]);
    return res.send(V.employeeDashboard({ user, reports, byCategory, period, flash }));
  }
  if (user.role === 'manager') {
    const [team, all, byDept, byPerson] = await Promise.all([
      getTeam(user.id),
      listReports(user, { scope: 'team' }),
      spendSummary(user, { group_by: 'department', ...range }),
      spendSummary(user, { group_by: 'person', ...range }),
    ]);
    const pending = all.filter((r) => ['submitted', 'revising'].includes(r.status));
    return res.send(V.managerDashboard({ user, team, pending, all, byDept, byPerson, period, flash }));
  }
  const [byDept, byCategory, byMonth] = await Promise.all([
    spendSummary(user, { group_by: 'department', ...range }),
    spendSummary(user, { group_by: 'category', ...range }),
    spendSummary(user, { group_by: 'month', ...range }),
  ]);
  res.send(V.financeDashboard({ user, byDept, byCategory, byMonth, period, flash }));
}));

// ---------- Reports ----------
app.get('/reports/new', requireLogin, (req, res) => res.send(V.newReportPage({ user: req.user })));
app.post('/reports', requireLogin, h(async (req, res) => {
  const id = await createReport(req.user, { title: req.body.title, expenses: [], via: 'web' });
  back(res, `/reports/${id}?edit=1`, 'Draft created. Add your expense lines below.');
}));
app.get('/reports/:id', requireLogin, h(async (req, res) => {
  const r = await getReport(req.user, req.params.id);
  res.send(V.reportPage({ user: req.user, r, flash: req.query.msg, editMode: req.query.edit === '1' && r.can.edit }));
}));
app.post('/reports/:id/expenses', requireLogin, h(async (req, res) => {
  await addExpenses(req.user, req.params.id, [req.body], 'web');
  back(res, `/reports/${req.params.id}?edit=1`, 'Line added.');
}));
// "Edit" on a submitted report reopens it (status 'revising') so it can't be approved mid-edit.
app.post('/reports/:id/edit', requireLogin, h(async (req, res) => {
  await startRevision(req.user, req.params.id, 'web');
  back(res, `/reports/${req.params.id}?edit=1`, 'Editing. Your manager can see the report but can\'t approve it until you resubmit.');
}));
app.post('/reports/:id/rename', requireLogin, h(async (req, res) => {
  await renameReport(req.user, req.params.id, req.body.title, 'web');
  back(res, `/reports/${req.params.id}?edit=1`, 'Renamed.');
}));
app.post('/reports/:id/submit', requireLogin, h(async (req, res) => {
  await submitReport(req.user, req.params.id, 'web');
  back(res, `/reports/${req.params.id}`, 'Submitted to your manager.');
}));
app.post('/reports/:id/decide', requireLogin, h(async (req, res) => {
  const status = await decideReport(req.user, req.params.id, req.body.decision, req.body.note, 'web');
  back(res, `/reports/${req.params.id}`, `Report ${status}.`);
}));
app.post('/reports/:id/delete', requireLogin, h(async (req, res) => {
  await deleteReport(req.user, req.params.id);
  back(res, '/', 'Draft deleted.');
}));
app.post('/reports/:id/comments', requireLogin, h(async (req, res) => {
  await addComment(req.user, req.params.id, req.body.body, 'web');
  back(res, `/reports/${req.params.id}#conversation`, '');
}));
app.post('/reports/:id/flags', requireLogin, h(async (req, res) => {
  await addFlag(req.user, req.params.id, { kind: req.body.kind, expense_id: req.body.expense_id, message: req.body.message }, 'web');
  back(res, `/reports/${req.params.id}`, 'Issue flagged.');
}));
app.post('/flags/:id/resolve', requireLogin, h(async (req, res) => {
  const reportId = await resolveFlag(req.user, req.params.id, req.body.note, 'web');
  back(res, `/reports/${reportId}`, 'Flag resolved.');
}));
app.get('/reports/:id/export.csv', requireLogin, h(async (req, res) => {
  const r = await getReport(req.user, req.params.id);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Report', 'Employee', 'Department', 'Status', 'Date', 'Merchant', 'Category', 'Amount (INR)', 'GST (INR)', 'Notes', 'Policy flag']]
    .concat(r.expenses.map((e) => [r.title, r.owner_name, r.owner_department, r.status, e.spent_on, e.merchant, e.category, e.amount, e.gst, e.notes, e.policy_flag]))
    .map((row) => row.map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claimly-report-${r.id}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

app.post('/expenses/:id', requireLogin, h(async (req, res) => {
  const e = (await q('SELECT report_id FROM expenses WHERE id=$1', [Number(req.params.id)])).rows[0];
  await updateExpense(req.user, req.params.id, req.body, 'web');
  back(res, `/reports/${e ? e.report_id : ''}?edit=1`, 'Line saved.');
}));
app.post('/expenses/:id/delete', requireLogin, h(async (req, res) => {
  const e = (await q('SELECT report_id FROM expenses WHERE id=$1', [Number(req.params.id)])).rows[0];
  await deleteExpense(req.user, req.params.id, 'web');
  back(res, `/reports/${e ? e.report_id : ''}?edit=1`, 'Line removed.');
}));

// ---------- Connect Claude ----------
app.get('/connect', requireLogin, (req, res) =>
  res.send(V.connectPage({ user: req.user, mcpUrl: `${baseUrl(req)}/mcp/${req.user.mcp_token}`, flash: req.query.msg })));
app.post('/connect/rotate', requireLogin, h(async (req, res) => {
  await q('UPDATE users SET mcp_token=$2 WHERE id=$1', [req.user.id, newToken()]);
  back(res, '/connect', 'New link created. Update it in Claude; the old one no longer works.');
}));

// ---------- Errors ----------
app.use((req, res) => res.status(404).send(V.errorPage({ user: req.user, message: 'Page not found.', status: 404 })));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) return res.status(err.status).send(V.errorPage({ user: req.user, message: err.message, status: err.status }));
  console.error(err);
  res.status(500).send(V.errorPage({ user: req.user, message: 'Something went wrong. Please try again.', status: 500 }));
});

await initDb();
app.listen(PORT, () => console.log(`Claimly running on port ${PORT}`));
