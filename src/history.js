// Demo history: ~15 months of past expense reports so trends are visible (by month, quarter,
// department, category; budgets, compliance, KPIs, GST). Generated once, deterministically, on startup.
//
// Built-in trends:
//   - Middleware spend grows steadily (the team is doing more vendor visits); recent quarters run hot.
//   - UI travel peaks in Oct-Dec (client season).
//   - Backend training & events cluster in Apr-Jun (conference season).
//   - Policy breaches fall over time (compliance improves).
//   - Approval and payout turnaround improve (about a week down to 2-3 days).
//   - A few rejections and sent-back reports; large offsites go through Finance's second approval.

import { insertExpense, logActivity } from './db.js';

const MONTHS_BACK = 15;

// Small deterministic PRNG so every database gets the same history.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = ['Mumbai', 'Pune', 'Hyderabad', 'Chennai', 'Delhi', 'Kolkata', 'Ahmedabad', 'Kochi'];
const AIR = ['IndiGo', 'Air India', 'Akasa Air', 'Air India Express'];
const HOTELS = ['Lemon Tree', 'Ibis', 'Novotel', 'ITC Fortune', 'Taj Vivanta', 'Radisson', 'FabHotel'];
const CABS = ['Uber', 'Ola', 'Rapido', 'BluSmart'];
const FOOD = ['Truffles', 'Saravana Bhavan', 'Haldiram\'s', 'Social', 'Barbeque Nation', 'Mainland China', 'Paradise Biryani'];
const SOFTWARE = ['Figma', 'JetBrains', 'GitHub Copilot', 'Postman', 'Datadog', 'Notion', 'Miro', 'Confluent Cloud'];
const EVENTS = ['AWS Summit', 'JSConf India', 'GopherCon India', 'Kafka Summit meetup', 'PyCon India', 'React India', 'DevOpsDays'];

const DEPT = { UI: 'UI', Backend: 'Backend', Middleware: 'Middleware' };

