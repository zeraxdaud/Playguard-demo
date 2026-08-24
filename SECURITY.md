# Security notes

- Tenant isolation is enforced with PostgreSQL RLS on every company-owned table.
- Authorization helpers are `SECURITY DEFINER`, use a fixed `search_path`, and expose only boolean/role checks.
- Business writes that touch several tables run inside RPC transactions.
- Invitations are bound to lowercase email, expire after 7 days, are single-use, and store only SHA-256 hashes.
- Member-change trigger prevents an admin from assigning `OWNER` and prevents removal/demotion of the last owner.
- The browser receives only the Supabase publishable/anon key. The service-role key must never be exposed.
- Money uses `numeric(14,2)` in PostgreSQL. Schedule rounding remainder is placed in the final installment.
- Cross-company contract/client combinations are checked in RPC and reinforced with composite foreign keys.
- This repository intentionally contains no real personal data and no secrets.

Before production: enable MFA for privileged users, configure custom SMTP and rate limits, add backups/PITR as required, add error monitoring, conduct dependency and penetration testing, formalize data retention/deletion, and complete legal/privacy review for the deployment jurisdiction.
