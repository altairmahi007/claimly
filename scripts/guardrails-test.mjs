// End-to-end guardrail checks against a running Claimly (web + MCP).
// Usage: node scripts/guardrails-test.mjs [baseUrl]   (default http://localhost:3000)
// Expects a freshly seeded database (report ids 1-6 from src/db.js seed).
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PW = process.env.DEMO_PASSWORD || 'demo1234';
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

async function login(email) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: PW }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('sid=') || cookie === 'sid=') throw new Error(`login failed for ${email}: ${res.status}`);
  return cookie;
}
const web = async (cookie, path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
};
const form = (cookie, path, data) => web(cookie, path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data),
});
async function mcpToken(cookie) {
  const { text } = await web(cookie, '/connect');
  const m = text.match(/\/mcp\/([A-Za-z0-9_-]{20,})/);
  if (!m) throw new Error('no MCP link on /connect');
  return m[1];
}
let rpcId = 1;
async function rpc(token, method, params) {
  const res = await fetch(`${BASE}/mcp/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const body = await res.text();
  try { return JSON.parse(body); } catch { throw new Error(`MCP ${method} -> ${res.status}: ${body.slice(0, 300)}`); }
}
const tool = async (token, name, args = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  if (r.error) return { isError: true, text: `RPC error: ${r.error.message}` };
  return { isError: !!r.result.isError, text: r.result.content.map((c) => c.text).join('\n') };
};
const denied = (r) => r.isError && /denied|only see|not your direct|Finance can|only managers|can only/i.test(r.text);

const users = {};
for (const n of ['arjun', 'neha', 'karan', 'divya', 'ria', 'vikram', 'ashish']) {
  const cookie = await login(`${n}@claimly.demo`);
  users[n] = { cookie, token: await mcpToken(cookie) };
}
const { arjun, neha, karan, divya, ria, vikram, ashish } = users;
// Seed: 1 Arjun Mumbai (submitted), 2 Arjun Figma (approved), 3 Neha AWS (approved),
//       4 Neha draft, 5 Karan Hyderabad (submitted), 6 Karan Kafka (approved),
//       7 Divya Chennai (submitted), 8 Divya Kafka meetup (approved)

console.log('\nMCP handshake');
const init = await rpc(arjun.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
ok(init.result?.serverInfo?.name === 'claimly', 'initialize returns serverInfo', JSON.stringify(init).slice(0, 200));
const list = await rpc(arjun.token, 'tools/list', {});
ok(list.result?.tools?.length === 17, `tools/list returns 17 tools (got ${list.result?.tools?.length})`);
const bad = await fetch(`${BASE}/mcp/not-a-real-token`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
ok(bad.status === 401, 'invalid MCP token -> 401');

console.log('\nEmployees: own reports only');
for (const [who, own, other] of [['arjun', 1, 3], ['neha', 3, 1], ['karan', 5, 1]]) {
  const u = users[who];
  ok((await web(u.cookie, `/reports/${own}`)).status === 200, `web: ${who} opens own report #${own}`);
  ok((await web(u.cookie, `/reports/${other}`)).status === 403, `web: ${who} blocked from report #${other}`);
  ok(!(await tool(u.token, 'get_report', { report_id: own })).isError, `mcp: ${who} get_report own #${own}`);
  ok(denied(await tool(u.token, 'get_report', { report_id: other })), `mcp: ${who} get_report #${other} denied`);
}
ok(denied(await tool(arjun.token, 'get_spend_summary', { group_by: 'department' })), 'mcp: employee spend by department denied');
ok(denied(await tool(arjun.token, 'get_spend_summary', { person: 'Neha' })), 'mcp: employee spend for another person denied');
ok(denied(await tool(arjun.token, 'list_reports', { scope: 'team' })), 'mcp: employee list team reports denied');
const arjunList = await tool(arjun.token, 'list_reports', {});
ok(!arjunList.isError && !/Neha|Karan/.test(arjunList.text), 'mcp: arjun list_reports shows only his own');
const arjunSpend = await tool(arjun.token, 'get_spend_summary', { group_by: 'category' });
ok(!arjunSpend.isError && /"total": 27990/.test(arjunSpend.text), 'mcp: arjun own spend total = 27990 (submitted + approved)', arjunSpend.text.slice(0, 400));
const arjunA = await web(arjun.cookie, '/?show=approved');
ok(/Figma seat renewal/.test(arjunA.text) && !/Mumbai client workshop/.test(arjunA.text), 'web: Approved box only -> approved reports only');
const arjunP = await web(arjun.cookie, '/?show=pending');
ok(/Mumbai client workshop/.test(arjunP.text) && !/Figma seat renewal/.test(arjunP.text), 'web: Pending box only -> pending reports only');
ok(/Figma seat renewal/.test((await web(arjun.cookie, '/')).text) && /Mumbai client workshop/.test((await web(arjun.cookie, '/')).text), 'web: both boxes on -> all reports');
ok(denied(await tool(arjun.token, 'decide_report', { report_id: 1, decision: 'approve' })) || (await tool(arjun.token, 'decide_report', { report_id: 1, decision: 'approve' })).isError, 'mcp: arjun cannot approve own report');

console.log('\nRia (manager of Arjun + Neha)');
const riaDash = await web(ria.cookie, '/');
ok(riaDash.status === 200 && /Arjun/.test(riaDash.text) && /Neha/.test(riaDash.text), 'web: Ria dashboard shows Arjun and Neha');
ok(!/Karan|Divya|Middleware/.test(riaDash.text), 'web: Ria dashboard never mentions Karan, Divya or Middleware');
ok(!/Database tooling/.test(riaDash.text), 'web: Ria dashboard hides Neha draft');
ok((await web(ria.cookie, '/reports/1')).status === 200, 'web: Ria opens Arjun report #1');
ok((await web(ria.cookie, '/reports/3')).status === 200, 'web: Ria opens Neha report #3');
const riaDraft = await web(ria.cookie, '/reports/4');
ok(riaDraft.status === 403 && !/Database tooling|Neha/.test(riaDraft.text), 'web: Ria blocked from Neha draft #4, nothing revealed');
ok(denied(await tool(ria.token, 'get_report', { report_id: 4 })), 'mcp: Ria get_report Neha draft #4 denied');
ok(denied(await tool(ria.token, 'add_comment', { report_id: 4, message: 'hi' })), 'mcp: Ria cannot comment on Neha draft');
ok(!/Database tooling/.test((await tool(ria.token, 'list_reports', { scope: 'team', status: 'draft' })).text), 'mcp: Ria list_reports never returns drafts');
const riaK = await web(ria.cookie, '/reports/5');
ok(riaK.status === 403, 'web: Ria blocked from Karan report #5');
ok((await web(ria.cookie, '/reports/5/export.csv')).status === 403, 'web: Ria blocked from Karan CSV export');
ok((await form(ria.cookie, '/reports/5/decide', { decision: 'approve' })).status === 403, 'web: Ria cannot approve Karan report #5');
ok(!/Karan|Middleware/.test(riaK.text), 'web: denial page does not name Karan or Middleware');
const riaGetK = await tool(ria.token, 'get_report', { report_id: 5 });
ok(denied(riaGetK), 'mcp: Ria get_report Karan #5 denied');
ok(!/Karan|Middleware/.test(riaGetK.text), 'mcp: denial message does not name Karan or Middleware', riaGetK.text);
ok(!/Karan|Middleware/.test((await tool(ria.token, 'update_expense', { expense_id: 12, amount: 1 })).text), 'mcp: line-edit denial does not name Karan');
ok(denied(await tool(ria.token, 'decide_report', { report_id: 5, decision: 'approve' })), 'mcp: Ria decide Karan #5 denied');
ok(denied(await tool(ria.token, 'get_spend_summary', { department: 'Middleware' })), 'mcp: Ria spend for Middleware denied');
ok(denied(await tool(ria.token, 'get_spend_summary', { person: 'Karan' })), 'mcp: Ria spend for Karan denied');
ok(denied(await tool(ria.token, 'get_spend_summary', { person: 'Karan Patel', group_by: 'person' })), 'mcp: Ria spend for "Karan Patel" denied');
ok(denied(await tool(ria.token, 'update_expense', { expense_id: 12, amount: 1 })), 'mcp: Ria edit a Karan expense line denied');
const riaTeam = await tool(ria.token, 'list_reports', { scope: 'team' });
ok(!riaTeam.isError && /Arjun/.test(riaTeam.text) && !/Karan|Divya|Middleware|Database tooling/.test(riaTeam.text), 'mcp: Ria list_reports team = Arjun + Neha only');
const riaDept = await tool(ria.token, 'get_spend_summary', { group_by: 'department' });
ok(!riaDept.isError && /"UI"/.test(riaDept.text) && /"Backend"/.test(riaDept.text) && !/Middleware/.test(riaDept.text), 'mcp: Ria spend by department = UI + Backend only');
const riaPerson = await tool(ria.token, 'get_spend_summary', { group_by: 'person' });
ok(!riaPerson.isError && /Arjun Menon/.test(riaPerson.text) && /Neha Iyer/.test(riaPerson.text) && !/Karan|Divya/.test(riaPerson.text), 'mcp: Ria spend by reportee = Arjun + Neha only');
const riaWho = await tool(ria.token, 'whoami');
ok(!/Karan|Divya|Middleware/.test(riaWho.text), 'mcp: Ria whoami never mentions Karan/Middleware');
ok(!(await tool(ria.token, 'update_expense', { expense_id: 2, notes: 'Corrected by manager' })).isError, 'mcp: Ria corrects a line on Arjun submitted report');

console.log('\nFlags and conversation (Ria <-> Arjun on report #1)');
const fl = await tool(ria.token, 'flag_issue', { report_id: 1, type: 'date_mismatch', expense_id: 5, message: 'Dinner is dated the same day as the outbound flight landing late; please confirm.' });
ok(!fl.isError && /Flag #\d+/.test(fl.text), 'mcp: Ria flags a date mismatch on Arjun #1', fl.text);
const flagId = Number((fl.text.match(/Flag #(\d+)/) || [])[1]);
ok(denied(await tool(karan.token, 'flag_issue', { report_id: 1, type: 'other', message: 'x' })), 'mcp: Karan cannot flag Arjun report');
ok(denied(await tool(ashish.token, 'flag_issue', { report_id: 1, type: 'other', message: 'x' })), 'mcp: finance cannot flag reports');
ok((await tool(ria.token, 'flag_issue', { report_id: 1, type: 'other', message: 'x', expense_id: 12 })).isError, 'mcp: flag on a line from another report refused');
ok(!(await tool(ria.token, 'add_comment', { report_id: 1, message: 'Why is the dinner dated on the travel day?' })).isError, 'mcp: Ria asks a question');
const arjunR1 = await tool(arjun.token, 'get_report', { report_id: 1 });
ok(/Date mismatch/.test(arjunR1.text) && /Why is the dinner dated/.test(arjunR1.text), 'mcp: Arjun sees the flag and the question');
ok(!(await tool(arjun.token, 'add_comment', { report_id: 1, message: 'Client dinner ran late after landing; approve this once please.' })).isError, 'mcp: Arjun replies');
ok(denied(await tool(neha.token, 'add_comment', { report_id: 1, message: 'x' })), 'mcp: Neha cannot comment on Arjun report');
ok(denied(await tool(ashish.token, 'add_comment', { report_id: 1, message: 'x' })), 'mcp: finance cannot comment');
const riaPage1 = await web(ria.cookie, '/reports/1');
ok(/Date mismatch/.test(riaPage1.text) && /approve this once please/.test(riaPage1.text) && /Meal over/.test(riaPage1.text), 'web: report page shows policy flag, raised flag and conversation');
const riaDash2 = await web(ria.cookie, '/');
ok(/🔎 Date mismatch/.test(riaDash2.text) && /💬 2/.test(riaDash2.text), 'web: approval queue shows flag and conversation chips');
const webC = await form(arjun.cookie, '/reports/1/comments', { body: 'Adding: invoice attached to email.' });
ok(webC.status === 302, 'web: Arjun replies on the web');
ok((await form(vikram.cookie, '/reports/1/comments', { body: 'x' })).status === 403, 'web: Vikram cannot comment on Arjun report');
ok(denied(await tool(arjun.token, 'resolve_flag', { flag_id: flagId })), 'mcp: Arjun cannot resolve flags');
ok(denied(await tool(vikram.token, 'resolve_flag', { flag_id: flagId })), 'mcp: Vikram cannot resolve Ria team flags');
ok(!(await tool(ria.token, 'resolve_flag', { flag_id: flagId, note: 'Explained in conversation' })).isError, 'mcp: Ria resolves the flag');
ok((await tool(ria.token, 'decide_report', { report_id: 1, decision: 'reject' })).isError, 'mcp: reject without reason refused');
const ownEdit = await tool(arjun.token, 'update_expense', { expense_id: 5, notes: 'Dinner with 3 client stakeholders' });
ok(!ownEdit.isError && /being revised/.test(ownEdit.text), 'mcp: Arjun edits submitted #1, Claude is told it is now being revised', ownEdit.text);
ok(!(await tool(arjun.token, 'add_expenses', { report_id: 1, expenses: [{ date: '2026-11-01', merchant: 'Airport parking', category: 'Local transport', amount: 200 }] })).isError, 'mcp: Arjun adds a line to submitted #1');
ok(/Dinner with 3 client stakeholders/.test((await tool(ria.token, 'get_report', { report_id: 1 })).text), 'mcp: Ria sees Arjun\'s correction');
const arjunView = (await web(arjun.cookie, '/reports/1')).text;
ok(/Being revised/.test(arjunView) && /Resubmit for approval/.test(arjunView), 'web: Arjun sees "Being revised" and a Resubmit button');
ok(!/action="\/expenses\/\d+"/.test(arjunView), 'web: report opens read-only (no edit forms) until Edit is clicked');
ok(/action="\/expenses\/\d+"/.test((await web(arjun.cookie, '/reports/1?edit=1')).text), 'web: edit mode shows the edit forms');
const riaRev = await web(ria.cookie, '/');
ok(/Mumbai client workshop/.test(riaRev.text) && /Being revised/.test(riaRev.text), 'web: Ria still sees #1 in her queue, marked Being revised');
const riaRevPage = await web(ria.cookie, '/reports/1');
ok(riaRevPage.status === 200 && !/name="decision"/.test(riaRevPage.text), 'web: Ria can read #1 but gets no approve/reject buttons');
const midAppr = await tool(ria.token, 'decide_report', { report_id: 1, decision: 'approve' });
ok(midAppr.isError && /revising/.test(midAppr.text), 'mcp: Ria cannot approve #1 while it is being revised', midAppr.text);
ok((await form(ria.cookie, '/reports/1/decide', { decision: 'approve' })).status === 403, 'web: Ria cannot approve #1 while it is being revised');
ok((await tool(ria.token, 'update_expense', { expense_id: 5, notes: 'x' })).isError, 'mcp: Ria cannot edit lines while Arjun is revising');
const riaSpendRev = await tool(ria.token, 'get_spend_summary', { group_by: 'person' });
ok(/Arjun Menon/.test(riaSpendRev.text) && /"pending": 2(6|7)\d{3}/.test(riaSpendRev.text), 'mcp: being-revised report still counts as pending spend', riaSpendRev.text.slice(0, 500));
const resub = await tool(arjun.token, 'submit_report', { report_id: 1 });
ok(!resub.isError, 'mcp: Arjun resubmits #1', resub.text);
ok(/Resubmitted for approval/.test((await tool(ria.token, 'get_report', { report_id: 1 })).text) || /Resubmitted/.test((await web(ria.cookie, '/reports/1')).text), 'activity log shows the resubmission');
ok(denied(await tool(neha.token, 'update_expense', { expense_id: 5, notes: 'x' })), 'mcp: Neha cannot edit Arjun line');
const appr = await tool(ria.token, 'decide_report', { report_id: 1, decision: 'approve' });
ok(!appr.isError && /approved/.test(appr.text), 'mcp: Ria approves Arjun #1');
ok(/Approved and locked/.test((await web(arjun.cookie, '/reports/1')).text) && !/Edit report/.test((await web(arjun.cookie, '/reports/1')).text), 'web: approved report shows no Edit button');
ok((await form(arjun.cookie, '/reports/1/edit', {})).status === 403, 'web: approved report cannot be reopened');
const lockedOwner = await tool(arjun.token, 'update_expense', { expense_id: 5, notes: 'changed after approval' });
ok(lockedOwner.isError && /approved/.test(lockedOwner.text), 'mcp: Arjun cannot edit #1 once approved');
ok((await tool(arjun.token, 'add_expenses', { report_id: 1, expenses: [{ date: '2026-11-01', merchant: 'x', category: 'Other', amount: 1 }] })).isError, 'mcp: Arjun cannot add lines once approved');
ok((await tool(ria.token, 'update_expense', { expense_id: 5, notes: 'x' })).isError, 'mcp: Ria cannot edit #1 once approved');
ok((await form(arjun.cookie, '/expenses/5', { spent_on: '2026-11-01', merchant: 'x', category: 'Meals', amount: '1' })).status === 403, 'web: Arjun cannot edit an approved line');

console.log('\nVikram (manager of Karan)');
ok((await web(vikram.cookie, '/reports/5')).status === 200, 'web: Vikram opens Karan #5');
ok((await web(vikram.cookie, '/reports/1')).status === 403, 'web: Vikram blocked from Arjun #1');
ok(denied(await tool(vikram.token, 'get_spend_summary', { department: 'UI' })), 'mcp: Vikram spend for UI denied');
const vikPerson = await tool(vikram.token, 'get_spend_summary', { group_by: 'person' });
ok(/Karan Patel/.test(vikPerson.text) && /Divya Nair/.test(vikPerson.text) && !/Arjun|Neha/.test(vikPerson.text), 'mcp: Vikram spend by reportee = Karan + Divya');
ok((await web(vikram.cookie, '/reports/7')).status === 200, 'web: Vikram opens Divya #7');
const k5 = (await web(karan.cookie, '/reports/5')).text;
ok(/Edit report/.test(k5) && !/action="\/expenses\/\d+"/.test(k5), 'web: Karan sees submitted #5 read-only with an Edit button');
const reopen = await form(karan.cookie, '/reports/5/edit', {});
ok(reopen.status === 302 && /edit=1/.test(reopen.location || ''), 'web: Edit reopens #5 and goes to edit mode');
ok((await form(vikram.cookie, '/reports/5/decide', { decision: 'approve' })).status === 403, 'web: Vikram cannot approve #5 while Karan revises it');
ok((await form(karan.cookie, '/reports/5/submit', {})).status === 302, 'web: Karan resubmits #5');
ok(/Resubmitted for approval/.test((await web(vikram.cookie, '/reports/5')).text), 'web: Vikram sees the resubmission in the activity log');
ok(denied(await tool(divya.token, 'get_report', { report_id: 5 })), 'mcp: Divya cannot see Karan report');
ok(denied(await tool(ria.token, 'get_report', { report_id: 7 })), 'mcp: Ria cannot see Divya report');

console.log('\nAshish (finance): department totals only');
const ashDash = await web(ashish.cookie, '/');
ok(ashDash.status === 200 && /Middleware/.test(ashDash.text) && /UI/.test(ashDash.text), 'web: finance dashboard shows department totals');
ok(!/Arjun|Neha|Karan|Divya/.test(ashDash.text), 'web: finance dashboard shows no employee names');
ok(/Department budgets/.test(ashDash.text) && /By approving manager/.test(ashDash.text) && /Policy compliance by department/.test(ashDash.text) && /GST input credit/.test(ashDash.text), 'web: finance dashboard has budgets, by-manager, compliance and GST cards');
ok(/Ria Sharma/.test(ashDash.text) && /Vikram Rao/.test(ashDash.text), 'web: finance sees spend by approving manager');

console.log('\nFinance features: budgets, compliance, GST, by manager');
const byMgr = await tool(ashish.token, 'get_spend_summary', { group_by: 'manager' });
ok(!byMgr.isError && /Ria Sharma/.test(byMgr.text) && /Vikram Rao/.test(byMgr.text) && !/Arjun|Neha|Karan|Divya/.test(byMgr.text), 'mcp: finance spend by approving manager, no employee names');
ok((await tool(arjun.token, 'get_spend_summary', { group_by: 'manager' })).isError, 'mcp: employee cannot group by manager');
const num = (t, k) => Number((t.match(new RegExp(`"totals": \\{[^}]*"${k}": ([\\d.]+)`)) || [])[1]);
const both = (await tool(ashish.token, 'get_spend_summary', { group_by: 'department' })).text;
const onlyA = (await tool(ashish.token, 'get_spend_summary', { group_by: 'department', statuses: ['approved'] })).text;
const onlyP = (await tool(ashish.token, 'get_spend_summary', { group_by: 'department', statuses: ['pending'] })).text;
ok(num(onlyA, 'total') + num(onlyP, 'total') === num(both, 'total') && num(onlyA, 'pending') === 0 && num(onlyP, 'approved') === 0, 'mcp: approved-only + pending-only totals add up to both', `${num(onlyA, 'total')} + ${num(onlyP, 'total')} vs ${num(both, 'total')}`);
const ashB = await tool(ashish.token, 'get_budget_status', {});
ok(!ashB.isError && /"UI"/.test(ashB.text) && /"Middleware"/.test(ashB.text) && /"budget": 180000/.test(ashB.text) && /"quarter_label": "[A-Z][a-z]{2}–[A-Z][a-z]{2} \d{4} \(Q\d FY/.test(ashB.text), 'mcp: finance sees all department budgets for the current quarter');
ok(denied(await tool(ria.token, 'set_department_budget', { department: 'UI', quarterly_amount: 1 })), 'mcp: Ria cannot set budgets');
ok((await tool(arjun.token, 'get_budget_status', {})).isError, 'mcp: employee cannot see budgets');
const setB = await tool(ashish.token, 'set_department_budget', { department: 'ui', quarterly_amount: 75000 });
ok(!setB.isError && /UI budget set to ₹75,000 per quarter/.test(setB.text), 'mcp: finance sets UI budget', setB.text);
const riaB = await tool(ria.token, 'get_budget_status', {});
ok(!riaB.isError && /"budget": 75000/.test(riaB.text) && /"Backend"/.test(riaB.text) && !/Middleware/.test(riaB.text), 'mcp: Ria sees only UI + Backend budgets, with the new value');
ok((await tool(ashish.token, 'set_department_budget', { department: 'Marketing', quarterly_amount: 1000 })).isError, 'mcp: unknown department refused');
await tool(ashish.token, 'set_department_budget', { department: 'Middleware', quarterly_amount: 1000 });
const overB = await tool(ashish.token, 'get_budget_status', {});
ok(/"department": "Middleware"[^}]*"state": "over"/.test(overB.text), 'mcp: Middleware over budget -> state "over"', overB.text.slice(0, 600));
const overPage = (await web(ashish.cookie, '/')).text;
ok(/<tr style="background:#fde8e8"><td><b>Middleware/.test(overPage) && /Over budget/.test(overPage), 'web: over-budget row is tinted red');
await tool(ashish.token, 'set_department_budget', { department: 'Middleware', quarterly_amount: 150000 });
const figmaMonth = new Date(Date.now() - 25 * 864e5).toISOString().slice(0, 7); // seeded approved Figma line (UI)
const pastB = await tool(ashish.token, 'get_budget_status', { quarter: figmaMonth });
const uiPast = JSON.parse(pastB.text.slice(pastB.text.indexOf('{'))).rows.find((r) => r.department === 'UI');
ok(uiPast && uiPast.approved >= 1250 && uiPast.used === Math.round((uiPast.approved + uiPast.pending) * 100) / 100, `mcp: budget for the quarter of ${figmaMonth} counts approved + pending (UI approved ${uiPast?.approved})`);
const [fy, fm] = figmaMonth.split('-').map(Number);
const bq = `${fy}-${String(fm - ((fm - 1) % 3)).padStart(2, '0')}`;
const pastPage = (await web(ashish.cookie, `/?bq=${bq}`)).text;
ok(/approved ·/.test(pastPage) && /pending<\/div>/.test(pastPage) && /Quarter <select/.test(pastPage) && new RegExp(`value="/\\?bq=${bq}" selected|value="/" selected`).test(pastPage), 'web: quarter dropdown selects the quarter and shows approved / pending split');
ok((await form(ashish.cookie, '/budgets', { department: 'Backend', amount: '65000' })).status === 302, 'web: finance saves a budget');
ok((await form(ria.cookie, '/budgets', { department: 'Backend', amount: '1' })).status === 403, 'web: manager cannot save a budget');
const ashC = await tool(ashish.token, 'get_compliance_summary', {});
ok(!ashC.isError && /"UI"/.test(ashC.text) && /"Middleware"/.test(ashC.text) && /"policy_breaches": [1-9]/.test(ashC.text) && !/Arjun|Neha|Karan|Divya/.test(ashC.text), 'mcp: finance compliance by department, no names');
const riaC = await tool(ria.token, 'get_compliance_summary', {});
ok(!riaC.isError && !/Middleware/.test(riaC.text), 'mcp: Ria compliance covers only her team');
ok((await tool(arjun.token, 'get_compliance_summary', {})).isError, 'mcp: employee cannot see compliance');
const gst = await tool(ashish.token, 'get_gst_ledger', {});
ok(!gst.isError && /GST input credit: ₹/.test(gst.text) && !/Arjun|Neha|Karan|Divya/.test(gst.text), 'mcp: finance GST ledger');
ok(denied(await tool(ria.token, 'get_gst_ledger', {})), 'mcp: Ria cannot pull the GST ledger');
const csv = await web(ashish.cookie, '/finance/gst.csv');
ok(csv.status === 200 && /GST input credit \(INR\)/.test(csv.text), 'web: finance downloads GST CSV');
ok((await web(ria.cookie, '/finance/gst.csv')).status === 403, 'web: manager cannot download GST CSV');
const ashApproved = await web(ashish.cookie, '/?show=approved');
ok(/Showing <b>approved<\/b> only/.test(ashApproved.text), 'web: finance can filter to approved only');
for (const id of [1, 3, 5]) ok((await web(ashish.cookie, `/reports/${id}`)).status === 403, `web: finance blocked from report #${id}`);
ok((await web(ashish.cookie, '/reports/1/export.csv')).status === 403, 'web: finance blocked from CSV export');
const ashDept = await tool(ashish.token, 'get_spend_summary', { group_by: 'department' });
ok(!ashDept.isError && /Middleware/.test(ashDept.text) && /"UI"/.test(ashDept.text) && !/Arjun|Neha|Karan|Divya/.test(ashDept.text), 'mcp: finance spend by department works, no names');
ok(denied(await tool(ashish.token, 'get_spend_summary', { group_by: 'person' })), 'mcp: finance spend by person denied');
ok(denied(await tool(ashish.token, 'get_spend_summary', { person: 'Arjun' })), 'mcp: finance spend for Arjun denied');
ok(denied(await tool(ashish.token, 'list_reports', {})), 'mcp: finance list_reports denied');
ok(denied(await tool(ashish.token, 'get_report', { report_id: 1 })), 'mcp: finance get_report denied');
ok((await tool(ashish.token, 'create_expense_report', { title: 'x', expenses: [{ date: '2026-11-01', merchant: 'x', category: 'Other', amount: 1 }] })).isError, 'mcp: finance cannot create reports');

console.log('\nClaude creates, a person edits in the app');
const created = await tool(arjun.token, 'create_expense_report', {
  title: 'Pune trip', submit: false,
  expenses: [
    { date: '2026-11-03', merchant: 'Shatabdi BLR-PUNE', category: 'Travel', amount: 1800 },
    { date: '2026-11-03', merchant: 'Dinner, Malaka Spice', category: 'Meals', amount: 2400, notes: 'Team dinner' },
  ],
});
const newId = Number((created.text.match(/report #(\d+)/) || [])[1]);
ok(!created.isError && newId > 0 && /Meal over/.test(created.text), `mcp: arjun creates report #${newId} with a policy flag`, created.text.slice(0, 300));
const page = await web(arjun.cookie, `/reports/${newId}?edit=1`);
ok(page.status === 200 && /via Claude/.test(page.text), 'web: report shows in app tagged via Claude');
const expId = Number((page.text.match(/action="\/expenses\/(\d+)"/) || [])[1]);
const edit = await form(arjun.cookie, `/expenses/${expId}`, { spent_on: '2026-11-03', merchant: 'Shatabdi BLR-PUNE', category: 'Travel', amount: '1750', gst: '0', notes: 'fixed' });
ok(edit.status === 302, `web: arjun edits expense #${expId}`, `${edit.status} ${edit.text.slice(0, 200)}`);
const after = await tool(arjun.token, 'get_report', { report_id: newId });
ok(/1750/.test(after.text), 'mcp: Claude sees the web edit');
ok(denied(await tool(neha.token, 'get_report', { report_id: newId })), 'mcp: Neha cannot see Arjun new report');
ok((await tool(arjun.token, 'submit_report', { report_id: newId })).isError === false, 'mcp: arjun submits new report');
ok(!(await tool(ria.token, 'get_report', { report_id: newId })).isError, 'mcp: Ria sees new submitted report');
ok(denied(await tool(vikram.token, 'get_report', { report_id: newId })), 'mcp: Vikram cannot see it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
