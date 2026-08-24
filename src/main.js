import "./styles.css";
import { api } from "./api.js";
import { configured, supabase } from "./supabase.js";
import { can, dashboardMetrics, formatMoney, fullName, ROLE, todayISO } from "./core.js";

const root = document.querySelector("#app");
const state = {
  loading: true,
  authMode: "login",
  context: null,
  companyId: sessionStorage.getItem("payguard_company_id"),
  data: { clients: [], contracts: [], schedules: [], members: [], riskChecks: [] },
  view: "dashboard",
  modal: null,
  message: null
};

let realtimeChannel = null;
let realtimeTimer = null;

const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const currentMembership = () => state.context?.memberships.find((item) => item.company_id === state.companyId) || state.context?.memberships[0];
const currentCompany = () => currentMembership()?.companies;
const currentRole = () => currentMembership()?.role || ROLE.VIEWER;
const notify = (text, error = false) => { state.message = { text, error }; render(); };

function loading() {
  root.innerHTML = `<main class="loading"><div><div class="spinner"></div>Загружаем общую базу…</div></main>`;
}

function authScreen() {
  const hasInvitation = Boolean(new URLSearchParams(location.search).get("invite"));
  root.innerHTML = `
    <main class="auth">
      <section class="auth-card card">
        <div class="auth-logo brand"><div class="brand-mark">P</div><div>PayGuard<small>shared workspace · v0.2</small></div></div>
        <span class="eyebrow">Рассрочки под контролем</span>
        <h1>${state.authMode === "login" ? "С возвращением" : hasInvitation ? "Примите приглашение" : "Создайте компанию"}</h1>
        <p>${state.authMode === "login" ? "Войдите, чтобы открыть общую базу вашей команды." : hasInvitation ? "Зарегистрируйтесь с email, на который владелец создал приглашение." : "Первый пользователь станет владельцем нового рабочего пространства."}</p>
        ${!configured ? `<div class="notice error">Supabase пока не настроен. Создайте <b>.env</b> по примеру из репозитория.</div>` : ""}
        ${state.message ? `<div class="notice ${state.message.error ? "error" : ""}">${esc(state.message.text)}</div>` : ""}
        <div class="auth-tabs">
          <button data-auth-tab="login" class="${state.authMode === "login" ? "active" : ""}">Войти</button>
          <button data-auth-tab="signup" class="${state.authMode === "signup" ? "active" : ""}">Регистрация</button>
        </div>
        <form id="auth-form" class="form">
          ${state.authMode === "signup" ? `
            <label>Ваше имя<input name="fullName" required autocomplete="name" placeholder="Алексей Смирнов"></label>
            ${hasInvitation ? "" : `<label>Название компании<input name="companyName" required placeholder="Демо Компания"></label>`}` : ""}
          <label>Email<input type="email" name="email" required autocomplete="email" placeholder="owner@example.com"></label>
          <label>Пароль<input type="password" name="password" required minlength="8" autocomplete="${state.authMode === "login" ? "current-password" : "new-password"}" placeholder="Минимум 8 символов"></label>
          <button class="button" ${!configured ? "disabled" : ""}>${state.authMode === "login" ? "Открыть PayGuard" : "Создать аккаунт"}</button>
        </form>
      </section>
    </main>`;

  root.querySelectorAll("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => {
    state.authMode = button.dataset.authTab;
    state.message = null;
    render();
  }));
  root.querySelector("#auth-form")?.addEventListener("submit", handleAuth);
}

async function handleAuth(event) {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget));
  try {
    state.loading = true; render();
    if (state.authMode === "login") {
      await api.signIn(form.email, form.password);
    } else {
      const result = await api.signUp(form);
      if (!result.session) {
        state.loading = false;
        state.message = { text: "Проверьте почту и подтвердите регистрацию, затем войдите.", error: false };
        state.authMode = "login";
        render();
        return;
      }
    }
    await bootstrap();
  } catch (error) {
    state.loading = false;
    state.message = { text: error.message, error: true };
    render();
  }
}

