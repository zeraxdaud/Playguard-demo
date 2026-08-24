-- Internal company-only Risk Score MVP.
-- This is decision support based on declared inputs, not a credit bureau report.

create type public.risk_level as enum ('LOW', 'MEDIUM', 'HIGH');

create table public.risk_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid,
  candidate_name text not null check (char_length(candidate_name) between 2 and 160),
  requested_amount numeric(14,2) not null check (requested_amount > 0),
  down_payment numeric(14,2) not null default 0 check (down_payment >= 0 and down_payment <= requested_amount),
  term_months integer not null check (term_months between 1 and 60),
  monthly_income numeric(14,2) not null check (monthly_income > 0),
  existing_monthly_obligations numeric(14,2) not null default 0 check (existing_monthly_obligations >= 0),
  active_installments integer not null default 0 check (active_installments between 0 and 99),
  max_overdue_days integer not null default 0 check (max_overdue_days between 0 and 3650),
  estimated_monthly_payment numeric(14,2) not null,
  payment_burden_ratio numeric(8,4) not null,
  score integer not null check (score between 0 and 100),
  level public.risk_level not null,
  recommendation text not null,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  foreign key (client_id, company_id) references public.clients(id, company_id) on delete set null (client_id)
);

create index risk_checks_company_created_idx on public.risk_checks(company_id, created_at desc);

alter table public.risk_checks enable row level security;
create policy risk_checks_member_read on public.risk_checks for select to authenticated
  using (public.is_company_member(company_id));

create or replace function public.create_risk_check(
  p_company_id uuid,
  p_candidate_name text,
  p_requested_amount numeric,
  p_down_payment numeric,
  p_term_months integer,
  p_monthly_income numeric,
  p_existing_monthly_obligations numeric default 0,
  p_active_installments integer default 0,
  p_max_overdue_days integer default 0,
  p_client_id uuid default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_financed numeric(14,2);
  v_monthly numeric(14,2);
  v_burden numeric(8,4);
  v_down_ratio numeric(8,4);
  v_score integer := 10;
  v_level public.risk_level;
  v_recommendation text;
begin
  if not public.can_write_company(p_company_id) then raise exception 'Недостаточно прав для проверки риска'; end if;
  if trim(p_candidate_name) = '' or p_requested_amount <= 0 or p_down_payment < 0 or p_down_payment > p_requested_amount
    or p_term_months not between 1 and 60 or p_monthly_income <= 0
    or p_existing_monthly_obligations < 0 or p_active_installments not between 0 and 99
    or p_max_overdue_days not between 0 and 3650 then raise exception 'Некорректные данные проверки'; end if;
  if p_client_id is not null and not exists(select 1 from public.clients where id = p_client_id and company_id = p_company_id) then
    raise exception 'Клиент не найден в этой компании';
  end if;

  v_financed := p_requested_amount - p_down_payment;
  v_monthly := round(v_financed / p_term_months, 2);
  v_burden := round((v_monthly + p_existing_monthly_obligations) / p_monthly_income, 4);
  v_down_ratio := round(p_down_payment / p_requested_amount, 4);

  v_score := v_score + case
    when v_burden >= 0.70 then 45
    when v_burden >= 0.50 then 30
    when v_burden >= 0.35 then 18
    else 5 end;
  v_score := v_score + case
    when v_down_ratio < 0.10 then 15
    when v_down_ratio < 0.20 then 8
    when v_down_ratio >= 0.35 then -5
    else 0 end;
  v_score := v_score + case
    when p_max_overdue_days >= 90 then 30
    when p_max_overdue_days >= 30 then 20
    when p_max_overdue_days >= 7 then 10
    else 0 end;
  v_score := v_score + case when p_active_installments >= 3 then 10 when p_active_installments >= 1 then 4 else 0 end;
  v_score := greatest(0, least(100, v_score));

  if v_score <= 34 then
    v_level := 'LOW'; v_recommendation := 'Низкий риск: стандартное рассмотрение при подтверждении введённых данных.';
  elsif v_score <= 64 then
    v_level := 'MEDIUM'; v_recommendation := 'Средний риск: запросите подтверждение дохода или увеличьте первоначальный взнос.';
  else
    v_level := 'HIGH'; v_recommendation := 'Высокий риск: рекомендуется отказ или изменение условий сделки.';
  end if;

  insert into public.risk_checks(
    company_id, client_id, candidate_name, requested_amount, down_payment, term_months, monthly_income,
    existing_monthly_obligations, active_installments, max_overdue_days, estimated_monthly_payment,
    payment_burden_ratio, score, level, recommendation, created_by
  ) values (
    p_company_id, p_client_id, trim(p_candidate_name), p_requested_amount, p_down_payment, p_term_months, p_monthly_income,
    p_existing_monthly_obligations, p_active_installments, p_max_overdue_days, v_monthly,
    v_burden, v_score, v_level, v_recommendation, auth.uid()
  ) returning id into v_id;

  insert into public.audit_logs(company_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_company_id, auth.uid(), 'RISK_CHECK', 'risk_check', v_id::text, jsonb_build_object('score', v_score, 'level', v_level));
  return v_id;
end;
$$;

revoke all on function public.create_risk_check(uuid,text,numeric,numeric,integer,numeric,numeric,integer,integer,uuid) from public;
grant execute on function public.create_risk_check(uuid,text,numeric,numeric,integer,numeric,numeric,integer,integer,uuid) to authenticated;
grant select on public.risk_checks to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'risk_checks') then
    alter publication supabase_realtime add table public.risk_checks;
  end if;
end $$;
