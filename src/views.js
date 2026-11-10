import { CATEGORIES, FLAG_KINDS, LIMITS } from './policy.js';
import { recentQuarters } from './access.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const ROLE = { employee: 'Employee', manager: 'Manager', finance: 'Finance' };
const STATUS_LABEL = { revising: 'Being revised' };
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const viaBadge = (v) => (v === 'claude' ? '<span class="badge b-claude">via Claude</span>' : '');

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:#f6f7fb;color:#1c2333}
a{color:#3b4cca;text-decoration:none}a:hover{text-decoration:underline}
header{background:#fff;border-bottom:1px solid #e6e8f0;position:sticky;top:0;z-index:5}
.bar{max-width:1120px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:20px}
.logo{font-weight:800;font-size:19px;color:#1c2333;letter-spacing:-.3px}.logo span{color:#3b4cca}
nav{display:flex;gap:16px;flex:1}nav a{color:#556}
.me{font-size:13px;color:#667;text-align:right}.me b{color:#1c2333}
main{max-width:1120px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.3px}h2{font-size:17px;margin:0 0 12px}
.sub{color:#667;margin:0 0 20px}
.card{background:#fff;border:1px solid #e6e8f0;border-radius:12px;padding:18px 20px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid #e6e8f0;border-radius:12px;padding:14px 16px}.kpi .l{font-size:12px;color:#778;text-transform:uppercase;letter-spacing:.4px}.kpi .v{font-size:22px;font-weight:700;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#778;font-weight:600;padding:8px;border-bottom:1px solid #e6e8f0}
td{padding:8px;border-bottom:1px solid #f0f1f6;vertical-align:middle}tfoot td{font-weight:700;border-top:2px solid #e6e8f0;border-bottom:0}
td.n,th.n{text-align:right;white-space:nowrap}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;text-transform:capitalize;background:#eef0f6;color:#556}
.b-submitted{background:#fff4d6;color:#8a5a00}.b-approved{background:#dcf5e6;color:#11683a}.b-rejected{background:#fde2e2;color:#a11d1d}.b-draft{background:#eef0f6;color:#556}.b-revising{background:#e6f1ff;color:#1d4f91;text-transform:none}
.b-claude{background:#efe7ff;color:#5b2fc9;text-transform:none}
.flag{display:inline-block;font-size:12px;color:#a14d00;background:#fff1e0;border-radius:6px;padding:1px 7px}
.btn{display:inline-block;border:1px solid #d6d9e6;background:#fff;color:#1c2333;border-radius:8px;padding:7px 14px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
.btn:hover{background:#f3f4f9;text-decoration:none}.btn.p{background:#3b4cca;border-color:#3b4cca;color:#fff}.btn.p:hover{background:#2f3eb0}
.btn.g{background:#11804a;border-color:#11804a;color:#fff}.btn.r{color:#a11d1d;border-color:#f1c4c4}.btn.sm{padding:4px 10px;font-size:13px}
input,select,textarea{font:inherit;font-size:14px;border:1px solid #d6d9e6;border-radius:8px;padding:6px 8px;background:#fff;width:100%}
td input,td select{padding:4px 6px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.spacer{flex:1}
.alert{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px}.alert.err{background:#fde2e2;color:#8a1515}.alert.ok{background:#dcf5e6;color:#11683a}
.guard{background:#f0f2ff;border:1px solid #d8ddff;color:#2c3a9e;border-radius:10px;padding:10px 14px;font-size:14px;margin-bottom:18px}
.muted{color:#778;font-size:13px}code,.code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f4f9;border:1px solid #e6e8f0;border-radius:6px;padding:2px 6px;word-break:break-all}
.kpi.toggle{display:block;color:inherit;text-decoration:none;cursor:pointer;border-width:2px}.kpi.toggle.on{border-color:#3b4cca}.kpi.toggle.off{opacity:.55;border-style:dashed}.kpi.toggle:hover{text-decoration:none;background:#f8f9ff}
.tabs a{padding:5px 12px;border-radius:99px;color:#556;font-size:13px}.tabs a.on{background:#1c2333;color:#fff}
.login{max-width:900px;margin:40px auto;display:grid;grid-template-columns:1fr 1.2fr;gap:24px}
@media(max-width:760px){.login{grid-template-columns:1fr}nav{display:none}}
ol li{margin-bottom:6px}.log li{margin-bottom:6px;font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:4px}.chip{font-size:12px;border-radius:6px;padding:1px 7px;background:#eef0f6;color:#445;white-space:nowrap}
.chip.warn{background:#fff1e0;color:#a14d00}.chip.ai{background:#efe7ff;color:#5b2fc9}.chip.talk{background:#e6f1ff;color:#1d4f91}
.issue{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f0f1f6}.issue:last-child{border-bottom:0}.issue .body{flex:1}
.issue.done{opacity:.6}.issue .k{font-weight:700}
.msg{padding:10px 12px;border-radius:10px;margin-bottom:10px;background:#f6f7fb;border:1px solid #e6e8f0}.msg.mgr{background:#f0f2ff;border-color:#d8ddff}
.msg .who{font-size:13px;margin-bottom:4px}.msg .text{white-space:pre-wrap}
textarea{min-height:70px;resize:vertical}
`;

export function layout({ title, user, body, flash, error }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Claimly</title><style>${CSS}</style></head><body>
<header><div class="bar"><a class="logo" href="/">Claim<span>ly</span></a>
${user ? `<nav><a href="/">Dashboard</a>${user.role === 'employee' ? '<a href="/reports/new">New report</a>' : ''}<a href="/connect">Connect Claude</a></nav>
<div class="me"><b>${esc(user.name)}</b><br>${ROLE[user.role]} · ${esc(user.department)}</div>
<form method="post" action="/logout"><button class="btn sm">Log out</button></form>` : '<nav></nav>'}
</div></header><main>
${error ? `<div class="alert err">${esc(error)}</div>` : ''}${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
${body}</main></body></html>`;
}

export function loginPage({ error, accounts }) {
  const rows = accounts
    .map((a) => `<tr><td><b>${esc(a.name)}</b><div class="muted">${esc(a.title)}</div></td><td><code>${esc(a.email)}</code></td><td>${esc(a.can)}</td></tr>`)
    .join('');
  return layout({
    title: 'Log in',
    error,
    body: `<div class="login">
<div class="card"><h1>Log in</h1><p class="sub">Expense claims that Claude files for you.</p>
<form method="post" action="/login"><p><label>Email<br><input name="email" type="email" required autofocus></label></p>
<p><label>Password<br><input name="password" type="password" required></label></p><button class="btn p">Log in</button></form>
<p class="muted" style="margin-top:18px">No AI runs inside Claimly. Your own Claude reads receipts and calls Claimly through MCP. Claimly stores, checks policy, routes approvals and reports.</p></div>
<div class="card"><h2>Demo company accounts</h2><p class="muted">Password for all: <code>demo1234</code></p>
<table><thead><tr><th>Person</th><th>Login</th><th>Can see</th></tr></thead><tbody>${rows}</tbody></table></div></div>`,
  });
}

// Spend table. Shows only the status columns that are switched on (the Approved / Pending boxes).
export function summaryTable(sum, label, { gst = false } = {}) {
  const on = (k) => (sum.statuses || ['approved', 'pending']).includes(k);
  if (!sum.rows.length) return `<p class="muted">No ${on('approved') && on('pending') ? 'submitted or approved' : on('approved') ? 'approved' : 'pending'} spend for this period.</p>`;
  const cols = [on('approved') && ['Approved', 'approved'], on('pending') && ['Pending', 'pending'], ['Total', 'total'], gst && ['GST credit', 'gst_approved']].filter(Boolean);
  return `<table><thead><tr><th>${esc(label)}</th>${cols.map(([l]) => `<th class="n">${l}</th>`).join('')}</tr></thead><tbody>
${sum.rows.map((r) => `<tr><td>${esc(r.group)}</td>${cols.map(([, k]) => `<td class="n">${k === 'total' ? `<b>${inr(r[k])}</b>` : inr(r[k])}</td>`).join('')}</tr>`).join('')}
</tbody><tfoot><tr><td>Total</td>${cols.map(([, k]) => `<td class="n">${inr(sum.totals[k])}</td>`).join('')}</tr></tfoot></table>`;
}

// Chips that tell a reviewer, at a glance, what needs attention on a report.
export function reviewChips(r) {
  const chips = [];
  if (r.flags) chips.push(`<span class="chip warn" title="Lines over company policy limits (checked by the app)">⚠ ${r.flags} policy</span>`);
  for (const k of r.flag_kinds || []) chips.push(`<span class="chip ai" title="Raised during review, e.g. by Claude">🔎 ${esc(FLAG_KINDS[k] || k)}</span>`);
  if (r.comments) chips.push(`<span class="chip talk" title="Last message from ${esc(r.last_commenter || '')}">💬 ${r.comments} · last: ${esc((r.last_commenter || '').split(' ')[0])}</span>`);
  return chips.length ? `<div class="chips">${chips.join('')}</div>` : '<span class="muted">—</span>';
}

export function reportsTable(rows, { showOwner = false, empty = 'No reports yet.' } = {}) {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr><th>Report</th>${showOwner ? '<th>Employee</th>' : ''}<th>Status</th><th>Needs attention</th><th class="n">Items</th><th class="n">Total</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="/reports/${r.id}"><b>${esc(r.title)}</b></a> ${viaBadge(r.created_via)}</td>
${showOwner ? `<td>${esc(r.owner_name)}<div class="muted">${esc(r.department)}</div></td>` : ''}<td>${badge(r.status)}</td><td>${reviewChips(r)}</td><td class="n">${r.items}</td><td class="n">${inr(r.total)}</td></tr>`).join('')}
</tbody></table>`;
}

const PERIODS = [['all', 'All time'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_90', 'Last 90 days']];
const qs = ({ period, show, bq }) => {
  const parts = [];
  if (period && period !== 'all') parts.push(`period=${period}`);
  if (show && show.length === 1) parts.push(`show=${show[0]}`);
  if (bq) parts.push(`bq=${bq}`);
  return parts.length ? `/?${parts.join('&')}` : '/';
};
export const periodTabs = (current, show) =>
  `<div class="tabs row">${PERIODS.map(([k, l]) => `<a class="${k === current ? 'on' : ''}" href="${qs({ period: k, show })}">${l}</a>`).join('')}</div>`;

const kpis = (items) => `<div class="kpis">${items.map(([l, v]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div></div>`).join('')}</div>`;

// Approved / Pending boxes double as filters for every table and list on the dashboard.
// Clicking toggles that status; at least one always stays on.
function statusToggles({ totals, show, period }) {
  const box = (key, label, value) => {
    const on = show.includes(key);
    const next = on ? show.filter((k) => k !== key) : [...show, key];
    const body = `<div class="l">${on ? '☑' : '☐'} ${label}</div><div class="v">${inr(value)}</div><div class="muted" style="font-size:12px">${on ? (next.length ? 'Shown · click to hide' : 'Shown') : 'Hidden · click to show'}</div>`;
    return next.length
      ? `<a class="kpi toggle ${on ? 'on' : 'off'}" href="${qs({ period, show: next })}" title="${on ? 'Hide' : 'Show'} ${label.toLowerCase()} spend">${body}</a>`
      : `<div class="kpi toggle on" title="At least one status stays selected">${body}</div>`;
  };
  return box('approved', 'Approved', totals.totals.approved) + box('pending', 'Pending approval', totals.totals.pending);
}
const filterNote = (show) => (show.length === 1
  ? `<div class="alert ok" style="background:#eef0f6;color:#334">Showing <b>${show[0] === 'approved' ? 'approved' : 'pending'}</b> only. <a href="/">Show both</a></div>` : '');

// Budget grading on approved + pending: the % and status follow the grade; the whole row turns amber at 80% and red over 100%.
const BAR_APPROVED = '#3b4cca';
const BAR_PENDING = 'repeating-linear-gradient(45deg,#a9b3f0 0 6px,#c8cff7 6px 12px)';
const BUDGET_GRADE = {
  ok: { bar: '#11804a', chip: 'background:#dcf5e6;color:#11683a', label: 'On track', row: '' },
  watch: { bar: '#d4a106', chip: 'background:#fff7cc;color:#7a5d00', label: 'Watch', row: '' },
  'near limit': { bar: '#e08a00', chip: 'background:#ffe3b8;color:#8a4b00', label: 'Near limit', row: 'background:#fff4e2' },
  over: { bar: '#c62828', chip: 'background:#fbd0d0;color:#9a1515', label: 'Over budget', row: 'background:#fde8e8' },
};
// Card title with a quarter dropdown (Indian FY quarters), keeping the other dashboard filters.
function budgetHeader(title, b, { period, show }) {
  const quarters = recentQuarters(6);
  if (!quarters.some((x) => x.key === b.quarter)) quarters.push({ key: b.quarter, label: b.quarter_label });
  const cur = quarters[0].key;
  const opts = quarters.map((x) => `<option value="${esc(qs({ period, show, bq: x.key === cur ? undefined : x.key }))}"${x.key === b.quarter ? ' selected' : ''}>${esc(x.label)}${x.key === cur ? ' · current' : ''}</option>`).join('');
  return `<div class="row"><h2 style="margin:0">${esc(title)}</h2><div class="spacer"></div>
<label class="muted" style="font-size:13px">Quarter <select onchange="location.href=this.value" style="width:auto;margin-left:6px">${opts}</select></label></div><div style="height:10px"></div>`;
}

function budgetTable(b, { editable = false } = {}) {
  // (month navigation is rendered by budgetHeader)
  if (!b.rows.length) return '<p class="muted">No departments yet.</p>';
  // Stacked bar: approved (solid) + pending (light, striped). The threshold uses their sum.
  // When spend passes the budget, the bar is scaled to the spend and a line marks the budget.
  const usedCell = (r) => {
    if (r.budget == null) return `<td class="n">${inr(r.used)}<div class="muted">no budget set</div></td>`;
    const g = BUDGET_GRADE[r.state];
    const scale = Math.max(r.budget, r.used) || 1;
    const w = (v) => `${Math.max(0, (v / scale) * 100).toFixed(2)}%`;
    return `<td style="min-width:240px"><div class="row" style="justify-content:space-between;gap:6px;font-size:14px">
<span><b>${inr(r.used)}</b> <span class="muted">of ${inr(r.budget)}</span></span><b style="color:${g.bar}">${r.pct_used}%</b></div>
<div style="position:relative;background:#e8eaf2;border-radius:99px;height:10px;margin-top:5px;overflow:hidden;display:flex">
<div title="Approved ${inr(r.approved)}" style="width:${w(r.approved)};background:${BAR_APPROVED};height:10px"></div>
<div title="Pending ${inr(r.pending)}" style="width:${w(r.pending)};background:${BAR_PENDING};height:10px"></div>
<div title="80% of budget" style="position:absolute;left:${w(r.budget * 0.8)};top:0;bottom:0;width:1px;background:#00000040"></div>
${r.used > r.budget ? `<div title="Budget" style="position:absolute;left:${w(r.budget)};top:-2px;bottom:-2px;width:2px;background:#9a1515"></div>` : ''}</div>
<div class="muted" style="font-size:12px;margin-top:3px"><span style="color:${BAR_APPROVED}">■</span> ${inr(r.approved)} approved · <span style="color:#7d8ad8">■</span> ${inr(r.pending)} pending</div></td>`;
  };
  const statusCell = (r) => (r.budget == null ? '<span class="muted">No budget</span>' : `<span class="chip" style="${BUDGET_GRADE[r.state].chip}">${BUDGET_GRADE[r.state].label}</span>`);
  return `<table><thead><tr><th>Department</th><th class="n">Budget / quarter</th><th>Spent vs budget</th><th class="n">Left</th><th>Status</th></tr></thead><tbody>
${b.rows.map((r) => `<tr style="${r.budget == null ? '' : BUDGET_GRADE[r.state].row}"><td><b>${esc(r.department)}</b></td>
<td class="n">${editable ? `<form method="post" action="/budgets" class="row" style="justify-content:flex-end;gap:6px"><input type="hidden" name="department" value="${esc(r.department)}">
<input name="amount" type="number" min="0" step="1000" value="${r.budget ?? ''}" placeholder="Set" style="width:120px"><button class="btn sm">Save</button></form>` : r.budget == null ? '—' : inr(r.budget)}</td>
${usedCell(r)}<td class="n">${r.remaining == null ? '—' : r.remaining < 0 ? `<b style="color:#9a1515">−${inr(-r.remaining)}</b>` : inr(r.remaining)}</td><td>${statusCell(r)}</td></tr>`).join('')}
</tbody></table><p class="muted">Spend dated in ${esc(b.quarter_label)}, ${b.statuses.length === 2 ? 'approved + pending (the threshold uses both)' : b.statuses[0] + ' only'}. Bar: dark = approved, striped = pending; thin line = 80%.<br>
<span class="chip" style="${BUDGET_GRADE.ok.chip}">under 60%</span> <span class="chip" style="${BUDGET_GRADE.watch.chip}">60–79%</span>
<span class="chip" style="${BUDGET_GRADE['near limit'].chip}">80–100%: row turns amber</span> <span class="chip" style="${BUDGET_GRADE.over.chip}">over 100%: row turns red</span></p>`;
}

function complianceTable(c) {
  if (!c.rows.length) return '<p class="muted">Nothing to report for this period.</p>';
  return `<table><thead><tr><th>Department</th><th class="n">Reports</th><th class="n">Policy breaches</th><th class="n">Breach value</th><th class="n">Review flags</th></tr></thead><tbody>
${c.rows.map((r) => `<tr><td><b>${esc(r.department)}</b></td><td class="n">${r.reports}</td>
<td class="n">${r.policy_breaches ? `<span class="chip warn">⚠ ${r.policy_breaches} of ${r.lines} lines (${r.pct_lines_breaching}%)</span>` : `0 of ${r.lines}`}</td>
<td class="n">${inr(r.policy_breach_value)}</td>
<td class="n">${r.review_flags ? `<span class="chip ai">🔎 ${r.open_review_flags} open / ${r.review_flags}</span>` : '0'}</td></tr>`).join('')}
</tbody></table><p class="muted">Policy breaches are checked by the app (meal, hotel and pre-approval limits, future dates). Review flags are raised during review, often by Claude.</p>`;
}

export function employeeDashboard({ user, reports, byCategory, totals, period, show, flash, error }) {
  return layout({
    title: 'Dashboard', user, flash, error,
    body: `<div class="row"><div><h1>My expenses</h1><p class="sub">Ask Claude to file your receipts, or add a report by hand.</p></div><div class="spacer"></div>
<a class="btn p" href="/reports/new">+ New report</a></div>
<div class="kpis">${statusToggles({ totals, show, period })}<div class="kpi"><div class="l">Reports shown</div><div class="v">${reports.length}</div></div></div>
${filterNote(show)}
<div class="grid"><div class="card"><h2>My reports</h2>${reportsTable(reports, { empty: show.length === 2 ? 'No reports yet. Try asking Claude to "file my expenses".' : 'No reports with this status.' })}</div>
<div class="card"><div class="row"><h2>My spend by category</h2><div class="spacer"></div>${periodTabs(period, show)}</div>${summaryTable(byCategory, 'Category')}</div></div>`,
  });
}

export function managerDashboard({ user, team, pending, all, byDept, byPerson, totals, budgets, compliance, period, show, flash, error }) {
  const depts = [...new Set(team.map((t) => t.department))];
  return layout({
    title: 'Team dashboard', user, flash, error,
    body: `<h1>Team spend</h1><p class="sub">${esc(user.title || '')}</p>
<div class="guard">🔒 You see only your direct reportees: <b>${esc(team.map((t) => `${t.name} (${t.department})`).join(', ') || 'none')}</b>, and only reports they have submitted (drafts stay private). Other departments are hidden.</div>
<div class="kpis"><div class="kpi"><div class="l">Waiting for you</div><div class="v">${pending.filter((r) => r.status === 'submitted').length}</div></div>${statusToggles({ totals, show, period })}<div class="kpi"><div class="l">Departments</div><div class="v">${esc(depts.join(', '))}</div></div></div>
${filterNote(show)}
${show.includes('pending') ? `<div class="card"><h2>Waiting for your approval</h2><p class="muted">Reports marked <b>Being revised</b> were reopened by the employee: you can read them, but approval waits until they resubmit.<br>⚠ policy = over a company limit (checked by the app) · 🔎 = issue flagged in review, e.g. by Claude · 💬 = conversation on the report</p>${reportsTable(pending, { showOwner: true, empty: 'Nothing waiting. 🎉' })}</div>` : ''}
<div class="card">${budgetHeader('Budget', budgets, { period, show })}${budgetTable(budgets)}</div>
<div class="row" style="margin-bottom:10px"><h2 style="margin:0">Spend</h2><div class="spacer"></div>${periodTabs(period, show)}</div>
<div class="grid"><div class="card"><h2>By department</h2>${summaryTable(byDept, 'Department')}</div>
<div class="card"><h2>By reportee</h2>${summaryTable(byPerson, 'Person')}</div></div>
<div class="card"><h2>Policy compliance</h2>${complianceTable(compliance)}</div>
<div class="card"><h2>${show.length === 2 ? 'All team reports' : show[0] === 'approved' ? 'Approved team reports' : 'Pending team reports'}</h2>${reportsTable(all, { showOwner: true, empty: 'No reports with this status.' })}</div>`,
  });
}

export function financeDashboard({ user, byDept, byManager, byCategory, byMonth, totals, budgets, compliance, period, show, flash, error }) {
  return layout({
    title: 'Finance', user, flash, error,
    body: `<h1>Company spend</h1><p class="sub">Department-level view for Finance.</p>
<div class="guard">🔒 Finance sees department totals only. Individual employees and their reports are hidden by design.</div>
<div class="kpis">${statusToggles({ totals, show, period })}<div class="kpi"><div class="l">GST input credit</div><div class="v">${inr(totals.totals.gst_approved)}</div><div class="muted" style="font-size:12px">on approved spend</div></div><div class="kpi"><div class="l">Departments</div><div class="v">${byDept.rows.length}</div></div></div>
${filterNote(show)}
<div class="card">${budgetHeader('Department budgets', budgets, { period, show })}${budgetTable(budgets, { editable: true })}</div>
<div class="row" style="margin-bottom:10px"><div class="spacer"></div>${periodTabs(period, show)}</div>
<div class="grid"><div class="card"><h2>By department</h2>${summaryTable(byDept, 'Department')}</div>
<div class="card"><h2>By approving manager</h2>${summaryTable(byManager, 'Manager')}<p class="muted">Spend from each manager's team. Team totals only, no individual employees.</p></div></div>
<div class="card"><h2>Policy compliance by department</h2>${complianceTable(compliance)}</div>
<div class="grid"><div class="card"><h2>By category</h2>${summaryTable(byCategory, 'Category')}</div>
<div class="card"><div class="row"><h2>GST input credit by month</h2><div class="spacer"></div><a class="btn sm" href="/finance/gst.csv${period !== 'all' ? `?period=${period}` : ''}">Export CSV</a></div>${summaryTable(byMonth, 'Month', { gst: true })}<p class="muted">GST credit counts approved expenses only. The CSV breaks it down by month, department and category for filing.</p></div></div>`,
  });
}

const catOptions = (sel) => CATEGORIES.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');

const ROLE_LABEL = (role) => ({ manager: 'Manager', employee: 'Employee', finance: 'Finance' }[role] || '');
const kindOptions = () => Object.entries(FLAG_KINDS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');

// Everything that needs a reviewer's attention: the app's policy checks, plus issues raised in review (often by Claude).
function flagsCard(r) {
  const policy = r.expenses.filter((e) => e.policy_flag).map((e) => `<div class="issue"><span class="chip warn">⚠ Policy</span>
<div class="body"><span class="k">${esc(e.policy_flag)}</span><div class="muted">${esc(e.merchant)} · ${inr(e.amount)} · ${esc(e.spent_on)} · checked automatically by Claimly</div></div></div>`);
  const raised = r.flags.map((f) => `<div class="issue${f.resolved_at ? ' done' : ''}"><span class="chip ai">🔎 ${esc(f.label)}</span>
<div class="body"><span class="k">${esc(f.message)}</span>
<div class="muted">${f.expense_merchant ? `Line: ${esc(f.expense_merchant)} · ` : ''}raised by ${esc(f.raised_by_name || 'someone')} ${f.via === 'claude' ? '<span class="badge b-claude">via Claude</span>' : ''} · ${fmtDate(f.created_at)}</div>
${f.resolved_at ? `<div class="muted">✓ Resolved by ${esc(f.resolved_by_name)}${f.resolution ? `: “${esc(f.resolution)}”` : ''} · ${fmtDate(f.resolved_at)}</div>` : ''}</div>
${!f.resolved_at && r.can.resolve_flag ? `<form method="post" action="/flags/${f.id}/resolve" class="row" style="max-width:320px"><input name="note" placeholder="Resolution note (optional)"><button class="btn sm g">Resolve</button></form>` : ''}</div>`);
  const form = r.can.flag
    ? `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">+ Flag an issue</summary>
<form method="post" action="/reports/${r.id}/flags" class="row" style="margin-top:8px"><select name="kind" style="width:170px">${kindOptions()}</select>
<select name="expense_id" style="width:220px"><option value="">Whole report</option>${r.expenses.map((e) => `<option value="${e.id}">${esc(e.merchant)} (${inr(e.amount)})</option>`).join('')}</select>
<input name="message" placeholder="What looks wrong?" required style="flex:1;min-width:220px"><button class="btn sm">Flag</button></form></details>`
    : '';
  if (!policy.length && !raised.length && !form) return '';
  return `<div class="card"><h2>Flags ${r.open_flags + r.flag_count ? `<span class="chip warn">${r.open_flags + r.flag_count} need attention</span>` : ''}</h2>
${policy.length || raised.length ? policy.join('') + raised.join('') : '<p class="muted">No issues flagged.</p>'}${form}</div>`;
}

function conversationCard(r) {
  const msgs = r.comments.map((c) => `<div class="msg${c.author_role === 'manager' ? ' mgr' : ''}"><div class="who"><b>${esc(c.author_name)}</b> <span class="muted">${ROLE_LABEL(c.author_role)}</span>
${c.via === 'claude' ? '<span class="badge b-claude">via Claude</span>' : ''} <span class="muted">· ${fmtDate(c.created_at)}</span></div><div class="text">${esc(c.body)}</div></div>`).join('');
  return `<div class="card" id="conversation"><h2>Conversation</h2>
${msgs || `<p class="muted">No messages yet. ${r.rel === 'manager' ? 'Ask the employee about anything that looks off.' : 'Your manager can ask questions here, and you can reply.'}</p>`}
${r.can.comment ? `<form method="post" action="/reports/${r.id}/comments"><textarea name="body" placeholder="${r.rel === 'manager' ? 'Ask a question or leave a note for the employee…' : 'Reply to your manager…'}" required></textarea>
<div class="row" style="margin-top:8px"><button class="btn sm p">Post</button></div></form>` : ''}</div>`;
}

// One line under the title explaining where the report stands and who can act next.
function statusGuard(r) {
  const first = (n) => esc(String(n || '').split(' ')[0]);
  if (r.rel === 'owner') {
    if (r.status === 'submitted') return '<div class="guard">Submitted to your manager. Need a change? Click <b>Edit report</b>: approval pauses until you resubmit.</div>';
    if (r.status === 'revising') return '<div class="guard">You are revising this report. Your manager can see it but can\'t approve it until you click <b>Resubmit for approval</b>.</div>';
    if (r.status === 'approved') return '<div class="guard">Approved and locked.</div>';
  } else if (r.rel === 'manager') {
    if (r.status === 'revising') return `<div class="guard">${first(r.owner_name)} is revising this report. You can read it and comment; approve or reject unlocks when they resubmit.</div>`;
  }
  return '';
}

export function reportPage({ user, r, flash, error, editMode = false }) {
  // Every report opens read-only; "Edit" switches to edit mode (and reopens a submitted report first).
  const editable = r.can.edit && editMode;
  const forms = editable ? r.expenses.map((e) => `<form id="f${e.id}" method="post" action="/expenses/${e.id}"></form>`).join('') : '';
  const rows = r.expenses.map((e) =>
    editable
      ? `<tr><td><input form="f${e.id}" type="date" name="spent_on" value="${esc(e.spent_on)}" required></td>
<td><input form="f${e.id}" name="merchant" value="${esc(e.merchant)}" required></td>
<td><select form="f${e.id}" name="category">${catOptions(e.category)}</select></td>
<td><input form="f${e.id}" name="amount" type="number" step="0.01" min="0.01" value="${e.amount}" required style="width:110px"></td>
<td><input form="f${e.id}" name="gst" type="number" step="0.01" min="0" value="${e.gst}" style="width:90px"></td>
<td><input form="f${e.id}" name="notes" value="${esc(e.notes || '')}">${e.policy_flag ? `<div class="flag" style="margin-top:4px">⚠ ${esc(e.policy_flag)}</div>` : ''}</td>
<td class="n"><button form="f${e.id}" class="btn sm">Save</button> <button form="f${e.id}" formaction="/expenses/${e.id}/delete" class="btn sm r" title="Remove">✕</button></td></tr>`
      : `<tr><td>${esc(e.spent_on)}</td><td>${esc(e.merchant)}${e.notes ? `<div class="muted">${esc(e.notes)}</div>` : ''}</td><td>${esc(e.category)}</td>
<td class="n">${inr(e.amount)}</td><td class="n">${inr(e.gst)}</td><td>${e.policy_flag ? `<span class="flag">⚠ ${esc(e.policy_flag)}</span>` : '<span class="muted">OK</span>'}</td><td></td></tr>`
  ).join('');

  const addRow = editable
    ? `<tr><td colspan="7" style="padding-top:14px"><form method="post" action="/reports/${r.id}/expenses" class="row">
<input type="date" name="spent_on" required style="width:150px"><input name="merchant" placeholder="Merchant" required style="width:190px">
<select name="category" style="width:150px">${catOptions()}</select><input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount ₹" required style="width:110px">
<input name="gst" type="number" step="0.01" min="0" placeholder="GST ₹" style="width:90px"><input name="notes" placeholder="Notes" style="width:160px">
<button class="btn sm">+ Add line</button></form></td></tr>`
    : '';

  const actions = [];
  if (editMode) actions.push(`<a class="btn" href="/reports/${r.id}">✓ Done editing</a>`);
  else if (r.can.start_edit) actions.push(`<form method="post" action="/reports/${r.id}/edit" onsubmit="return confirm('Reopen this report for editing? Your manager can still see it, but can\\'t approve it until you resubmit.')"><button class="btn">✎ Edit report</button></form>`);
  else if (r.can.edit) actions.push(`<a class="btn" href="/reports/${r.id}?edit=1">✎ ${r.rel === 'manager' ? 'Correct lines' : 'Edit report'}</a>`);
  if (r.can.submit) actions.push(`<form method="post" action="/reports/${r.id}/submit"><button class="btn p">${r.status === 'draft' ? 'Submit for approval' : 'Resubmit for approval'}</button></form>`);
  if (r.can.delete) actions.push(`<form method="post" action="/reports/${r.id}/delete" onsubmit="return confirm('Delete this draft?')"><button class="btn r">Delete draft</button></form>`);
  actions.push(`<a class="btn" href="/reports/${r.id}/export.csv">Export CSV</a>`);

  const decide = r.can.decide
    ? `<div class="card"><h2>Your decision</h2>${r.open_flags ? `<div class="alert err">${r.open_flags} open flag${r.open_flags === 1 ? '' : 's'} on this report. Read the flags and the conversation before deciding.</div>` : ''}<p class="muted">You can also correct lines above before approving. Policy limits: meals ${inr(LIMITS.mealPerItem)}/item, hotels ${inr(LIMITS.hotelPerNight)}/night.</p>
<form method="post" action="/reports/${r.id}/decide" class="row"><input name="note" placeholder="Comment (required to reject)" style="flex:1;min-width:220px">
<button name="decision" value="approve" class="btn g">Approve ${inr(r.total)}</button><button name="decision" value="reject" class="btn r">Reject</button></form></div>`
    : '';

  return layout({
    title: r.title, user, flash, error,
    body: `${forms}<p class="muted"><a href="/">← Dashboard</a></p>
<div class="row"><div><h1>${esc(r.title)} ${viaBadge(r.created_via)}</h1>
<p class="sub">${esc(r.owner_name)} · ${esc(r.owner_department)} · ${badge(r.status)}${r.decided_by_name ? ` by ${esc(r.decided_by_name)}${r.decision_note ? `: “${esc(r.decision_note)}”` : ''}` : ''}</p></div>
<div class="spacer"></div><div class="row">${actions.join('')}</div></div>
${kpis([['Total', inr(r.total)], ['GST', inr(r.gst_total)], ['Lines', r.expenses.length], ['Needs attention', (r.flag_count + r.open_flags) ? `<span style="color:#a14d00">⚠ ${r.flag_count + r.open_flags}</span>` : '0']])}
${statusGuard(r)}
${editable && r.rel === 'owner' ? `<form method="post" action="/reports/${r.id}/rename" class="row" style="margin-bottom:14px"><input name="title" value="${esc(r.title)}" style="max-width:360px"><button class="btn sm">Rename</button></form>` : ''}
${editable && r.rel === 'manager' ? '<div class="guard">Correcting lines as manager. Changes are logged and visible to the employee.</div>' : ''}
${flagsCard(r)}
<div class="card"><table><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th class="n">Amount</th><th class="n">GST</th><th>${editable ? 'Notes / policy' : 'Policy'}</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">No lines yet.</td></tr>'}${addRow}</tbody></table></div>
${conversationCard(r)}
${decide}
<div class="card"><h2>Activity</h2><ul class="log">${r.activity.map((a) => `<li><b>${esc(a.actor_name || 'System')}</b> ${a.via === 'claude' ? '<span class="badge b-claude">via Claude</span>' : ''} ${esc(a.action)} <span class="muted">· ${fmtDate(a.at)}</span></li>`).join('')}</ul></div>`,
  });
}

export function newReportPage({ user, error }) {
  return layout({
    title: 'New report', user, error,
    body: `<p class="muted"><a href="/">← Dashboard</a></p><h1>New expense report</h1>
<p class="sub">Tip: the fast way is to give Claude your receipts and say <i>“file these as an expense report”</i>.</p>
<div class="card"><form method="post" action="/reports" class="row"><input name="title" placeholder="e.g. Pune client visit" required style="max-width:360px">
<button class="btn p">Create draft</button></form></div>`,
  });
}

export function connectPage({ user, mcpUrl, flash }) {
  const prompts = {
    employee: ['Here are my receipts from the Pune trip. File them as an expense report and submit it.', 'Has my manager asked anything on my reports? Reply that the hotel invoice date is the checkout date.', 'How much have I spent on meals this month?'],
    manager: ['What reports are waiting for my approval? Check each one and flag anything that looks off.', 'Ask Arjun why the dinner is over the meal limit.', 'Show my team\'s spend by department and by person.', "What did the Middleware team spend? (you'll see the guardrail block this)"],
    finance: ['Which departments are near or over budget this month?', 'Where is policy being ignored most? Compare departments.', 'How much GST input credit can we claim for last month?', 'Show spend by approving manager.', "How much did Arjun spend? (you'll see the guardrail block this)"],
  }[user.role];
  return layout({
    title: 'Connect Claude', user, flash,
    body: `<h1>Connect your Claude</h1><p class="sub">Claimly has no AI inside. Your own Claude does the reading and calls Claimly through MCP.</p>
<div class="card"><h2>Your personal MCP link</h2><p><span class="code" id="u">${esc(mcpUrl)}</span></p>
<div class="row"><button class="btn sm" onclick="navigator.clipboard.writeText(document.getElementById('u').textContent);this.textContent='Copied ✓'">Copy link</button>
<form method="post" action="/connect/rotate" onsubmit="return confirm('Old link will stop working. Continue?')"><button class="btn sm r">Regenerate link</button></form></div>
<p class="muted">This link acts as you (${esc(user.name)}, ${ROLE[user.role]}). Treat it like a password.</p></div>
<div class="grid"><div class="card"><h2>Add it to Claude (1 minute)</h2><ol>
<li>Open <b>claude.ai</b> → <b>Settings</b> → <b>Connectors</b>.</li>
<li>Click <b>Add custom connector</b>.</li>
<li>Name: <code>Claimly</code>. URL: paste your link above. Click <b>Add</b>.</li>
<li>In a new chat, open the tools menu and make sure <b>Claimly</b> is switched on.</li></ol>
<p class="muted">Works with any MCP client that supports remote (Streamable HTTP) servers.</p></div>
<div class="card"><h2>Try asking</h2><ul>${prompts.map((p) => `<li>“${esc(p)}”</li>`).join('')}</ul></div></div>`,
  });
}

export function errorPage({ user, message, status }) {
  return layout({
    title: 'Not allowed', user,
    body: `<div class="card"><h1>${status === 404 ? 'Not found' : status === 400 ? 'Check that' : '🔒 Not allowed'}</h1><p>${esc(message)}</p><a class="btn" href="javascript:history.back()">← Back</a> <a class="btn" href="/">Dashboard</a></div>`,
  });
}