function nav() {
  const items = [
    ["dashboard", "⌂", "Главная"], ["clients", "♙", "Клиенты"], ["contracts", "▤", "Договоры"],
    ["payments", "₽", "Платежи"], ["risk", "◇", "Проверка"], ["team", "♧", "Команда"]
  ];
  return `<nav class="nav">${items.map(([id, icon, label]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}"><span>${icon}</span>${label}</button>`).join("")}</nav>`;
}

function dashboard() {
  const metrics = dashboardMetrics(state.data);
  const overdue = state.data.schedules.filter((item) => item.status === "OVERDUE").slice(0, 5);
  return `
    <span class="eyebrow">Обзор портфеля</span>
    <h1>Деньги — в фокусе</h1>
    <p>${esc(currentCompany()?.name)} · данные обновляются для всей команды</p>
    <div class="grid stats">
      <article class="card stat"><span>Клиентов</span><strong>${metrics.clients}</strong></article>
      <article class="card stat"><span>Активных договоров</span><strong>${metrics.activeContracts}</strong></article>
      <article class="card stat"><span>Остаток портфеля</span><strong>${formatMoney(metrics.outstanding)}</strong></article>
      <article class="card stat danger"><span>Просрочено</span><strong>${formatMoney(metrics.overdueAmount)}</strong></article>
    </div>
    <div class="section-head"><h2>Требуют внимания</h2><button class="button secondary" data-view="payments">Все платежи</button></div>
    ${overdue.length ? `<div class="list">${overdue.map(paymentItem).join("")}</div>` : `<div class="empty">Просрочек нет. Отличное начало дня.</div>`}`;
}

function clientsView() {
  return `
    <div class="section-head"><div><span class="eyebrow">CRM</span><h1>Клиенты</h1></div>${can(currentRole(), "write") ? `<button class="button" data-modal="client">+ Добавить</button>` : ""}</div>
    <p>${can(currentRole(), "write") ? "Клиент сразу появится у всех сотрудников компании." : "У вас доступ только для просмотра."}</p>
    ${state.data.clients.length ? `<div class="list">${state.data.clients.map((client) => `
      <article class="list-item"><div class="main"><strong>${esc(fullName(client))}</strong><small>${esc(client.phone || "Телефон не указан")} · ${esc(client.email || "email не указан")}</small></div><span class="pill">${esc(client.status)}</span></article>`).join("")}</div>` : `<div class="empty">Пока нет клиентов. Добавьте первого.</div>`}`;
}

function contractsView() {
  return `
    <div class="section-head"><div><span class="eyebrow">Портфель</span><h1>Договоры</h1></div>${can(currentRole(), "write") ? `<button class="button" data-modal="contract" ${state.data.clients.length ? "" : "disabled"}>+ Договор</button>` : ""}</div>
    <p>График платежей создаётся атомарно в базе — договор не останется без платежей.</p>
    ${state.data.contracts.length ? `<div class="list">${state.data.contracts.map((contract) => `
      <article class="list-item"><div class="main"><strong>№ ${esc(contract.contract_number)}</strong><small>${esc([contract.clients?.last_name, contract.clients?.first_name].filter(Boolean).join(" "))} · ${esc(contract.status)}</small></div><div class="amount"><b>${formatMoney(contract.principal_amount)}</b><small>${contract.installment_count} платежей</small></div></article>`).join("")}</div>` : `<div class="empty">Договоров пока нет.</div>`}`;
}

function paymentItem(item) {
  const client = item.contracts?.clients;
  const remainder = Number(item.amount_due) - Number(item.amount_paid || 0);
  return `<article class="list-item"><div class="main"><strong>${esc(client ? `${client.last_name} ${client.first_name}` : item.contracts?.contract_number)}</strong><small>до ${new Date(item.due_date + "T00:00:00").toLocaleDateString("ru-RU")} · ${esc(item.status)}</small></div><div class="amount"><b>${formatMoney(remainder)}</b>${can(currentRole(), "write") && item.status !== "PAID" ? `<button class="button secondary" data-pay="${item.id}">Оплатить</button>` : ""}</div></article>`;
}

function paymentsView() {
  return `
    <div class="section-head"><div><span class="eyebrow">График</span><h1>Платежи</h1></div></div>
    <p>Частичная или полная оплата фиксируется в общем журнале и сразу обновляет остаток.</p>
    ${state.data.schedules.length ? `<div class="list">${state.data.schedules.map(paymentItem).join("")}</div>` : `<div class="empty">Создайте договор — здесь появится график.</div>`}`;
}

function riskLabel(level) {
  return ({ LOW: "Низкий", MEDIUM: "Средний", HIGH: "Высокий" })[level] || level;
}

function riskView() {
  const checks = state.data.riskChecks || [];
  const latest = checks[0];
  return `
    <div class="section-head"><div><span class="eyebrow">Decision support</span><h1>Проверка риска</h1></div>${can(currentRole(), "write") ? `<button class="button" data-modal="risk">+ Проверить</button>` : ""}</div>
    <p>Внутренний ориентировочный скоринг по заявленным данным. Это не отчёт БКИ и не автоматическое решение.</p>
    ${latest ? `<article class="card risk-hero ${latest.level.toLowerCase()}">
      <div><span class="eyebrow">Последняя проверка</span><h2>${esc(latest.candidate_name)}</h2><p>${esc(latest.recommendation)}</p></div>
      <div class="risk-score"><strong>${latest.score}</strong><span>/ 100 · ${riskLabel(latest.level)} риск</span></div>
    </article>` : ""}
    <div class="section-head"><h2>История проверок</h2></div>
    ${checks.length ? `<div class="list">${checks.map((check) => `<article class="list-item"><div class="main"><strong>${esc(check.candidate_name)}</strong><small>${new Date(check.created_at).toLocaleDateString("ru-RU")} · нагрузка ${Math.round(Number(check.payment_burden_ratio) * 100)}% · платёж ${formatMoney(check.estimated_monthly_payment)}</small></div><div class="amount"><b class="risk-number ${check.level.toLowerCase()}">${check.score}</b><span class="pill risk-${check.level.toLowerCase()}">${riskLabel(check.level)}</span></div></article>`).join("")}</div>` : `<div class="empty">Проверок пока нет. Создайте первую тестовую оценку.</div>`}`;
}

function teamView() {
  return `
    <span class="eyebrow">Доступ</span><h1>Команда</h1>
    <article class="card company-card"><div class="company-icon">⌂</div><div><strong>${esc(currentCompany()?.name)}</strong><small class="muted">Ваша роль: ${esc(currentRole())}</small></div></article>
    <div class="section-head"><h2>Сотрудники</h2>${can(currentRole(), "manage_members") ? `<button class="button" data-modal="invite">+ Пригласить</button>` : ""}</div>
    <div class="list">${state.data.members.map((member) => {
      const profile = member.profiles;
      const self = member.user_id === state.context.user.id;
      return `<article class="list-item"><div class="main"><strong>${esc(profile?.full_name || profile?.email || "Пользователь")}${self ? " · вы" : ""}</strong><small>${esc(profile?.email || "")}</small></div><div class="amount"><span class="pill ${member.role.toLowerCase()}">${member.role}</span>${can(currentRole(), "manage_members") && !self && member.role !== "OWNER" ? `<button class="icon-button" data-member="${member.id}" title="Изменить роль">⋯</button>` : ""}</div></article>`;
    }).join("")}</div>
    <div class="section-head"><h2>Компании</h2></div>
    <div class="toolbar">${state.context.memberships.map((membership) => `<button class="button ${membership.company_id === state.companyId ? "" : "secondary"}" data-company="${membership.company_id}">${esc(membership.companies.name)}</button>`).join("")}</div>
    ${["OWNER", "ADMIN"].includes(currentRole()) && state.data.clients.length === 0 ? `<div class="section-head"><div><h2>Демо-данные</h2><small class="muted">Только вымышленные записи</small></div><button class="button secondary" id="seed-demo">Загрузить демо</button></div>` : ""}
    <div class="section-head"><h2>Сессия</h2><button class="button danger" id="sign-out">Выйти</button></div>`;
}

function modal() {
  if (!state.modal) return "";
  let content = "";
  if (state.modal.type === "client") content = `
    <form class="form" id="client-form"><label>Фамилия<input name="last_name" required></label><label>Имя<input name="first_name" required></label><label>Отчество<input name="middle_name"></label><label>Телефон<input name="phone" inputmode="tel" placeholder="+7 900 000-00-00"></label><label>Email<input name="email" type="email"></label><button class="button">Сохранить клиента</button></form>`;
  if (state.modal.type === "contract") content = `
    <form class="form" id="contract-form"><label>Клиент<select name="p_client_id" required>${state.data.clients.map((c) => `<option value="${c.id}">${esc(fullName(c))}</option>`).join("")}</select></label><label>Номер договора<input name="p_contract_number" required value="PG-${new Date().getFullYear()}-"></label><label>Сумма договора<input name="p_principal_amount" type="number" min="1" step="0.01" required inputmode="decimal"></label><label>Первоначальный взнос<input name="p_down_payment" type="number" min="0" step="0.01" value="0" inputmode="decimal"></label><label>Количество платежей<input name="p_installment_count" type="number" min="1" max="60" value="6" required></label><label>Дата первого платежа<input name="p_first_due_date" type="date" value="${todayISO()}" required></label><button class="button">Создать договор и график</button></form>`;
  if (state.modal.type === "payment") {
    const item = state.data.schedules.find((x) => x.id === state.modal.id);
    const remainder = Number(item.amount_due) - Number(item.amount_paid || 0);
    content = `<form class="form" id="payment-form"><input type="hidden" name="scheduleId" value="${item.id}"><label>Сумма<input name="amount" type="number" min="0.01" max="${remainder}" step="0.01" value="${remainder}" required inputmode="decimal"></label><label>Дата оплаты<input name="paidAt" type="date" value="${todayISO()}" required></label><label>Комментарий<input name="note" placeholder="Например, перевод по СБП"></label><button class="button">Зафиксировать оплату</button></form>`;
  }
  if (state.modal.type === "invite") content = `<form class="form" id="invite-form"><label>Email сотрудника<input name="email" type="email" required></label><label>Роль<select name="role"><option>MANAGER</option><option>ADMIN</option><option>VIEWER</option></select></label><button class="button">Создать приглашение</button><p>Скопируйте полученную ссылку и отправьте сотруднику. После регистрации он попадёт в вашу компанию.</p></form>`;
  if (state.modal.type === "member") {
    const member = state.data.members.find((x) => x.id === state.modal.id);
    content = `<form class="form" id="role-form"><input type="hidden" name="membershipId" value="${member.id}"><label>Роль<select name="role">${["ADMIN", "MANAGER", "VIEWER"].map((r) => `<option ${r === member.role ? "selected" : ""}>${r}</option>`).join("")}</select></label><button class="button">Изменить роль</button><button class="button danger" type="button" id="remove-member">Удалить из компании</button></form>`;
  }
  if (state.modal.type === "risk") content = `
    <form class="form" id="risk-form">
      <label>Потенциальный клиент<input name="p_candidate_name" required placeholder="Например, Тестовый Клиент"></label>
      <label>Связать с существующим клиентом (необязательно)<select name="p_client_id"><option value="">Не связывать</option>${state.data.clients.map((c) => `<option value="${c.id}">${esc(fullName(c))}</option>`).join("")}</select></label>
      <label>Стоимость сделки<input name="p_requested_amount" type="number" min="1" step="0.01" required inputmode="decimal"></label>
      <label>Первоначальный взнос<input name="p_down_payment" type="number" min="0" step="0.01" value="0" required inputmode="decimal"></label>
      <label>Срок, месяцев<input name="p_term_months" type="number" min="1" max="60" value="6" required></label>
      <label>Подтверждённый доход в месяц<input name="p_monthly_income" type="number" min="1" step="0.01" required inputmode="decimal"></label>
      <label>Другие ежемесячные обязательства<input name="p_existing_monthly_obligations" type="number" min="0" step="0.01" value="0" required inputmode="decimal"></label>
      <label>Активных рассрочек<input name="p_active_installments" type="number" min="0" max="99" value="0" required></label>
      <label>Максимальная известная просрочка, дней<input name="p_max_overdue_days" type="number" min="0" max="3650" value="0" required></label>
      <div class="notice">Используйте только данные, которые компания вправе обрабатывать. Score — вспомогательная оценка, решение принимает человек.</div>
      <button class="button">Рассчитать Risk Score</button>
    </form>`;
  return `<div class="modal-backdrop" id="modal-backdrop"><section class="modal"><div class="modal-head"><h2>${({ client: "Новый клиент", contract: "Новый договор", payment: "Оплата", invite: "Приглашение", member: "Доступ сотрудника", risk: "Новая проверка" })[state.modal.type]}</h2><button class="icon-button" id="close-modal">×</button></div>${content}</section></div>`;
}

function appScreen() {
  const content = ({ dashboard, clients: clientsView, contracts: contractsView, payments: paymentsView, risk: riskView, team: teamView })[state.view]();
  root.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><div class="brand-mark">P</div><div>PayGuard<small>${esc(currentCompany()?.name)}</small></div></div><button class="avatar" data-view="team">${esc((state.context.profile.full_name || state.context.profile.email || "P").slice(0, 1).toUpperCase())}</button></header><main class="content">${state.message ? `<div class="notice ${state.message.error ? "error" : ""}">${esc(state.message.text)}</div>` : ""}${content}</main>${nav()}${modal()}</div>`;
  bindAppEvents();
}

