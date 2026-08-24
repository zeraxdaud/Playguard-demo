-- PayGuard v0.2: Supabase/PostgreSQL multi-tenant schema
-- Run once in a new Supabase project via SQL Editor or `supabase db push`.

create extension if not exists pgcrypto;

create type public.company_role as enum ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER');
create type public.membership_status as enum ('ACTIVE', 'SUSPENDED');
create type public.client_status as enum ('ACTIVE', 'ARCHIVED');
create type public.contract_status as enum ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'DEFAULTED');
create type public.schedule_status as enum ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.company_role not null default 'VIEWER',
  status public.membership_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create table public.company_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  role public.company_role not null,
  token_hash text not null unique,
  invited_by uuid not null references public.profiles(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  check (role <> 'OWNER')
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 80),
  last_name text not null check (char_length(last_name) between 1 and 80),
  middle_name text,
  phone text,
  email text,
  status public.client_status not null default 'ACTIVE',
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null,
  contract_number text not null,
  principal_amount numeric(14,2) not null check (principal_amount > 0),
  down_payment numeric(14,2) not null default 0 check (down_payment >= 0 and down_payment <= principal_amount),
  installment_count integer not null check (installment_count between 1 and 60),
  first_due_date date not null,
  status public.contract_status not null default 'ACTIVE',
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, contract_number),
  unique (id, company_id),
  foreign key (client_id, company_id) references public.clients(id, company_id) on delete restrict
);

