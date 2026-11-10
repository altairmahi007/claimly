# Claimly: expense claims that your Claude files for you

**No AI inside.** Your own Claude reads receipts, bank/UPI SMS and statements, then calls Claimly through MCP.
Claimly does everything else: it stores the report, checks policy, routes it to the right manager for approval, lets people edit it, and reports spend, with **role-based guardrails enforced by the app, not by Claude**.

## Demo company (password for everyone: `demo1234`)

| Person | Login | Role | What they can see |
|---|---|---|---|
| Arjun Menon | arjun@claimly.demo | Employee, **UI** (manager: Ria) | Own reports and own spend |
| Neha Iyer | neha@claimly.demo | Employee, **Backend** (manager: Ria) | Own reports and own spend |
| Karan Patel | karan@claimly.demo | Employee, **Middleware** (manager: Vikram) | Own reports and own spend |
| Divya Nair | divya@claimly.demo | Employee, **Middleware** (manager: Vikram) | Own reports and own spend |
| Ria Sharma | ria@claimly.demo | Manager of UI + Backend | Arjun's and Neha's **submitted** reports (approve, reject, correct, flag, discuss); spend **by department and by reportee**, budgets, KPIs; can set an **out-of-office delegate**. **Cannot** see drafts, Middleware, Karan or Divya. |
| Vikram Rao | vikram@claimly.demo | Manager of Middleware | Karan's and Divya's submitted reports |
| Ashish Verma | ashish@claimly.demo | Finance | **Department-level** spend across the company (by department, approving manager, category, month), **department budgets** (sets them), **policy compliance by department**, **GST input-credit ledger** (CSV), **process KPIs**. Gives the **second approval on reports over ₹50,000** and records **payouts** (payee + amount only). **Cannot** see any other individual reports or per-person spend. |

The guardrails live in `src/access.js`. The web app and the MCP tools both call the same functions, so a prompt in Claude can't get around them.

## Deploy (about 15 minutes, free)

### 1. Database: Neon (free Postgres)
1. Go to https://neon.tech → sign up → **Create project** (region: Singapore or Mumbai if offered).
2. Copy the **connection string** (`postgresql://...neon.tech/neondb?sslmode=require`).

### 2. Code on GitHub
1. Create a new repo on github.com (e.g. `claimly`).
2. Upload this folder's contents (drag and drop in the GitHub web UI works), or:
   ```bash
   git init && git add . && git commit -m "Claimly v1"
   git remote add origin https://github.com/<you>/claimly.git && git push -u origin main
   ```

### 3. App: Render (free web service)
1. https://render.com → **New → Web Service** → connect your GitHub repo.
2. Runtime **Node**, build command `npm install`, start command `npm start`, instance **Free**.
3. **Environment variables:**
   - `DATABASE_URL` = your Neon connection string
   - `SESSION_SECRET` = any long random string
4. Deploy. On first start the app creates its tables and seeds the demo company automatically.
5. Open `https://<your-app>.onrender.com`. You should see the login page with the demo accounts.

> **Render free instances sleep after 15 minutes idle** (the first request then takes about 50 seconds).
> Before recording and before submitting, add a free monitor at https://cron-job.org (or UptimeRobot) that hits
> `https://<your-app>.onrender.com/health` every 10 minutes, so Volopay's reviewers never hit a cold start.

### Run locally (optional)
```bash
npm install
DATABASE_URL="postgresql://..." SESSION_SECRET="dev" npm start   # http://localhost:3000
```

### Guardrail tests
Against a freshly seeded database, run 200 web + MCP access checks (each role, allowed and denied):
```bash
npm run test:guardrails -- https://<your-app>.onrender.com   # or http://localhost:3000
```

## Connect Claude
1. Log in as any user → **Connect Claude** → copy your personal MCP link (`https://<app>/mcp/<secret>`).
2. claude.ai → **Settings → Connectors → Add custom connector** → name `Claimly`, paste the link → **Add**.
3. In a new chat, check that Claimly is switched on in the tools menu.

Each link acts as that user, so the guardrails apply per person. Links can be regenerated from the Connect page.
To demo several roles, add a connector for each person (e.g. "Claimly – Arjun", "Claimly – Ria", "Claimly – Ashish") and switch on only one at a time.