function bindAppEvents() {
  root.querySelectorAll("[data-view]").forEach((el) => el.addEventListener("click", () => { state.view = el.dataset.view; state.message = null; render(); }));
  root.querySelectorAll("[data-modal]").forEach((el) => el.addEventListener("click", () => { if (!el.disabled) { state.modal = { type: el.dataset.modal }; render(); } }));
  root.querySelectorAll("[data-pay]").forEach((el) => el.addEventListener("click", () => { state.modal = { type: "payment", id: el.dataset.pay }; render(); }));
  root.querySelectorAll("[data-member]").forEach((el) => el.addEventListener("click", () => { state.modal = { type: "member", id: el.dataset.member }; render(); }));
  root.querySelectorAll("[data-company]").forEach((el) => el.addEventListener("click", async () => { state.companyId = el.dataset.company; sessionStorage.setItem("payguard_company_id", state.companyId); await refresh(); await startRealtime(); }));
  root.querySelector("#close-modal")?.addEventListener("click", () => { state.modal = null; render(); });
  root.querySelector("#modal-backdrop")?.addEventListener("click", (event) => { if (event.target.id === "modal-backdrop") { state.modal = null; render(); } });
  root.querySelector("#sign-out")?.addEventListener("click", async () => { await api.signOut(); state.context = null; state.message = null; render(); });
  root.querySelector("#seed-demo")?.addEventListener("click", async () => { await action(() => api.seedDemo(state.companyId), "Безопасные демо-данные добавлены."); });
  root.querySelector("#client-form")?.addEventListener("submit", submitClient);
  root.querySelector("#contract-form")?.addEventListener("submit", submitContract);
  root.querySelector("#payment-form")?.addEventListener("submit", submitPayment);
  root.querySelector("#invite-form")?.addEventListener("submit", submitInvite);
  root.querySelector("#role-form")?.addEventListener("submit", submitRole);
  root.querySelector("#risk-form")?.addEventListener("submit", submitRisk);
  root.querySelector("#remove-member")?.addEventListener("click", removeMember);
}

