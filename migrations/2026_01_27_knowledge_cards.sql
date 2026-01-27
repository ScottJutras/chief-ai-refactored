-- If pgvector is not enabled yet, this will enable it (works on many Postgres installs).
-- In Supabase, extensions are supported; if this fails, enable vector via Supabase UI and re-run.
create extension if not exists vector;

create table if not exists public.knowledge_cards (
  id bigserial primary key,
  owner_id varchar not null,

  entity_type varchar not null, -- 'transaction'
  entity_id integer not null,   -- public.transactions.id

  occurred_on date null,
  kind varchar null,
  amount_cents bigint null,
  source text null,
  job_id uuid null,
  job_name text null,

  text text not null,
  embedding vector(1536) null, -- adjust to your embedding model dims

  created_at timestamp without time zone not null default now()
);

create index if not exists knowledge_cards_owner_entity_idx
  on public.knowledge_cards(owner_id, entity_type, entity_id);

create index if not exists knowledge_cards_owner_date_idx
  on public.knowledge_cards(owner_id, occurred_on);

-- Vector index (optional). If you get an error about lists, you can omit this until later.
create index if not exists knowledge_cards_embedding_idx
  on public.knowledge_cards using ivfflat (embedding vector_cosine_ops);
