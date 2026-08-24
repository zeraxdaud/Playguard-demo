import { requireSupabase } from "./supabase.js";

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export const api = {
  async signIn(email, password) {
    return unwrap(await requireSupabase().auth.signInWithPassword({ email, password }));
  },

  async signUp({ email, password, fullName, companyName }) {
    return unwrap(
      await requireSupabase().auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, ...(companyName ? { company_name: companyName } : {}) },
          emailRedirectTo: window.location.href
        }
      })
    );
  },

  async signOut() {
    return unwrap(await requireSupabase().auth.signOut());
  },

  async context() {
    const db = requireSupabase();
    const { data: userData } = await db.auth.getUser();
    if (!userData.user) return null;
    const profile = unwrap(await db.from("profiles").select("id, full_name, email").eq("id", userData.user.id).single());
    const memberships = unwrap(
      await db
        .from("company_members")
        .select("id, company_id, role, status, companies(id, name, slug)")
        .eq("user_id", userData.user.id)
        .eq("status", "ACTIVE")
    );
    return { user: userData.user, profile, memberships };
  },

  async workspace(companyId) {
    const db = requireSupabase();
    unwrap(await db.rpc("refresh_company_overdues", { p_company_id: companyId }));
    const [clients, contracts, schedules, members] = await Promise.all([
      db.from("clients").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      db.from("contracts").select("*, clients(first_name,last_name)").eq("company_id", companyId).order("created_at", { ascending: false }),
      db.from("payment_schedules").select("*, contracts(contract_number, clients(first_name,last_name))").eq("company_id", companyId).order("due_date"),
      db.from("company_members").select("id,user_id,role,status,profiles(full_name,email)").eq("company_id", companyId).order("created_at")
    ]);
    return { clients: unwrap(clients), contracts: unwrap(contracts), schedules: unwrap(schedules), members: unwrap(members) };
  },

  async createClient(companyId, values) {
    return unwrap(await requireSupabase().from("clients").insert({ company_id: companyId, ...values }).select().single());
  },

  async createContract(values) {
    return unwrap(await requireSupabase().rpc("create_installment_contract", values));
  },

  async recordPayment({ scheduleId, amount, paidAt, note }) {
    return unwrap(
      await requireSupabase().rpc("record_payment", {
        p_schedule_id: scheduleId,
        p_amount: amount,
        p_paid_at: paidAt,
        p_note: note || null
      })
    );
  },

  async inviteMember({ companyId, email, role }) {
    return unwrap(
      await requireSupabase().rpc("create_company_invitation", {
        p_company_id: companyId,
        p_email: email,
        p_role: role
      })
    );
  },

  async changeRole({ membershipId, role }) {
    return unwrap(await requireSupabase().from("company_members").update({ role }).eq("id", membershipId).select().single());
  },

  async removeMember(membershipId) {
    return unwrap(await requireSupabase().from("company_members").delete().eq("id", membershipId));
  },

  async acceptInvitation(token) {
    return unwrap(await requireSupabase().rpc("accept_company_invitation", { p_token: token }));
  },

  async seedDemo(companyId) {
    return unwrap(await requireSupabase().rpc("seed_demo_data", { p_company_id: companyId }));
  }
};
