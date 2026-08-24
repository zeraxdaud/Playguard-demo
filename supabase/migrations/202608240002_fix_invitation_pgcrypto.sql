-- Fix for Supabase projects where pgcrypto is installed in `extensions`.
-- Safe to run after 202608240001_payguard_v02.sql. Existing data is preserved.

create or replace function public.create_company_invitation(p_company_id uuid, p_email text, p_role public.company_role)
returns text language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not public.can_manage_company_members(p_company_id) then raise exception 'Недостаточно прав для приглашения'; end if;
  if p_role = 'OWNER' then raise exception 'Владельца нельзя назначить приглашением'; end if;
  if trim(p_email) = '' then raise exception 'Email обязателен'; end if;
  insert into public.company_invitations(company_id, email, role, token_hash, invited_by)
  values (p_company_id, lower(trim(p_email)), p_role, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid());
  return v_token;
end;
$$;

create or replace function public.accept_company_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_invite public.company_invitations%rowtype; v_user_email text;
begin
  select lower(email) into v_user_email from public.profiles where id = auth.uid();
  select * into v_invite from public.company_invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and accepted_at is null and expires_at > now()
  for update;
  if v_invite.id is null then raise exception 'Приглашение недействительно или истекло'; end if;
  if lower(v_invite.email) <> v_user_email then raise exception 'Приглашение создано для другого email'; end if;
  insert into public.company_members(company_id, user_id, role) values (v_invite.company_id, auth.uid(), v_invite.role)
  on conflict (company_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  update public.company_invitations set accepted_at = now() where id = v_invite.id;
  return v_invite.company_id;
end;
$$;

revoke all on function public.create_company_invitation(uuid,text,public.company_role), public.accept_company_invitation(text) from public;
grant execute on function public.create_company_invitation(uuid,text,public.company_role), public.accept_company_invitation(text) to authenticated;
