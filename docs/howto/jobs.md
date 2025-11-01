JOBS — SOP (Upgraded)

File: /docs/howto/jobs.md
Module: handlers/commands/job.js
Depends on: services/postgres.js, ensureJobByName, resolveJobContext

See also: Shared Contracts
 — tenant RLS, active job context, user resolution, idempotency, and canonical messages.

1) Purpose
Create and manage Jobs — the primary linkage for time, tasks, expenses, revenue, and quotes. Every record must carry owner_id and job_no.

2) Commands (canonical grammar)
Action	Example	Notes
Create	create job Roof Repair	Case-insensitive uniqueness per owner
List	list jobs	Show status, open tasks, KPIs
Activate	set active job Roof Repair	Store per-user context
Query active	active job?	Returns current job + since when
Close	close job Roof Repair	Sets status='finished'
Archive	archive job Roof Repair	Hides from default lists
Move entry	move last log to Roof Repair	Repairs last time/task/expense
Rename	rename job Roof Repair -> Roof Repair Phase 2	Preserves job_no

NLU tokens:

Job mention: raw text (no @), normalized to LOWER(name); avoid ambiguity by prompting when multi-match.

3) Flow

Create / find

-- Table
create table if not exists jobs(
  owner_id  text not null,
  job_no    integer generated always as identity primary key,
  name      text not null,
  status    text not null default 'active', -- active|finished|archived
  created_at timestamptz not null default now(),
  unique(owner_id, lower(name))
);

-- Helpful index
create index if not exists idx_jobs_owner_status on jobs(owner_id, status);


ensureJobByName(ownerId, name) → creates if missing, returns { job_no, name, status }.

Activate
Persist per-user active job (cache + DB). Confirm:

“Active job set to Roof Repair.”

List / KPIs
Contract for views (columns must exist):

v_job_kpis(owner_id, job_no, name, status, open_tasks, total_expense, total_revenue, gross_margin_pct)

v_job_hours_week(owner_id, job_no, hours_work, hours_break, hours_drive, labour_cost)

Move logs
move last log to <job> updates the most recent log (pref: time → task → expense).

Close vs Archive

close: status='finished' (read-only, still visible)

archive: status='archived' (hidden by default lists)

4) Data Integrity (hard rules)

All dependents carry (owner_id, job_no) with FKs:

alter table tasks     add constraint fk_tasks_job  foreign key (job_no, owner_id) references jobs(job_no, owner_id);
alter table time_entries add constraint fk_time_job   foreign key (job_no, owner_id) references jobs(job_no, owner_id);
alter table expenses  add constraint fk_exp_job   foreign key (job_no, owner_id) references jobs(job_no, owner_id);


Add composite PK on (job_no, owner_id) in jobs for FK pairing:

alter table jobs add constraint jobs_job_owner_unique unique(job_no, owner_id);

5) Dashboard routes (response contract)

GET /api/jobs/kpis?owner_id=… → array of {job_no,name,status,open_tasks,total_expense,total_revenue,gross_margin_pct}

GET /api/jobs/:job_no/time → { weekly: v_job_hours_week row(s), totals: {hours_work,…} }

GET /api/jobs/:job_no/tasks → open tasks w/ IDs and due dates

6) Edge & Repair

Duplicate names → blocked by constraint, suggest closest variants.

Missing job on inbound log → offer: “Use Unassigned or pick a job?”

Ambiguous name (multi match) → list top 5 and ask user to choose.

7) Idempotency

Re-issuing create job X returns the existing job and says “Already exists — using it.”

8) Audit & RLS

Write audit_log(owner_id, actor, event, payload, at).
RLS: each dependent row must satisfy row.owner_id = auth.owner_id and (job_no, owner_id) pair must exist in jobs.