async function action(work, success) {
  try { state.loading = true; render(); await work(); state.modal = null; await refresh(); state.message = { text: success, error: false }; render(); }
  catch (error) { state.loading = false; state.message = { text: error.message, error: true }; render(); }
}
async function submitClient(e) { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget)); await action(() => api.createClient(state.companyId, { ...values, status: "ACTIVE" }), "Клиент добавлен в общую базу."); }
async function submitContract(e) { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); await action(() => api.createContract({ ...v, p_company_id: state.companyId, p_principal_amount: Number(v.p_principal_amount), p_down_payment: Number(v.p_down_payment), p_installment_count: Number(v.p_installment_count) }), "Договор и график созданы."); }
async function submitPayment(e) { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); await action(() => api.recordPayment({ ...v, amount: Number(v.amount) }), "Оплата зафиксирована."); }
async function submitInvite(e) { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); try { const token = await api.inviteMember({ companyId: state.companyId, ...v }); const url = `${location.origin}${location.pathname}?invite=${token}`; await navigator.clipboard?.writeText(url); state.modal = null; notify(`Ссылка приглашения создана${navigator.clipboard ? " и скопирована" : ""}: ${url}`); } catch (error) { notify(error.message, true); } }
async function submitRole(e) { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); await action(() => api.changeRole(v), "Роль обновлена."); }
async function submitRisk(e) {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.currentTarget));
  for (const key of ["p_requested_amount", "p_down_payment", "p_term_months", "p_monthly_income", "p_existing_monthly_obligations", "p_active_installments", "p_max_overdue_days"]) v[key] = Number(v[key]);
  v.p_client_id = v.p_client_id || null;
  v.p_company_id = state.companyId;
  await action(() => api.createRiskCheck(v), "Risk Score рассчитан и сохранён для команды.");
}
async function removeMember() { if (!confirm("Удалить сотрудника из компании?")) return; await action(() => api.removeMember(state.modal.id), "Сотрудник удалён из компании."); }