export async function ensureDemoHistory(q, pool, users) {
  if ((await q(`SELECT 1 FROM reports WHERE created_via = 'history' LIMIT 1`)).rows.length) return;
  const need = ['arjun', 'neha', 'karan', 'divya', 'ria', 'vikram', 'ashish'];
  if (!need.every((k) => users[k])) return;
  const r = rng(20261111);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const between = (lo, hi) => Math.round((lo + r() * (hi - lo)) / 10) * 10;

  const now = new Date();
  const dayIso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

  const employees = [
    { u: users.arjun, dept: DEPT.UI, mgr: users.ria },
    { u: users.neha, dept: DEPT.Backend, mgr: users.ria },
    { u: users.karan, dept: DEPT.Middleware, mgr: users.vikram },
    { u: users.divya, dept: DEPT.Middleware, mgr: users.vikram },
  ];

  const client = await pool.connect();
  let reports = 0;
  try {
    await client.query('BEGIN');
    for (let mb = MONTHS_BACK; mb >= 1; mb--) {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - mb, 1));
      const calMonth = monthStart.getUTCMonth() + 1; // 1-12
      const age = (mb - 1) / (MONTHS_BACK - 1); // 1 = oldest, 0 = most recent
      const breachChance = 0.12 + 0.3 * age; // compliance improves over time
      const approveLag = () => Math.max(1, Math.round(2 + 5 * age + r() * 2)); // ~7 days -> ~2 days
      const payLag = () => Math.max(1, Math.round(3 + 8 * age + r() * 3)); // ~11 days -> ~3 days

      for (const emp of employees) {
        // Monthly spend target per person, which is what makes the trends visible:
        //   UI peaks in Oct-Dec, Backend in Apr-Jun, Middleware grows steadily (₹9k -> ₹24k per person).
        const target = emp.dept === DEPT.UI ? ([10, 11, 12].includes(calMonth) ? 62000 : 28000)
          : emp.dept === DEPT.Backend ? ([4, 5, 6].includes(calMonth) ? 52000 : 26000)
          : 9000 + 15000 * (1 - age);
        let spent = 0;
        for (let k = 0; spent < target * 0.9 && k < 5; k++) {
          const day = 3 + Math.floor(r() * 20);
          const start = addDays(monthStart, day - 1);
          const city = pick(CITIES);
          let kind;
          if (emp.dept === DEPT.Backend && [4, 5, 6].includes(calMonth) && k === 0) kind = 'event';
          else if (emp.dept === DEPT.UI && [10, 11, 12].includes(calMonth)) kind = 'trip';
          else kind = pick(emp.dept === DEPT.Middleware ? ['trip', 'trip', 'local', 'software'] : ['trip', 'trip', 'trip', 'local', 'software', 'event', 'office']);

          const lines = [];
          let title;
          const meal = (d) => {
            const breach = r() < breachChance;
            const amount = breach ? between(1600, 2600) : between(350, 1400);
            lines.push({ spent_on: dayIso(d), merchant: `${breach ? 'Client dinner' : 'Meal'}, ${pick(FOOD)}`, category: 'Meals', amount, gst: Math.round(amount * 0.05), notes: breach ? 'With client team' : null });
          };
          if (kind === 'trip') {
            const nights = 1 + Math.floor(r() * 3);
            const scale = emp.dept === DEPT.Middleware ? 0.7 + 0.5 * (1 - age) : 1; // Middleware trips get bigger
            title = `${city} ${emp.dept === DEPT.Middleware ? 'vendor visit' : 'client visit'}`;
            const fare = between(3800, 8200) * scale;
            lines.push({ spent_on: dayIso(start), merchant: `${pick(AIR)} BLR→${city.slice(0, 3).toUpperCase()}`, category: 'Travel', amount: Math.round(fare), gst: Math.round(fare * 0.05) });
            for (let i = 0; i < nights; i++) {
              const breach = r() < breachChance * 0.6;
              const rate = breach ? between(8200, 9800) : between(3800, 7800);
              lines.push({ spent_on: dayIso(addDays(start, i)), merchant: `${pick(HOTELS)} ${city} (night ${i + 1})`, category: 'Lodging', amount: rate, gst: Math.round(rate * 0.12) });
            }
            lines.push({ spent_on: dayIso(start), merchant: `${pick(CABS)}, airport to ${city} office`, category: 'Local transport', amount: between(350, 1100) });
            meal(addDays(start, 1));
            const back = between(3800, 8200) * scale;
            lines.push({ spent_on: dayIso(addDays(start, nights)), merchant: `${pick(AIR)} ${city.slice(0, 3).toUpperCase()}→BLR`, category: 'Travel', amount: Math.round(back), gst: Math.round(back * 0.05) });
          } else if (kind === 'event') {
            const ev = pick(EVENTS);
            title = `${ev} ${monthStart.getUTCFullYear()}`;
            const season = emp.dept === DEPT.Backend && [4, 5, 6].includes(calMonth); // conference season: bigger events
            const pass = season ? between(18000, 34000) : between(6000, 18000);
            lines.push({ spent_on: dayIso(start), merchant: `${ev} pass`, category: 'Training & Events', amount: pass, gst: Math.round(pass * 0.18) });
            lines.push({ spent_on: dayIso(start), merchant: `${pick(CABS)} to venue`, category: 'Local transport', amount: between(250, 700) });
            meal(start);
          } else if (kind === 'software') {
            const tool = pick(SOFTWARE);
            title = `${tool} subscription`;
            const fee = between(1200, 9500);
            lines.push({ spent_on: dayIso(start), merchant: `${tool} (annual seat)`, category: 'Software', amount: fee, gst: Math.round(fee * 0.18) });
          } else if (kind === 'office') {
            title = 'Home office supplies';
            const amt = between(900, 4200);
            lines.push({ spent_on: dayIso(start), merchant: pick(['Amazon: keyboard and mouse', 'Croma: USB-C dock', 'Amazon: monitor arm', 'Reliance Digital: headset']), category: 'Office supplies', amount: amt, gst: Math.round(amt * 0.18) });
          } else {
            title = `Local travel, ${monthStart.toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' })}`;
            for (let i = 0; i < 3; i++) lines.push({ spent_on: dayIso(addDays(start, i * 3)), merchant: `${pick(CABS)}, client office`, category: 'Local transport', amount: between(180, 650) });
            meal(addDays(start, 2));
          }

          // Lifecycle: submitted after the last expense; most approved and paid; a few rejected or sent back.
          const lastDay = lines.map((l) => l.spent_on).sort().at(-1);
          const submitted = addDays(new Date(`${lastDay}T10:30:00Z`), 1 + Math.floor(r() * 3));
          const roll = r();
          const sentBack = roll < 0.1;
          const rejected = !sentBack && roll < 0.16;
          const decided = addDays(submitted, approveLag() + (sentBack ? 2 : 0));
          if (decided > now) continue; // keep history strictly in the past
          const paidOn = addDays(decided, payLag());
          const status = rejected ? 'rejected' : 'approved';
          const isPaid = status === 'approved' && paidOn < addDays(now, -1);
          const mode = pick(['NEFT', 'NEFT', 'IMPS', 'UPI']);

          const id = (await client.query(
            `INSERT INTO reports (owner_id, title, status, created_via, created_at, updated_at, submitted_at, decided_by, decided_at, decision_note,
                                  manager_approved_by, manager_approved_at, paid_on, paid_mode, paid_ref, paid_by, paid_recorded_at)
             VALUES ($1,$2,$3,'history',$4,$5,$6,$7,$5,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
            [emp.u, title, status, submitted, decided, submitted, emp.mgr,
              rejected ? pick(['Missing hotel invoice; please attach and resubmit.', 'Personal expense included; please remove it.', 'Duplicate of an earlier claim.']) : null,
              status === 'approved' ? emp.mgr : null, status === 'approved' ? decided : null,
              isPaid ? dayIso(paidOn) : null, isPaid ? mode : null,
              isPaid ? `UTR${Math.floor(1e11 + r() * 9e11)}` : null, isPaid ? users.ashish : null, isPaid ? paidOn : null]
          )).rows[0].id;
          for (const l of lines) await insertExpense(client, id, l);
          const at = (d, action, actor = emp.u) => client.query(
            `INSERT INTO activity (report_id, actor_id, via, action, at) VALUES ($1,$2,$3,$4,$5)`,
            [id, actor, r() < 0.55 ? 'claude' : 'web', action, d]
          );
          await at(submitted, `Created report with ${lines.length} expense${lines.length === 1 ? '' : 's'}`);
          await at(submitted, 'Submitted for approval');
          if (sentBack) {
            await at(addDays(submitted, 1), 'Reopened for editing (approval paused until resubmitted)');
            await at(addDays(submitted, 2), 'Resubmitted for approval');
          }
          if (r() < 0.12) {
            await client.query(
              `INSERT INTO flags (report_id, kind, message, raised_by, via, created_at, resolved_by, resolved_at, resolution) VALUES ($1,$2,$3,$4,'claude',$5,$4,$6,$7)`,
              [id, pick(['date_mismatch', 'amount_mismatch', 'missing_receipt']), 'Receipt date or amount did not match the bank SMS.', emp.mgr, addDays(submitted, 1), decided, 'Explained by the employee']
            );
          }
          await at(decided, rejected ? 'Rejected' : 'Approved', emp.mgr);
          if (isPaid) await at(paidOn, `Paid via ${mode} on ${dayIso(paidOn)}`, users.ashish);
          spent += lines.reduce((t, l) => t + l.amount, 0);
          reports++;
        }
      }

      // Yearly team offsites (over ₹50,000, so they went through Finance's second approval):
      // UI in October, Backend in May, Middleware in February.
      const offsites = { 10: [employees[0], 'UI'], 5: [employees[1], 'Backend'], 2: [employees[2], 'Middleware'] };
      if (offsites[calMonth]) {
        for (const [emp, label] of [offsites[calMonth]]) {
          const start = addDays(monthStart, 8 + Math.floor(r() * 8));
          const lines = [
            { spent_on: dayIso(start), merchant: `${pick(['Coorg', 'Ooty', 'Goa', 'Alibaug'])} resort: ${label} offsite`, category: 'Training & Events', amount: between(32000, 46000), gst: 0 },
            { spent_on: dayIso(start), merchant: 'Coach hire (return)', category: 'Travel', amount: between(9000, 14000) },
            { spent_on: dayIso(addDays(start, 1)), merchant: 'Team dinner at the resort', category: 'Meals', amount: between(7000, 11000) },
          ];
          lines[0].gst = Math.round(lines[0].amount * 0.18);
          const submitted = addDays(start, 3);
          const mgrAt = addDays(submitted, approveLag());
          const finAt = addDays(mgrAt, 1 + Math.floor(r() * 3));
          if (finAt > now) continue;
          const paidOn = addDays(finAt, payLag());
          const isPaid = paidOn < addDays(now, -1);
          const id = (await client.query(
            `INSERT INTO reports (owner_id, title, status, created_via, created_at, updated_at, submitted_at, decided_by, decided_at,
                                  manager_approved_by, manager_approved_at, escalated_at, paid_on, paid_mode, paid_ref, paid_by, paid_recorded_at)
             VALUES ($1,$2,'approved','history',$3,$4,$3,$5,$4,$6,$7,$7,$8,$9,$10,$12,$11) RETURNING id`,
            [emp.u, `${label} team offsite`, submitted, finAt, users.ashish, emp.mgr, mgrAt,
              isPaid ? dayIso(paidOn) : null, isPaid ? 'NEFT' : null, isPaid ? `UTR${Math.floor(1e11 + r() * 9e11)}` : null, isPaid ? paidOn : null, isPaid ? users.ashish : null]
          )).rows[0].id;
          for (const l of lines) await insertExpense(client, id, l);
          await logActivity(client, id, emp.u, 'web', 'Created report with 3 expenses');
          await client.query(`UPDATE activity SET at = $2 WHERE report_id = $1`, [id, submitted]);
          await client.query(`INSERT INTO activity (report_id, actor_id, via, action, at) VALUES ($1,$2,'web','Approved by manager. Over ₹50,000, so sent to Finance for second approval',$3),
                              ($1,$4,'web','Approved by Finance (second approval)',$5)`, [id, emp.mgr, mgrAt, users.ashish, finAt]);
          if (isPaid) await client.query(`INSERT INTO activity (report_id, actor_id, via, action, at) VALUES ($1,$2,'web',$3,$4)`, [id, users.ashish, `Paid via NEFT on ${dayIso(paidOn)}`, paidOn]);
          reports++;
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`Added ${reports} historical demo reports (${MONTHS_BACK} months).`);
}
