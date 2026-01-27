create table if not exists public.cil_drafts (
  id bigserial primary key,
  owner_id varchar not null,

  actor_user_id varchar null,
  actor_phone varchar null,

  kind varchar not null, -- 'expense'|'revenue'|'time'|...

  status varchar not null default 'draft', -- 'draft'|'confirmed'|'rejected'|'expired'

  payload jsonb not null,

  occurred_on date null,
  amount_cents bigint null,
  source text null,
  description text null,
  job_id uuid null,
  job_name text null,
  category varchar null,

  source_msg_id text null,
  dedupe_hash text null,

  media_asset_id uuid null,

  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now(),

  confirmed_transaction_id integer null
);

create index if not exists cil_drafts_owner_status_idx
  on public.cil_drafts (owner_id, status);

create index if not exists cil_drafts_owner_kind_date_idx
  on public.cil_drafts (owner_id, kind, occurred_on);

create index if not exists cil_drafts_owner_job_idx
  on public.cil_drafts (owner_id, job_id);

create unique index if not exists cil_drafts_owner_source_msg_uq
  on public.cil_drafts(owner_id, source_msg_id)
  where source_msg_id is not null;
