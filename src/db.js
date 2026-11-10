import pg from 'pg';
import { hashPassword, newToken } from './auth.js';
import { policyFlag } from './policy.js';

// Keep DATE as 'YYYY-MM-DD' strings and NUMERIC as JS numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Create a free Postgres (Neon or Supabase) and set DATABASE_URL.');
  process.exit(1);
}
const isLocal = /localhost|127\.0\.0\.1/.test(url);

export const pool = new pg.Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('employee','manager','finance')),
  department    TEXT NOT NULL,
  title         TEXT,
  manager_id    INTEGER REFERENCES users(id),
  mcp_token     TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS reports (
  id            SERIAL PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','revising','approved','rejected')),
  created_via   TEXT NOT NULL DEFAULT 'web',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at  TIMESTAMPTZ,
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT
);
CREATE TABLE IF NOT EXISTS expenses (
  id          SERIAL PRIMARY KEY,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  spent_on    DATE NOT NULL,
  merchant    TEXT NOT NULL,
  category    TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  gst         NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes       TEXT,
  policy_flag TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id        SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actor_id  INTEGER REFERENCES users(id),
  via       TEXT NOT NULL,
  action    TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flags (
  id          SERIAL PRIMARY KEY,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  expense_id  INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  raised_by   INTEGER REFERENCES users(id),
  via         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution  TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  via        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flags_report ON flags(report_id);
CREATE INDEX IF NOT EXISTS idx_comments_report ON comments(report_id);
CREATE INDEX IF NOT EXISTS idx_expenses_report ON expenses(report_id);
CREATE INDEX IF NOT EXISTS idx_reports_owner ON reports(owner_id);
`;

export async function insertExpense(client, reportId, e) {
  const flag = policyFlag(e);
  const { rows } = await client.query(
    `INSERT INTO expenses (report_id, spent_on, merchant, category, amount, gst, notes, policy_flag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [reportId, e.spent_on, e.merchant, e.category, e.amount, e.gst || 0, e.notes || null, flag]
  );
  return rows[0].id;
}

export async function logActivity(client, reportId, actorId, via, action) {
  await client.query(`INSERT INTO activity (report_id, actor_id, via, action) VALUES ($1,$2,$3,$4)`, [reportId, actorId, via, action]);
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const PW = () => hashPassword(process.env.DEMO_PASSWORD || 'demo1234');
const seedUser = async (u, pw = PW()) =>
  (await q(
    `INSERT INTO users (name, email, password_hash, role, department, title, manager_id, mcp_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [u.name, u.email, pw, u.role, u.department, u.title, u.manager_id || null, newToken()]
  )).rows[0].id;
const seedReport = async (owner, title, status, decider, items) => {
  const submitted = status === 'draft' ? null : new Date();
  const decided = decider ? new Date() : null;
  const id = (await q(
    `INSERT INTO reports (owner_id, title, status, created_via, submitted_at, decided_by, decided_at)
     VALUES ($1,$2,$3,'seed',$4,$5,$6) RETURNING id`,
    [owner, title, status, submitted, decider || null, decided]
  )).rows[0].id;
  for (const it of items) await insertExpense(pool, id, it);
  await logActivity(pool, id, owner, 'seed', `Demo report created with ${items.length} expenses`);
  if (decider) await logActivity(pool, id, decider, 'seed', `Report ${status}`);
};

export async function initDb() {
  await q(SCHEMA);
  // 'revising' = submitted, then reopened by the employee: the manager can see it but not approve it until it is resubmitted.
  await q(`ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_status_check;
           ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('draft','submitted','revising','approved','rejected'))`);
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) await seedCompany();
  await ensureSecondMiddlewareEngineer();
}

// Middleware needs at least two people, otherwise Finance's "Middleware" department total
// is really one person's spend. Added on startup if missing, so existing databases get her too.
async function ensureSecondMiddlewareEngineer() {
  if ((await q(`SELECT 1 FROM users WHERE email='divya@claimly.demo'`)).rows.length) return;
  const vikram = (await q(`SELECT id FROM users WHERE email='vikram@claimly.demo'`)).rows[0];
  if (!vikram) return;
  const divya = await seedUser({ name: 'Divya Nair', email: 'divya@claimly.demo', role: 'employee', department: 'Middleware', title: 'Middleware Engineer', manager_id: vikram.id });
  await seedReport(divya, 'Chennai partner API integration', 'submitted', null, [
    { spent_on: daysAgo(6), merchant: 'IndiGo BLR→MAA', category: 'Travel', amount: 4200, gst: 210 },
    { spent_on: daysAgo(6), merchant: 'ITC Grand Chola (1 night)', category: 'Lodging', amount: 7600, gst: 912 },
    { spent_on: daysAgo(5), merchant: 'Working lunch, Saravana Bhavan', category: 'Meals', amount: 640 },
  ]);
  await seedReport(divya, 'Kafka meetup Bengaluru', 'approved', vikram.id, [
    { spent_on: daysAgo(18), merchant: 'Kafka Summit Meetup ticket', category: 'Training & Events', amount: 3500, gst: 630 },
    { spent_on: daysAgo(18), merchant: 'Namma Yatri to venue', category: 'Local transport', amount: 380 },
  ]);
  console.log('Added Divya Nair (Middleware) to the demo company.');
}

async function seedCompany() {
  console.log('Empty database: seeding demo company...');
  const pw = PW();
  const user = (u) => seedUser(u, pw);
  const report = seedReport;

  const ria = await user({ name: 'Ria Sharma', email: 'ria@claimly.demo', role: 'manager', department: 'Engineering', title: 'Engineering Manager (UI & Backend)' });
  const vikram = await user({ name: 'Vikram Rao', email: 'vikram@claimly.demo', role: 'manager', department: 'Middleware', title: 'Middleware Lead' });
  const arjun = await user({ name: 'Arjun Menon', email: 'arjun@claimly.demo', role: 'employee', department: 'UI', title: 'UI Engineer', manager_id: ria });
  const neha = await user({ name: 'Neha Iyer', email: 'neha@claimly.demo', role: 'employee', department: 'Backend', title: 'Backend Engineer', manager_id: ria });
  const karan = await user({ name: 'Karan Patel', email: 'karan@claimly.demo', role: 'employee', department: 'Middleware', title: 'Middleware Engineer', manager_id: vikram });
  await user({ name: 'Ashish Verma', email: 'ashish@claimly.demo', role: 'finance', department: 'Finance', title: 'Finance Controller' });

  await report(arjun, 'Mumbai client workshop', 'submitted', null, [
    { spent_on: daysAgo(12), merchant: 'IndiGo BLR→BOM', category: 'Travel', amount: 6850, gst: 342 },
    { spent_on: daysAgo(12), merchant: 'Uber, BOM airport to Andheri', category: 'Local transport', amount: 640 },
    { spent_on: daysAgo(12), merchant: 'Hotel Sahara Star (night 1)', category: 'Lodging', amount: 5600, gst: 672 },
    { spent_on: daysAgo(11), merchant: 'Hotel Sahara Star (night 2)', category: 'Lodging', amount: 5600, gst: 672 },
    { spent_on: daysAgo(11), merchant: 'Client dinner, Bastian', category: 'Meals', amount: 2150, gst: 108, notes: 'Dinner with 2 client stakeholders' },
    { spent_on: daysAgo(10), merchant: 'IndiGo BOM→BLR', category: 'Travel', amount: 5900, gst: 295 },
  ]);
  await report(arjun, 'Figma seat renewal', 'approved', ria, [
    { spent_on: daysAgo(25), merchant: 'Figma Professional (1 seat)', category: 'Software', amount: 1250 },
  ]);
  await report(neha, 'AWS Summit Bengaluru', 'approved', ria, [
    { spent_on: daysAgo(20), merchant: 'AWS Summit pass', category: 'Training & Events', amount: 14999, gst: 2288 },
    { spent_on: daysAgo(20), merchant: 'Rapido to venue', category: 'Local transport', amount: 420 },
    { spent_on: daysAgo(20), merchant: 'Lunch, Truffles', category: 'Meals', amount: 680 },
  ]);
  await report(neha, 'Database tooling: November', 'draft', null, [
    { spent_on: daysAgo(3), merchant: 'JetBrains DataGrip licence', category: 'Software', amount: 8900, gst: 1358 },
  ]);
  await report(karan, 'Hyderabad vendor visit', 'submitted', null, [
    { spent_on: daysAgo(8), merchant: 'Air India BLR→HYD', category: 'Travel', amount: 5400, gst: 270 },
    { spent_on: daysAgo(8), merchant: 'Lemon Tree Hitec City', category: 'Lodging', amount: 4800, gst: 576 },
    { spent_on: daysAgo(8), merchant: 'Team lunch with vendor', category: 'Meals', amount: 1100 },
    { spent_on: daysAgo(7), merchant: 'Ola, Hitec City to airport', category: 'Local transport', amount: 900 },
  ]);
  await report(karan, 'Kafka training course', 'approved', vikram, [
    { spent_on: daysAgo(28), merchant: 'Confluent training voucher', category: 'Training & Events', amount: 12000, gst: 2160 },
  ]);
  console.log('Seed complete.');
}