## MCP tools
| Tool | What it does |
|---|---|
| `whoami` | Who is connected, their role, team and exactly what they can access |
| `create_expense_report` | Claude extracts expense lines from receipts or SMS and saves a report (optionally submits it) |
| `add_expenses`, `update_expense`, `delete_expense` | Edit lines (owner: until approved; manager: while submitted). An owner editing a submitted report reopens it as **Being revised**. Approved reports are locked. |
| `list_reports`, `get_report` | Read reports within the caller's scope |
| `submit_report` | Owner sends the report to their manager |
| `decide_report` | Manager approves or rejects (reason required to reject) |
| `flag_issue` | Record a problem found in review (date or amount mismatch, duplicate, overspending, missing receipt…), optionally on one line |
| `resolve_flag` | Manager marks a flag resolved, with a note |
| `add_comment` | Conversation on a report between the employee and their manager |
| `get_spend_summary` | Exact totals computed by the app, by category, department, person, approving manager or month, for approved and/or pending, limited to the caller's scope |
| `get_budget_status`, `set_department_budget` | Monthly budget vs spend per department (Finance: all, sets budgets; managers: their departments) |
| `get_compliance_summary` | Policy breaches and review flags per department, no names (Finance and managers) |
| `get_gst_ledger` | GST input credit on approved spend by month, department and category (Finance) |
| `what_needs_my_attention` | Role-aware to-do list: drafts / approvals with days waiting / delegated reports / second approvals / payouts / budgets near limit |
| `get_policy` | The expense policy and approval rules, as the app enforces them |
| `get_kpis` | Median submit→approve and approve→paid days, % flagged, % sent back (Finance: company; managers: own team) |
| `get_payout_queue`, `mark_paid` | Finance pays approved claims (mode + UTR/reference); the employee sees "Paid on …" |
| `set_out_of_office` | A manager hands approvals to another manager until a date (logged "on behalf of") |

All tools carry read-only / destructive annotations. Three MCP prompts are included: **File my expenses**, **Approvals digest** (managers) and **Finance close**. Tool results mark titles, merchants, notes and comments as user-entered data, never instructions.

**Approval flow:** employee submits → manager approves (or their out-of-office delegate) → reports over ₹50,000 go to **Finance for a second approval** → Finance records the **payout** (mode + UTR) and the employee sees "Paid on …".

Drafts are private: managers only see a report once it has been submitted. Reports open read-only with an **Edit** button. If the employee edits a submitted report (on the web or through Claude), it becomes **Being revised**: the manager can still read it and comment, but can't approve or reject it until the employee resubmits. It still counts as pending spend. Every report page has a **Flags** section (the app's policy checks plus issues raised in review, often by Claude) and a **Conversation** thread; the approval queue shows both as chips.

On every dashboard the **Approved** and **Pending** boxes are toggles: switch one off to filter all spend tables and report lists to the other.

Policy checks run in the app on every save: meals over ₹1,500/item, hotels over ₹8,000/night, anything over ₹50,000 (needs finance pre-approval), and future dates.

## 5-minute demo script
1. **Arjun (Claude):** paste 3–4 receipts or bank SMS → *"File these as my Pune trip expenses and submit."* → open the link: the report is in the app, tagged **via Claude**, with a policy flag on the expensive dinner.
2. **Arjun (web):** fix one line in the app. The edit appears in the activity log.
3. **Ria (Claude):** *"What's waiting for my approval? Flag anything that looks off."* → Claude flags the expensive dinner and asks Arjun about it. Then *"Show my team's spend by department and by person."*
   **Arjun (Claude):** *"Did Ria ask anything? Tell her the client dinner ran late after landing."* → the reply appears in the report's Conversation.
4. **Ria (Claude):** *"What did the Middleware team spend?"* → **Access denied** from the app. Then *"Approve Arjun's Pune report."*
5. **Ashish (Claude):** *"Company spend by department this month"* → works. *"How much did Arjun spend?"* → **Access denied: finance sees department totals only.**
6. **Ashish (web):** the finance dashboard shows department, category and month totals, with no names.

## Why the economics work
Claimly runs no AI, so the expensive part (reading receipts) is paid for by the customer's own Claude subscription. Cost to serve is roughly hosting plus a database, a few rupees per user per month, so a ₹199–299/user/month price carries a gross margin of about 95%.

## Structure
```
src/server.js   Express app: web pages + MCP endpoint (/mcp/:token)
src/mcp.js      MCP tools (one server per request, bound to the link owner)
src/access.js   Guardrails: who can see/edit/approve what, scoped spend summaries
src/repo.js     Report and expense operations (all access-checked)
src/policy.js   Categories and policy limits
src/db.js       Postgres schema and demo seed data
src/views.js    Server-rendered HTML (no frontend build step)
```
