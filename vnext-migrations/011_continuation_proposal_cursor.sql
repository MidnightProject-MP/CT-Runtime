-- Continuation-proposal cursor: keeps worker proposals discoverable.
--
-- Before this, removing the immediate-continuation fallback left work in
-- `actionable` state that nextEligible() could not discover: no unconsumed
-- input and no coordinator-set wake time. The proposal was durable in
-- vnext_continuations but nothing marked it as considered.
--
-- `considered_proposal_id` records the newest continuation proposal a
-- settlement has already dispatched against. A proposal newer than the cursor
-- makes the work eligible again. The coordinator still performs admission: the
-- cursor records consideration, never grants dispatch.
--
-- Forward-only. Never edit applied migrations.

ALTER TABLE public.vnext_pilot_progress
  ADD COLUMN IF NOT EXISTS considered_proposal_id bigint NOT NULL DEFAULT 0
  CHECK (considered_proposal_id >= 0);

-- Existing pilot work has continuation proposals that predate the cursor. They
-- are backfilled as considered: their turns were already dispatched against, and
-- backfilling them as unconsidered would replay settled turns as new work.
UPDATE public.vnext_pilot_progress p
  SET considered_proposal_id = COALESCE((
    SELECT max(c.id)
    FROM public.vnext_continuations c
    JOIN public.vnext_executions e ON e.execution_id = c.execution_id
    WHERE c.work_unit_id = p.work_unit_id
      AND e.state IN ('succeeded', 'failed', 'expired')
      AND p.consumed_input_seq > 0
  ), 0)
  WHERE p.considered_proposal_id = 0
    AND EXISTS (
      SELECT 1
      FROM public.vnext_continuations c
      JOIN public.vnext_executions e ON e.execution_id = c.execution_id
      WHERE c.work_unit_id = p.work_unit_id
        AND e.state IN ('succeeded', 'failed', 'expired')
    );
