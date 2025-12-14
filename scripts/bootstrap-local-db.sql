CREATE TABLE IF NOT EXISTS employees (
  id         serial PRIMARY KEY,
  owner_id   text    NOT NULL,
  name       text    NOT NULL,
  role       text    NOT NULL,
  created_at timestamp NOT NULL,
  phone      text,
  active     boolean NOT NULL DEFAULT true
);


CREATE TABLE IF NOT EXISTS jobs (
  id         serial PRIMARY KEY,
  owner_id   varchar NOT NULL,
  job_name   varchar NOT NULL,
  active     boolean DEFAULT true,
  start_date timestamp DEFAULT CURRENT_TIMESTAMP,
  end_date   timestamp,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz,
  job_no     integer NOT NULL,
  name       text,
  status     text NOT NULL DEFAULT 'active'
);


CREATE TABLE IF NOT EXISTS states (
  user_id    text   NOT NULL,
  state      jsonb  NOT NULL DEFAULT '{}'::jsonb,
  data       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS time_entries (
  id            serial PRIMARY KEY,
  owner_id      varchar,
  employee_name varchar NOT NULL,
  type          varchar NOT NULL,
  "timestamp"   timestamp NOT NULL,
  created_at    timestamp DEFAULT CURRENT_TIMESTAMP,
  job_name      text,
  tz            text,
  local_time    timestamp,
  lat           double precision,
  lng           double precision,
  address       text,
  user_id       text NOT NULL,
  job_no        integer
);