async function refresh() {
  state.loading = true; render();
  state.data = await api.workspace(state.companyId);
  state.loading = false; render();
}

async function startRealtime() {
  if (!supabase || !state.companyId) return;
  if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
  const scheduleRefresh = () => {
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(() => { if (!state.loading && state.context) refresh(); }, 350);
  };
  realtimeChannel = supabase
    .channel(`company-${state.companyId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "clients", filter: `company_id=eq.${state.companyId}` }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "contracts", filter: `company_id=eq.${state.companyId}` }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "payment_schedules", filter: `company_id=eq.${state.companyId}` }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "company_members", filter: `company_id=eq.${state.companyId}` }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "risk_checks", filter: `company_id=eq.${state.companyId}` }, scheduleRefresh)
    .subscribe();
}

async function bootstrap() {
  try {
    state.loading = true; render();
    state.context = configured ? await api.context() : null;
    if (state.context) {
      const valid = state.context.memberships.some((item) => item.company_id === state.companyId);
      state.companyId = valid ? state.companyId : state.context.memberships[0]?.company_id;
      if (state.companyId) {
        sessionStorage.setItem("payguard_company_id", state.companyId);
        const invitation = new URLSearchParams(location.search).get("invite");
        if (invitation) {
          await api.acceptInvitation(invitation);
          history.replaceState({}, "", location.pathname);
          state.context = await api.context();
          state.companyId = state.context.memberships.at(-1)?.company_id || state.companyId;
        }
        state.data = await api.workspace(state.companyId);
        await startRealtime();
      } else state.message = { text: "Аккаунт не состоит ни в одной активной компании.", error: true };
    }
  } catch (error) {
    state.message = { text: error.message, error: true };
  } finally { state.loading = false; render(); }
}

function render() {
  if (state.loading) return loading();
  if (!state.context) return authScreen();
  return appScreen();
}

if (supabase) supabase.auth.onAuthStateChange(async (event) => { if (event === "SIGNED_OUT") { if (realtimeChannel) await supabase.removeChannel(realtimeChannel); realtimeChannel = null; state.context = null; state.data = { clients: [], contracts: [], schedules: [], members: [], riskChecks: [] }; render(); } });
bootstrap();
