TIME-CLOCK — SOP (Upgraded)
See also: Shared Contracts — tenant RLS, active job context, user resolution, idempotency, and canonical messages are defined once in _shared_contracts.md
File: /docs/howto/timeclock.md
Module: handlers/commands/timeclock.js
Depends on: services/postgres.js, resolveJobContext, logTimeEntryWithJob
> **See also:** [Shared Contracts](./shared_contracts.md)
> — tenant RLS, active job context, user resolution, idempotency, and canonical messages.

1) Purpose

Track work/break/drive time. Every entry must link to a job.

2) Commands
Action	Example	Notes
Clock in (self)	clock in	Uses active job
Clock in (explicit job)	clock in @ Roof Repair 7am	@ introduces job
Clock out	clock out	Closes open shift
Clock for another	clock in Justin @ Roof Repair 5pm	Owner/Board only
Start/End break	start break / end break	Mutually exclusive
Start/End drive	start drive / end drive	Mutually exclusive

Date grammar: absolute (“5:45pm yesterday”), relative (“+30m”), ISO tolerated.

3) Flow

Resolve actor: default sender; validate role for “other user.”

Resolve job: explicit @ Job > active job > prompt.

Overlap guard:

If open work, require clock-out time or refuse new work.

break/drive may only occur inside an open work window (policy choice; or allow standalone — pick one and document it).

Create entry via logTimeEntryWithJob(ownerId, actor, type, timestamp, jobName).

Schema (core):

time_entries(
  id serial primary key,
  owner_id text not null,
  created_by text not null,
  assigned_to text not null,
  job_no int not null,
  type text not null check (type in ('work','break','drive')),
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_hours numeric generated always as (
    case when ended_at is null then null
         else extract(epoch from (ended_at - started_at))/3600.0 end
  ) stored
);
create index if not exists idx_time_owner_open on time_entries(owner_id, assigned_to) where ended_at is null;
alter table time_entries add constraint fk_time_job foreign key (job_no, owner_id) references jobs(job_no, owner_id);

4) Confirm/repair messages

Clock in: ✅ Clocked in Justin — Roof Repair — 5:00 PM.

Overlap: ⚠️ You’re already clocked in since 3:02 PM (Roof Repair). Clock out first?

No job: 🤔 No active job. Clock into **Roof Repair** (last used) or pick one?

Retro entry: 🕘 Logged work at 7:00 AM yesterday — Roof Repair.

Move last: 🔧 Moved your last log to **Roof Repair**.

5) Idempotency

If the last command within 15s would create the identical open entry (same actor/job/type/start minute), return the existing row and say “Already clocked in.”

6) RLS & Audit

RLS: row.owner_id = auth.owner_id and assigned_to must be in tenant’s user list.

Automatic audit_log on open/close with deltas.