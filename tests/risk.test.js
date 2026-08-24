import test from "node:test";
import assert from "node:assert/strict";
import { calculateRiskScore } from "../src/core.js";

test("low-risk case rewards a strong down payment and low burden", () => {
  const result = calculateRiskScore({ requestedAmount: 100000, downPayment: 40000, termMonths: 10, monthlyIncome: 100000 });
  assert.deepEqual({ score: result.score, level: result.level }, { score: 10, level: "LOW" });
});

test("high burden and severe overdue history produce high risk", () => {
  const result = calculateRiskScore({ requestedAmount: 150000, downPayment: 0, termMonths: 3, monthlyIncome: 70000, existingMonthlyObligations: 15000, activeInstallments: 3, maxOverdueDays: 120 });
  assert.deepEqual({ score: result.score, level: result.level }, { score: 100, level: "HIGH" });
});

test("risk migration uses tenant RLS and server-side role checks", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../supabase/migrations/202608240003_risk_checks.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.risk_checks enable row level security/i);
  assert.match(sql, /public\.is_company_member\(company_id\)/);
  assert.match(sql, /public\.can_write_company\(p_company_id\)/);
  assert.match(sql, /foreign key \(client_id, company_id\)/);
});