create table public.payment_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  contract_id uuid not null,
  installment_number integer not null check (installment_number > 0),
  due_date date not null,
  amount_due numeric(14,2) not null check (amount_due >= 0),
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0 and amount_paid <= amount_due),
  status public.schedule_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (contract_id, company_id) references public.contracts(id, company_id) on delete cascade,
  unique (contract_id, installment_number),
  unique (id, company_id, contract_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  contract_id uuid not null,
  schedule_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  paid_at date not null,
  note text,
  recorded_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  foreign key (contract_id, company_id) references public.contracts(id, company_id) on delete restrict,
  foreign key (schedule_id, company_id, contract_id) references public.payment_schedules(id, company_id, contract_id) on delete restrict
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index clients_company_idx on public.clients(company_id, created_at desc);
create index contracts_company_idx on public.contracts(company_id, status);
create index schedules_company_due_idx on public.payment_schedules(company_id, due_date, status);
create index payments_company_idx on public.payments(company_id, paid_at desc);
create index members_user_idx on public.company_members(user_id, status);
create index audit_company_idx on public.audit_logs(company_id, created_at desc);

-- SECURITY DEFINER helpers prevent recursive RLS checks on memberships.
create or replace function public.is_company_member(p_company_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.company_members
    where company_id = p_company_id and user_id = auth.uid() and status = 'ACTIVE'
  );
$$;

create or replace function public.current_company_role(p_company_id uuid)
returns public.company_role language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.company_members
  where company_id = p_company_id and user_id = auth.uid() and status = 'ACTIVE'
  limit 1;
$$;

create or replace function public.can_write_company(p_company_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.current_company_role(p_company_id) in ('OWNER','ADMIN','MANAGER'), false);
$$;

create or replace function public.can_manage_company_members(p_company_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.current_company_role(p_company_id) in ('OWNER','ADMIN'), false);
$$;

revoke all on function public.is_company_member(uuid) from public;
revoke all on function public.current_company_role(uuid) from public;
revoke all on function public.can_write_company(uuid) from public;
revoke all on function public.can_manage_company_members(uuid) from public;
grant execute on function public.is_company_member(uuid), public.current_company_role(uuid), public.can_write_company(uuid), public.can_manage_company_members(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.company_invitations enable row level security;
alter table public.clients enable row level security;
alter table public.contracts enable row level security;
alter table public.payment_schedules enable row level security;
alter table public.payments enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_self_read on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_company_colleagues_read on public.profiles for select to authenticated using (
  exists (
    select 1 from public.company_members mine
    join public.company_members theirs on theirs.company_id = mine.company_id
    where mine.user_id = auth.uid() and mine.status = 'ACTIVE' and theirs.user_id = profiles.id and theirs.status = 'ACTIVE'
  )
);
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy companies_member_read on public.companies for select to authenticated using (public.is_company_member(id));
create policy companies_owner_update on public.companies for update to authenticated using (public.current_company_role(id) = 'OWNER') with check (public.current_company_role(id) = 'OWNER');

create policy members_member_read on public.company_members for select to authenticated using (public.is_company_member(company_id));
create policy members_manager_update on public.company_members for update to authenticated using (public.can_manage_company_members(company_id)) with check (public.can_manage_company_members(company_id));
create policy members_manager_delete on public.company_members for delete to authenticated using (public.can_manage_company_members(company_id));

create policy invitations_manager_read on public.company_invitations for select to authenticated using (public.can_manage_company_members(company_id));

create policy clients_member_read on public.clients for select to authenticated using (public.is_company_member(company_id));
create policy clients_writer_insert on public.clients for insert to authenticated with check (public.can_write_company(company_id) and created_by = auth.uid());
create policy clients_writer_update on public.clients for update to authenticated using (public.can_write_company(company_id)) with check (public.can_write_company(company_id));
create policy clients_admin_delete on public.clients for delete to authenticated using (public.current_company_role(company_id) in ('OWNER','ADMIN'));

create policy contracts_member_read on public.contracts for select to authenticated using (public.is_company_member(company_id));
create policy contracts_writer_insert on public.contracts for insert to authenticated with check (public.can_write_company(company_id) and created_by = auth.uid());
create policy contracts_writer_update on public.contracts for update to authenticated using (public.can_write_company(company_id)) with check (public.can_write_company(company_id));
create policy contracts_admin_delete on public.contracts for delete to authenticated using (public.current_company_role(company_id) in ('OWNER','ADMIN'));

create policy schedules_member_read on public.payment_schedules for select to authenticated using (public.is_company_member(company_id));
create policy schedules_writer_all on public.payment_schedules for all to authenticated using (public.can_write_company(company_id)) with check (public.can_write_company(company_id));
create policy payments_member_read on public.payments for select to authenticated using (public.is_company_member(company_id));
create policy payments_writer_insert on public.payments for insert to authenticated with check (public.can_write_company(company_id) and recorded_by = auth.uid());
create policy audit_member_read on public.audit_logs for select to authenticated using (public.is_company_member(company_id));

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger companies_touch before update on public.companies for each row execute function public.touch_updated_at();
create trigger members_touch before update on public.company_members for each row execute function public.touch_updated_at();
create trigger clients_touch before update on public.clients for each row execute function public.touch_updated_at();
create trigger contracts_touch before update on public.contracts for each row execute function public.touch_updated_at();
create trigger schedules_touch before update on public.payment_schedules for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_company_name text; v_company_id uuid; v_slug text;
begin
  insert into public.profiles(id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', ''));
  v_company_name := nullif(trim(new.raw_user_meta_data->>'company_name'), '');
  if v_company_name is not null then
    v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(new.id::text, 1, 8);
    insert into public.companies(name, slug, created_by) values (v_company_name, v_slug, new.id) returning id into v_company_id;
    insert into public.company_members(company_id, user_id, role) values (v_company_id, new.id, 'OWNER');
  end if;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.protect_membership_changes()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor_role public.company_role; v_owner_count integer;
begin
  v_actor_role := public.current_company_role(coalesce(new.company_id, old.company_id));
  if tg_op = 'UPDATE' then
    if old.company_id is distinct from new.company_id or old.user_id is distinct from new.user_id then
      raise exception 'Нельзя переносить членство между пользователями или компаниями';
    end if;
    if old.role = 'OWNER' and (old.role is distinct from new.role or old.status is distinct from new.status) then
      select count(*) into v_owner_count from public.company_members where company_id = old.company_id and role = 'OWNER' and status = 'ACTIVE';
      if v_actor_role <> 'OWNER' or v_owner_count <= 1 then raise exception 'Нельзя изменить роль последнего владельца'; end if;
    end if;
    if new.role = 'OWNER' and old.role <> 'OWNER' and v_actor_role <> 'OWNER' then raise exception 'Только владелец может назначить владельца'; end if;
  elsif tg_op = 'DELETE' and old.role = 'OWNER' then
    select count(*) into v_owner_count from public.company_members where company_id = old.company_id and role = 'OWNER' and status = 'ACTIVE';
    if v_actor_role <> 'OWNER' or v_owner_count <= 1 then raise exception 'Нельзя удалить последнего владельца'; end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger protect_memberships before update or delete on public.company_members for each row execute function public.protect_membership_changes();

create or replace function public.create_company_invitation(p_company_id uuid, p_email text, p_role public.company_role)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token text := encode(gen_random_bytes(32), 'hex');
begin
  if not public.can_manage_company_members(p_company_id) then raise exception 'Недостаточно прав для приглашения'; end if;
  if p_role = 'OWNER' then raise exception 'Владельца нельзя назначить приглашением'; end if;
  if trim(p_email) = '' then raise exception 'Email обязателен'; end if;
  insert into public.company_invitations(company_id, email, role, token_hash, invited_by)
  values (p_company_id, lower(trim(p_email)), p_role, encode(digest(v_token, 'sha256'), 'hex'), auth.uid());
  return v_token;
end;
$$;

create or replace function public.accept_company_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_invite public.company_invitations%rowtype; v_user_email text;
begin
  select lower(email) into v_user_email from public.profiles where id = auth.uid();
  select * into v_invite from public.company_invitations
  where token_hash = encode(digest(p_token, 'sha256'), 'hex') and accepted_at is null and expires_at > now()
  for update;
  if v_invite.id is null then raise exception 'Приглашение недействительно или истекло'; end if;
  if lower(v_invite.email) <> v_user_email then raise exception 'Приглашение создано для другого email'; end if;
  insert into public.company_members(company_id, user_id, role) values (v_invite.company_id, auth.uid(), v_invite.role)
  on conflict (company_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  update public.company_invitations set accepted_at = now() where id = v_invite.id;
  return v_invite.company_id;
end;
$$;

create or replace function public.create_installment_contract(
  p_company_id uuid, p_client_id uuid, p_contract_number text, p_principal_amount numeric,
  p_down_payment numeric, p_installment_count integer, p_first_due_date date
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_contract_id uuid; v_remainder numeric(14,2); v_base numeric(14,2); v_amount numeric(14,2); i integer;
begin
  if not public.can_write_company(p_company_id) then raise exception 'Недостаточно прав для создания договора'; end if;
  if not exists(select 1 from public.clients where id = p_client_id and company_id = p_company_id) then raise exception 'Клиент не найден в этой компании'; end if;
  if p_principal_amount <= 0 or p_down_payment < 0 or p_down_payment > p_principal_amount or p_installment_count not between 1 and 60 then raise exception 'Некорректные условия договора'; end if;
  insert into public.contracts(company_id, client_id, contract_number, principal_amount, down_payment, installment_count, first_due_date, created_by)
  values (p_company_id, p_client_id, trim(p_contract_number), p_principal_amount, p_down_payment, p_installment_count, p_first_due_date, auth.uid())
  returning id into v_contract_id;
  v_remainder := p_principal_amount - p_down_payment;
  v_base := trunc(v_remainder / p_installment_count, 2);
  for i in 1..p_installment_count loop
    v_amount := case when i = p_installment_count then v_remainder - v_base * (p_installment_count - 1) else v_base end;
    insert into public.payment_schedules(company_id, contract_id, installment_number, due_date, amount_due)
    values (p_company_id, v_contract_id, i, (p_first_due_date + make_interval(months => i - 1))::date, v_amount);
  end loop;
  insert into public.audit_logs(company_id, actor_id, action, entity_type, entity_id) values (p_company_id, auth.uid(), 'CREATE', 'contract', v_contract_id::text);
  return v_contract_id;
end;
$$;

create or replace function public.record_payment(p_schedule_id uuid, p_amount numeric, p_paid_at date, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_schedule public.payment_schedules%rowtype; v_payment_id uuid; v_new_paid numeric(14,2);
begin
  select * into v_schedule from public.payment_schedules where id = p_schedule_id for update;
  if v_schedule.id is null then raise exception 'Платёж графика не найден'; end if;
  if not public.can_write_company(v_schedule.company_id) then raise exception 'Недостаточно прав для оплаты'; end if;
  if p_amount <= 0 or p_amount > (v_schedule.amount_due - v_schedule.amount_paid) then raise exception 'Сумма превышает остаток платежа'; end if;
  insert into public.payments(company_id, contract_id, schedule_id, amount, paid_at, note, recorded_by)
  values (v_schedule.company_id, v_schedule.contract_id, v_schedule.id, p_amount, p_paid_at, nullif(trim(p_note), ''), auth.uid()) returning id into v_payment_id;
  v_new_paid := v_schedule.amount_paid + p_amount;
  update public.payment_schedules set amount_paid = v_new_paid,
    status = case when v_new_paid = amount_due then 'PAID'::public.schedule_status else 'PARTIAL'::public.schedule_status end
  where id = v_schedule.id;
  if not exists (select 1 from public.payment_schedules where contract_id = v_schedule.contract_id and id <> v_schedule.id and status <> 'PAID') and v_new_paid = v_schedule.amount_due then
    update public.contracts set status = 'COMPLETED' where id = v_schedule.contract_id;
  end if;
  insert into public.audit_logs(company_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_schedule.company_id, auth.uid(), 'RECORD_PAYMENT', 'payment', v_payment_id::text, jsonb_build_object('amount', p_amount));
  return v_payment_id;
end;
$$;

create or replace function public.refresh_company_overdues(p_company_id uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if not public.is_company_member(p_company_id) then raise exception 'Нет доступа к компании'; end if;
  update public.payment_schedules set status = 'OVERDUE'
  where company_id = p_company_id and due_date < current_date and status in ('PENDING','PARTIAL');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.seed_demo_data(p_company_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client_1 uuid; v_client_2 uuid;
begin
  if not coalesce(public.current_company_role(p_company_id) in ('OWNER','ADMIN'), false) then raise exception 'Только владелец или администратор может загрузить демо'; end if;
  if exists(select 1 from public.clients where company_id = p_company_id) then raise exception 'Демо добавляется только в пустую компанию'; end if;
  insert into public.clients(company_id, first_name, last_name, phone, email, created_by) values
    (p_company_id, 'Анна', 'Волкова', '+7 900 000-00-01', 'anna.demo@example.com', auth.uid()) returning id into v_client_1;
  insert into public.clients(company_id, first_name, last_name, phone, email, created_by) values
    (p_company_id, 'Максим', 'Орлов', '+7 900 000-00-02', 'maxim.demo@example.com', auth.uid()) returning id into v_client_2;
  perform public.create_installment_contract(p_company_id, v_client_1, 'DEMO-001', 120000, 20000, 5, current_date - 35);
  perform public.create_installment_contract(p_company_id, v_client_2, 'DEMO-002', 84000, 14000, 7, current_date + 7);
  perform public.refresh_company_overdues(p_company_id);
end;
$$;

revoke all on function public.create_company_invitation(uuid,text,public.company_role), public.accept_company_invitation(text), public.create_installment_contract(uuid,uuid,text,numeric,numeric,integer,date), public.record_payment(uuid,numeric,date,text), public.refresh_company_overdues(uuid), public.seed_demo_data(uuid) from public;
grant execute on function public.create_company_invitation(uuid,text,public.company_role), public.accept_company_invitation(text), public.create_installment_contract(uuid,uuid,text,numeric,numeric,integer,date), public.record_payment(uuid,numeric,date,text), public.refresh_company_overdues(uuid), public.seed_demo_data(uuid) to authenticated;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update(full_name) on public.profiles to authenticated;
grant select on public.companies to authenticated;
grant update(name, slug) on public.companies to authenticated;
grant select, delete on public.company_members to authenticated;
grant update(role, status) on public.company_members to authenticated;
grant select on public.company_invitations to authenticated;
grant select, insert, update, delete on public.clients to authenticated;
grant select on public.contracts to authenticated;
grant select on public.payment_schedules to authenticated;
grant select on public.payments to authenticated;
grant select on public.audit_logs to authenticated;
grant usage, select on sequence public.audit_logs_id_seq to authenticated;

-- Enable live updates when running inside Supabase. The block is harmless on
-- PostgreSQL installations that do not have the Supabase publication.
do $$
declare v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['clients','contracts','payment_schedules','company_members'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end $$;
