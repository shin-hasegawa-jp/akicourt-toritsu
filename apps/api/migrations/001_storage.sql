CREATE TABLE park_surfaces (
 park_id text NOT NULL, surface text NOT NULL CHECK(surface IN ('grass','hard')),
 name text NOT NULL, enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(park_id,surface)
);
INSERT INTO park_surfaces VALUES ('1280','grass','東大和南公園',true),('1310','hard','大井ふ頭海浜公園Ａ',true);
CREATE TABLE acquisition_scopes (
 id uuid PRIMARY KEY, park_id text NOT NULL, surface text NOT NULL,
 week_start date NOT NULL CHECK(extract(isodow FROM week_start)=1),
 latest_snapshot_id uuid, latest_job_id uuid,
 FOREIGN KEY(park_id,surface) REFERENCES park_surfaces,
 UNIQUE(park_id,surface,week_start)
);
CREATE TABLE acquisition_jobs (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES acquisition_scopes,
 state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
 queued_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz,
 completed_at timestamptz, error_code text, request_count integer NOT NULL DEFAULT 0 CHECK(request_count>=0),
 duration_ms integer, cooldown_until timestamptz, owner uuid
);
CREATE UNIQUE INDEX one_active_job ON acquisition_jobs(scope_id) WHERE state IN ('queued','running');
CREATE TABLE snapshots (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES acquisition_scopes,
 started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL,
 facility_count integer NOT NULL CHECK(facility_count>0), checked_cells integer NOT NULL CHECK(checked_cells>0),
 UNIQUE(scope_id,id)
);
ALTER TABLE acquisition_scopes ADD FOREIGN KEY(id,latest_snapshot_id) REFERENCES snapshots(scope_id,id);
ALTER TABLE acquisition_jobs ADD UNIQUE(scope_id,id);
ALTER TABLE acquisition_scopes ADD FOREIGN KEY(id,latest_job_id) REFERENCES acquisition_jobs(scope_id,id);
CREATE TABLE snapshot_facilities (
 snapshot_id uuid NOT NULL REFERENCES snapshots, facility_id text NOT NULL, name text NOT NULL,
 PRIMARY KEY(snapshot_id,facility_id)
);
CREATE TABLE slots (
 snapshot_id uuid NOT NULL, facility_id text NOT NULL, use_date date NOT NULL,
 start_minute integer NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
 end_minute integer NOT NULL CHECK(end_minute BETWEEN 1 AND 1439 AND end_minute>start_minute),
 available_courts integer NOT NULL CHECK(available_courts>0),
 FOREIGN KEY(snapshot_id,facility_id) REFERENCES snapshot_facilities,
 PRIMARY KEY(snapshot_id,facility_id,use_date,start_minute,end_minute)
);
CREATE TABLE worker_lease (
 id integer PRIMARY KEY CHECK(id=1), owner uuid, expires_at timestamptz,
 next_request_not_before timestamptz NOT NULL DEFAULT clock_timestamp(), blocked_reason text
);
INSERT INTO worker_lease(id) VALUES(1);
CREATE TABLE holidays (use_date date PRIMARY KEY, name text NOT NULL, source text NOT NULL, updated_at timestamptz NOT NULL);
