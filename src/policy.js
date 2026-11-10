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
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function policyFlag({ category, amount, spent_on }) {
  const flags = [];
  if (category === 'Meals' && amount > LIMITS.mealPerItem) flags.push(`Meal over ₹${LIMITS.mealPerItem.toLocaleString('en-IN')} limit`);
  if (category === 'Lodging' && amount > LIMITS.hotelPerNight) flags.push(`Hotel over ₹${LIMITS.hotelPerNight.toLocaleString('en-IN')}/night limit`);
  if (amount > LIMITS.preApproval) flags.push(`Over ₹${LIMITS.preApproval.toLocaleString('en-IN')}: needs finance pre-approval`);
  if (spent_on > todayISO()) flags.push('Date is in the future');
  return flags.length ? flags.join('; ') : null;
}
