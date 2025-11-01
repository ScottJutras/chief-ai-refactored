TIME-CLOCK — SOP (Upgraded)

File: /docs/howto/timeclock.md
Module: handlers/commands/timeclock.js
Depends on: services/postgres.js, resolveJobContext, logTimeEntryWithJob

See also: Shared Contracts
 — tenant RLS, active job context, user resolution, idempotency, and canonical messages.

1) Purpose
Track work, break, and drive time. Every entry must link to a job.

2) Commands
Action	Example	Notes
Create (active job)	task - buy nails	Hyphen after task optional
Create (explicit job)	task Roof Repair - order shingles	Parses job before -
Assign	task @Justin - pick up materials	@everyone allowed
List	tasks / my tasks	Owner/Board see all; employees see own
Done	done #4 / mark 4 done	By ID
Due date	due #3 Friday 4pm / add due date Friday to task 3	Natural dates
Reassign	assign #7 @Aly	Changes assigned_to

NLU tokens:

#ID resolves task by ID.

@Name resolves assignee (must belong to same owner).

3) Flow

Resolve job via createTaskWithJob({ ownerId, title, jobName? }). If none, attach to Unassigned.

Parse assignee: default = sender; @ mention overrides.

Create fields

tasks(
  id serial primary key,
  owner_id text not null,
  created_by text not null,
  assigned_to text not null,
  job_no int not null,
  title text not null,
  status text not null check (status in ('open','done')) default 'open',
  due_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_tasks_owner_status on tasks(owner_id,status);

4) Confirm messages (canonical)

Add: ✅ Task added: Buy nails — (Roof Repair).

List: 📋 Here’s what’s on your plate: then • #4 Buy nails — Roof Repair — due Fri

Done: ✅ Marked #4 done.

Due set: 🗓️ #4 due Fri 4:00 PM.

5) Edge cases

Duplicate titles allowed; #ID is source of truth.

No active job → prompt to pick or use Unassigned.

Reassign to unknown user → offer closest matches.

6) Idempotency

Creating an identical task within 30s window from same user/job → return existing with “Already added a moment ago (#ID).” (server-side de-dupe by (owner_id, assigned_to, job_no, sha(lower(title)), time_window)).

7) Audit & RLS

Store created_by, modified_by. Enforce row.owner_id = auth.owner_id. FK (job_no, owner_id) to jobs.