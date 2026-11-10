// Company expense policy. Plain rules, no AI: the app checks every line on save.

export const CATEGORIES = [
  'Travel',
  'Lodging',
  'Local transport',
  'Meals',
  'Software',
  'Training & Events',
  'Office supplies',
  'Other',
];

export const LIMITS = {
  mealPerItem: 1500,
  hotelPerNight: 8000,
  preApproval: 50000,
  financeApproval: 50000, // reports above this total need a second approval from Finance after the manager
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function policyFlag({ category, amount, spent_on }) {
  const flags = [];
  if (category === 'Meals' && amount > LIMITS.mealPerItem) flags.push(`Meal over ₹${LIMITS.mealPerItem.toLocaleString('en-IN')} limit`);
  if (category === 'Lodging' && amount > LIMITS.hotelPerNight) flags.push(`Hotel over ₹${LIMITS.hotelPerNight.toLocaleString('en-IN')}/night limit`);
  if (amount > LIMITS.preApproval) flags.push(`Over ₹${LIMITS.preApproval.toLocaleString('en-IN')}: needs finance approval`);
  if (spent_on > todayISO()) flags.push('Date is in the future');
  return flags.length ? flags.join('; ') : null;
}

// Issue types a reviewer (usually Claude, sometimes a person) can flag on a report.
// The app stores and shows flags; it never decides them itself.
export const FLAG_KINDS = {
  overspend: 'Overspending',
  date_mismatch: 'Date mismatch',
  amount_mismatch: 'Amount mismatch',
  duplicate: 'Possible duplicate',
  missing_receipt: 'Missing receipt',
  personal: 'Looks personal',
  other: 'Other',
};

export const PAYOUT_MODES = ['NEFT', 'IMPS', 'UPI', 'RTGS', 'Cheque', 'Cash'];

// Human-readable policy, shared by the web app and the get_policy MCP tool.
export function policySummary() {
  const r = (n) => `₹${n.toLocaleString('en-IN')}`;
  return {
    categories: CATEGORIES,
    limits: [
      `Meals: up to ${r(LIMITS.mealPerItem)} per item`,
      `Hotels: up to ${r(LIMITS.hotelPerNight)} per night (one line per night)`,
      `Any single line over ${r(LIMITS.preApproval)} needs finance approval`,
      'Expense dates cannot be in the future',
    ],
    approvals: [
      'Employee submits; their manager approves or rejects (a reason is required to reject).',
      `Reports totalling over ${r(LIMITS.financeApproval)} need a second approval from Finance after the manager.`,
      'A manager who is out of office can delegate approvals to another manager until a date.',
      'Editing a submitted report reopens it as "being revised"; it must be resubmitted before anyone can approve it.',
    ],
    payouts: `Approved claims are paid by Finance (${PAYOUT_MODES.join(', ')}); the employee sees the payment date and reference.`,
    note: 'Policy flags are warnings checked by the app on every save; they do not block submission.',
  };
}
