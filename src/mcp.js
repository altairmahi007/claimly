// MCP server: one instance per request, bound to the user who owns the MCP link.
// Claude does the reading and writing; these tools only store, edit and compute.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppError, describeAccess, getTeam, spendSummary } from './access.js';
import {
  addExpenses, createReport, decideReport, deleteExpense, getReport, listReports, submitReport, updateExpense,
} from './repo.js';
import { CATEGORIES, LIMITS } from './policy.js';

const Expense = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date of the expense, YYYY-MM-DD'),
  merchant: z.string().min(1).max(140).describe('Merchant / vendor name, e.g. "IndiGo BLR→BOM" or "Uber"'),
  category: z.enum(CATEGORIES).describe('Expense category'),
  amount: z.number().positive().describe('Total amount paid in INR, including taxes'),
  gst: z.number().min(0).optional().describe('GST portion in INR if shown on the receipt'),
  notes: z.string().max(500).optional().describe('Optional business purpose or context'),
});

const toRow = (e) => ({ spent_on: e.date, merchant: e.merchant, category: e.category, amount: e.amount, gst: e.gst, notes: e.notes });

export function buildMcpServer(user, baseUrl) {
  const server = new McpServer(
    { name: 'claimly', version: '1.0.0' },
    {
      instructions:
        `Claimly is an expense-claims app. The connected user is ${user.name} (${user.role}, ${user.department}). ` +
        `When the user shares receipts, bank/UPI SMS, card statements or describes spending, extract each expense yourself ` +
        `and save it with create_expense_report or add_expenses. Amounts are INR. Hotel stays: one line per night. ` +
        `Policy limits: meals ₹${LIMITS.mealPerItem}/item, hotels ₹${LIMITS.hotelPerNight}/night, anything over ₹${LIMITS.preApproval} needs finance pre-approval. ` +
        `For spend questions always call get_spend_summary instead of adding numbers yourself. ` +
        `Access rules are enforced by the app; if a tool returns "Access denied", explain that to the user and don't try to work around it.`,
    }
  );

  const link = (id) => `${baseUrl}/reports/${id}`;
  const reply = (text, data) => ({
    content: [{ type: 'text', text: data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 2)}` }],
  });
  const run = (fn) => async (args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      if (e instanceof AppError) return { isError: true, content: [{ type: 'text', text: e.message }] };
      console.error('MCP tool error', e);
      return { isError: true, content: [{ type: 'text', text: 'Server error while running this tool. Please try again.' }] };
    }
  };

  const reportView = (r) => ({
    id: r.id,
    title: r.title,
    owner: r.owner_name,
    department: r.owner_department,
    status: r.status,
    total_inr: r.total,
    gst_inr: r.gst_total,
    policy_flags: r.flag_count,
    your_permissions: r.can,
    link: link(r.id),
    expenses: r.expenses.map((e) => ({
      id: e.id, date: e.spent_on, merchant: e.merchant, category: e.category, amount: e.amount, gst: e.gst, notes: e.notes, policy_flag: e.policy_flag,
    })),
    decision: r.decided_by_name ? { by: r.decided_by_name, at: r.decided_at, note: r.decision_note } : null,
  });

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Shows the signed-in Claimly user, their role, their team and exactly what data they are allowed to see. Call this first if unsure what the user can do.',
      inputSchema: {},
    },
    run(async () => {
      const team = user.role === 'manager' ? await getTeam(user.id) : [];
      return reply('Connected to Claimly.', {
        name: user.name,
        role: user.role,
        department: user.department,
        title: user.title,
        team: team.map((t) => ({ name: t.name, department: t.department })),
        access: describeAccess(user, team),
        categories: CATEGORIES,
        app: `${baseUrl}/`,
      });
    })
  );

  server.registerTool(
    'create_expense_report',
    {
      title: 'Create expense report',
      description:
        'Create a new expense report for the signed-in user from receipts, bank/UPI SMS, statements or a description. ' +
        'Extract one line per receipt (hotel: one line per night). Set submit=true only if the user asked to submit it for approval. ' +
        'Returns the report with any policy flags and a link the user can open to review and edit.',
      inputSchema: {
        title: z.string().min(1).max(140).describe('Short report name, e.g. "Mumbai client workshop"'),
        expenses: z.array(Expense).min(1).max(100),
        submit: z.boolean().optional().describe('Submit for manager approval right away'),
      },
    },
    run(async ({ title, expenses, submit }) => {
      const id = await createReport(user, { title, expenses: expenses.map(toRow), via: 'claude' });
      if (submit) await submitReport(user, id, 'claude');
      const r = await getReport(user, id);
      return reply(`Created report #${id} "${r.title}" (${r.status}) with ${r.expenses.length} expenses, total ₹${r.total.toLocaleString('en-IN')}. Open it: ${link(id)}`, reportView(r));
    })
  );

  server.registerTool(
    'add_expenses',
    {
      title: 'Add expenses to a report',
      description: 'Add more expense lines to an existing report (owner: while draft/rejected).',
      inputSchema: { report_id: z.number().int(), expenses: z.array(Expense).min(1).max(100) },
    },
    run(async ({ report_id, expenses }) => {
      await addExpenses(user, report_id, expenses.map(toRow), 'claude');
      const r = await getReport(user, report_id);
      return reply(`Added ${expenses.length} expense(s). New total ₹${r.total.toLocaleString('en-IN')}.`, reportView(r));
    })
  );

  server.registerTool(
    'update_expense',
    {
      title: 'Edit an expense line',
      description: 'Change fields of one expense line. Owners can edit draft/rejected reports; managers can correct lines on submitted reports from their reportees.',
      inputSchema: {
        expense_id: z.number().int(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        merchant: z.string().min(1).max(140).optional(),
        category: z.enum(CATEGORIES).optional(),
        amount: z.number().positive().optional(),
        gst: z.number().min(0).optional(),
        notes: z.string().max(500).optional(),
      },
    },
    run(async ({ expense_id, date, ...rest }) => {
      await updateExpense(user, expense_id, { spent_on: date, ...rest }, 'claude');
      return reply(`Expense #${expense_id} updated.`);
    })
  );

  server.registerTool(
    'delete_expense',
    {
      title: 'Remove an expense line',
      description: 'Remove one expense line from a report the user is allowed to edit.',
      inputSchema: { expense_id: z.number().int() },
    },
    run(async ({ expense_id }) => {
      await deleteExpense(user, expense_id, 'claude');
      return reply(`Expense #${expense_id} removed.`);
    })
  );

  server.registerTool(
    'list_reports',
    {
      title: 'List expense reports',
      description: 'List expense reports. scope "mine" = the user\'s own reports; scope "team" (managers only) = reports from direct reportees. Finance users cannot list individual reports.',
      inputSchema: {
        scope: z.enum(['mine', 'team']).optional(),
        status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional(),
      },
    },
    run(async ({ scope, status }) => {
      const rows = await listReports(user, { scope: scope || (user.role === 'manager' ? 'team' : 'mine'), status });
      return reply(`${rows.length} report(s).`, rows.map((r) => ({
        id: r.id, title: r.title, owner: r.owner_name, department: r.department, status: r.status,
        total_inr: r.total, items: r.items, policy_flags: r.flags, created_via: r.created_via, link: link(r.id),
      })));
    })
  );

  server.registerTool(
    'get_report',
    {
      title: 'Get an expense report',
      description: 'Get one report with all its expense lines, policy flags and what the user is allowed to do with it.',
      inputSchema: { report_id: z.number().int() },
    },
    run(async ({ report_id }) => reply('Report details.', reportView(await getReport(user, report_id))))
  );

  server.registerTool(
    'submit_report',
    {
      title: 'Submit report for approval',
      description: "Submit the user's own draft or rejected report to their manager for approval.",
      inputSchema: { report_id: z.number().int() },
    },
    run(async ({ report_id }) => {
      await submitReport(user, report_id, 'claude');
      return reply(`Report #${report_id} submitted for approval. ${link(report_id)}`);
    })
  );

  server.registerTool(
    'decide_report',
    {
      title: 'Approve or reject a report',
      description: "Managers only: approve or reject a submitted report from one of their direct reportees. A reason is required when rejecting. Only do this when the user explicitly asks.",
      inputSchema: {
        report_id: z.number().int(),
        decision: z.enum(['approve', 'reject']),
        note: z.string().max(500).optional().describe('Reason / comment (required for reject)'),
      },
    },
    run(async ({ report_id, decision, note }) => {
      const status = await decideReport(user, report_id, decision, note, 'claude');
      return reply(`Report #${report_id} ${status}. ${link(report_id)}`);
    })
  );

  server.registerTool(
    'get_spend_summary',
    {
      title: 'Spend summary',
      description:
        'Exact spend totals computed by the app, limited to what the user may see. group_by: category | department | person | month. ' +
        'Optional filters: department, person, from/to dates (YYYY-MM-DD). Employees: own spend only. Managers: own team only (by department or reportee). ' +
        'Finance: department-level totals only (no per-person). Use this for any "how much did we spend" question.',
      inputSchema: {
        group_by: z.enum(['category', 'department', 'person', 'month']).optional(),
        department: z.string().optional(),
        person: z.string().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
    },
    run(async (args) => reply('Spend summary (computed by Claimly).', await spendSummary(user, args)))
  );

  return server;
}
