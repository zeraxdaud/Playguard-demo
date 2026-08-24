import test from "node:test";
import assert from "node:assert/strict";
import { can, dashboardMetrics, installments, overdueDays, ROLE } from "../src/core.js";

test("roles enforce the intended permission matrix", () => {
  assert.equal(can(ROLE.OWNER, "manage_company"), true);
  assert.equal(can(ROLE.ADMIN, "manage_members"), true);
  assert.equal(can(ROLE.MANAGER, "write"), true);
  assert.equal(can(ROLE.MANAGER, "manage_members"), false);
  assert.equal(can(ROLE.VIEWER, "read"), true);
  assert.equal(can(ROLE.VIEWER, "write"), false);
});

test("installment rounding preserves the exact principal remainder", () => {
  const amounts = installments({ principal: 100000, downPayment: 10000, count: 7 });
  assert.equal(amounts.length, 7);
  assert.equal(Number(amounts.reduce((sum, value) => sum + value, 0).toFixed(2)), 90000);
});

test("dashboard aggregates only unpaid schedule balances", () => {
  const metrics = dashboardMetrics({
    clients: [{}, {}],
    contracts: [{ status: "ACTIVE" }, { status: "COMPLETED" }],
    schedules: [
      { status: "OVERDUE", amount_due: 1000, amount_paid: 250 },
      { status: "PENDING", amount_due: 500, amount_paid: 0 },
      { status: "PAID", amount_due: 900, amount_paid: 900 }
    ]
  });
  assert.deepEqual(metrics, { clients: 2, activeContracts: 1, outstanding: 1250, overdueAmount: 750 });
});

test("overdue days never returns a negative number", () => {
  assert.equal(overdueDays("2026-08-20", new Date("2026-08-24T12:00:00Z")), 4);
  assert.equal(overdueDays("2026-08-30", new Date("2026-08-24T12:00:00Z")), 0);
});
