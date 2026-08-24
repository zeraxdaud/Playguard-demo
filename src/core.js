export const ROLE = Object.freeze({
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  VIEWER: "VIEWER"
});

const permissions = {
  OWNER: new Set(["read", "write", "manage_members", "manage_company", "delete"]),
  ADMIN: new Set(["read", "write", "manage_members"]),
  MANAGER: new Set(["read", "write"]),
  VIEWER: new Set(["read"])
};

export function can(role, action) {
  return Boolean(permissions[role]?.has(action));
}

export function formatMoney(value, currency = "RUB") {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

export function fullName(client) {
  return [client.last_name, client.first_name, client.middle_name].filter(Boolean).join(" ");
}

export function todayISO(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function overdueDays(dueDate, now = new Date()) {
  const due = new Date(`${dueDate}T00:00:00`);
  const current = new Date(todayISO(now) + "T00:00:00");
  return Math.max(0, Math.floor((current - due) / 86400000));
}

export function dashboardMetrics({ clients = [], contracts = [], schedules = [] }) {
  const active = contracts.filter((item) => item.status === "ACTIVE");
  const overdue = schedules.filter((item) => item.status === "OVERDUE");
  const outstanding = schedules
    .filter((item) => item.status !== "PAID")
    .reduce((sum, item) => sum + Number(item.amount_due) - Number(item.amount_paid || 0), 0);
  const overdueAmount = overdue.reduce(
    (sum, item) => sum + Number(item.amount_due) - Number(item.amount_paid || 0),
    0
  );
  return { clients: clients.length, activeContracts: active.length, outstanding, overdueAmount };
}

export function installments({ principal, downPayment = 0, count }) {
  const remainder = Math.max(0, Number(principal) - Number(downPayment));
  const n = Math.max(1, Number(count));
  const base = Math.floor((remainder / n) * 100) / 100;
  return Array.from({ length: n }, (_, index) =>
    index === n - 1 ? Number((remainder - base * (n - 1)).toFixed(2)) : base
  );
}

export function riskLevel(score) {
  if (score <= 34) return "LOW";
  if (score <= 64) return "MEDIUM";
  return "HIGH";
}

export function calculateRiskScore({ requestedAmount, downPayment = 0, termMonths, monthlyIncome, existingMonthlyObligations = 0, activeInstallments = 0, maxOverdueDays = 0 }) {
  const monthlyPayment = (requestedAmount - downPayment) / termMonths;
  const burden = (monthlyPayment + existingMonthlyObligations) / monthlyIncome;
  const downRatio = downPayment / requestedAmount;
  let score = 10;
  score += burden >= 0.7 ? 45 : burden >= 0.5 ? 30 : burden >= 0.35 ? 18 : 5;
  score += downRatio < 0.1 ? 15 : downRatio < 0.2 ? 8 : downRatio >= 0.35 ? -5 : 0;
  score += maxOverdueDays >= 90 ? 30 : maxOverdueDays >= 30 ? 20 : maxOverdueDays >= 7 ? 10 : 0;
  score += activeInstallments >= 3 ? 10 : activeInstallments >= 1 ? 4 : 0;
  score = Math.max(0, Math.min(100, score));
  return { score, level: riskLevel(score), monthlyPayment, burden };
}
