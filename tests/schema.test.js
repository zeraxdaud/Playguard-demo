import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../supabase/migrations/202608240001_payguard_v02.sql", import.meta.url), "utf8");

test("every tenant data table has RLS enabled", () => {
  for (const table of ["companies", "company_members", "company_invitations", "clients", "contracts", "payment_schedules", "payments", "audit_logs"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
});

test("tenant tables carry company_id and cross-tenant helper checks exist", () => {
  for (const table of ["company_members", "clients", "contracts", "payment_schedules", "payments", "audit_logs"]) {
    const start = sql.indexOf(`create table public.${table}`);
    const end = sql.indexOf(";", start);
    assert.match(sql.slice(start, end), /company_id uuid not null/i);
  }
  assert.match(sql, /is_company_member\(p_company_id uuid\)/);
  assert.match(sql, /can_write_company\(p_company_id uuid\)/);
});

test("privileged RPC functions validate the active role", () => {
  assert.match(sql, /create_company_invitation[\s\S]*can_manage_company_members/);
  assert.match(sql, /create_installment_contract[\s\S]*can_write_company/);
  assert.match(sql, /record_payment[\s\S]*can_write_company/);
  assert.match(sql, /protect_membership_changes[\s\S]*последнего владельца/);
});

test("invitation tokens are stored as hashes", () => {
  assert.match(sql, /token_hash text not null unique/);
  assert.match(sql, /digest\(v_token, 'sha256'\)/);
  assert.doesNotMatch(sql, /create table public\.company_invitations[\s\S]{0,500}\btoken text/);
});
