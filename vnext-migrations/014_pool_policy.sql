-- Coordinator-owned concurrency pool (Milestone 1D, item D2). Pool accounting
-- is not a second table: the project mutation authority row is the single
-- durable fact that an attempt occupies a slot, so the count can never orphan
-- or drift from the attempts actually holding authority (mirroring the memory
-- store, which derives reservations from reconstructed authorities).
--
-- This table holds the durable pool policy so a shared database enforces one
-- bound for every writer. The row is established by the first writer that is
-- configured with a capacity (under the pool advisory lock); afterwards every
-- writer must agree with it - a writer configured differently fails closed,
-- and an unconfigured writer adopts the durable policy. A row with a NULL
-- max_concurrency is an explicit operator statement that the pool is
-- unbounded; a configured writer then conflicts rather than silently
-- re-bounding the pool. Absent row + unconfigured writers means unbounded.
CREATE TABLE IF NOT EXISTS vnext_pool_policy (
  policy text PRIMARY KEY,
  max_concurrency integer CHECK (max_concurrency IS NULL OR max_concurrency >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
