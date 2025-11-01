Shared Contracts — Global Standards

(Linked from each SOP: Jobs, Tasks, Timeclock, etc.)
Defines universal data, security, and behavior rules used across all PocketCFO modules.

1. Owner Isolation (RLS)

All tenant-scoped tables must include owner_id text not null.

Policy template:

create policy tenant_isolation on <table>
using (owner_id = current_setting('request.jwt.claims', true)::json->>'owner_id');


Applies to:

jobs, tasks, time_entries, expenses, revenues, quotes, reminders, etc.
Guarantees full tenant isolation within Postgres Row-Level Security.

2. Active Job Context Storage

Tracks each user’s current working job.

Table:

user_context(
  owner_id text not null,
  user_id  text not null,
  active_job_no int,
  updated_at timestamptz default now(),
  primary key (owner_id, user_id)
);


Upsert on activation (set active job <name>).

Optional TTL (e.g., auto-clear after inactivity).

3. User Resolution

Resolve @Name mentions or assignees quickly.

Table:

users(
  owner_id text not null,
  user_id  text primary key,
  name     text not null,
  role     text check (role in ('Owner','Board','Employee')),
  unique (owner_id, lower(name))
);


Index:

create index if not exists idx_users_owner_name_trgm
on users using gin (lower(name) gin_trgm_ops);


Used for fuzzy lookup of @Justin, @everyone, etc.

4. Consistency & Retries

All write handlers should be idempotent.

Use a short-term table to de-duplicate repeated commands:

recent_commands(
  owner_id text not null,
  user_id  text not null,
  cmd_sha  text not null,
  created_at timestamptz default now(),
  primary key (owner_id, user_id, cmd_sha)
);


cmd_sha = sha(normalized_intent).

TTL cleanup (e.g., 60 seconds).
Prevents double “clock in” or “task add” actions from voice or retries.

5. Validation & Confirmation Messages

Define canonical tones/messages for consistency across Chief’s replies.

Type	Example
Confirm	✅ “Task added: Buy nails (Roof Repair).”
Error	⚠️ “You’re already clocked in since 3 PM. Clock out first?”
Prompt	🤔 “Which job should I clock this to?”
Success	🎯 “All set — logged 5h for Roof Repair.”

Keep tone: short, confident, plain English (Chief’s CFO voice).

6. Linked SOPs

Jobs SOP

Tasks SOP

Timeclock SOP