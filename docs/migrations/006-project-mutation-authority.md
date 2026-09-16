# vNext migration 006: project mutation authority

Migration `006_project_mutation_authority.sql` makes `project_id` part of the durable identity of every vNext Work Unit and Execution and creates the per-project mutation-authority table.

## Upgrade rule

The migration is deliberately fail-closed. It adds the columns first, then aborts if any pre-existing Work Unit or Execution has `project_id IS NULL`. Do **not** invent a project identifier, copy an identifier from an unrelated field, or run the migration repeatedly hoping the NULL rows will resolve themselves.

Before applying migration 006 to a database that already contains vNext rows:

1. Take the normal database backup/snapshot required for a schema migration.
2. Inventory rows that need a project identity:

   ```sql
   SELECT work_unit_id, objective_ref
   FROM public.vnext_work_units
   WHERE project_id IS NULL
   ORDER BY work_unit_id;

   SELECT execution_id, work_unit_id
   FROM public.vnext_executions
   WHERE project_id IS NULL
   ORDER BY execution_id;
   ```

3. Obtain the authoritative project mapping from the system that owns project identity. The mapping must be deterministic and must assign exactly one project to each existing Work Unit. Execution rows inherit the project of their Work Unit; do not independently guess execution ownership.
4. Validate the proposed mapping before changing the database. The following checks should return zero rows:

   ```sql
   -- Replace `project_backfill` with the reviewed, temporary mapping relation.
   SELECT w.work_unit_id
   FROM public.vnext_work_units AS w
   JOIN project_backfill AS b USING (work_unit_id)
   WHERE w.project_id IS NULL
     AND b.project_id IS NULL;

   SELECT e.execution_id
   FROM public.vnext_executions AS e
   JOIN public.vnext_work_units AS w USING (work_unit_id)
   JOIN project_backfill AS b USING (work_unit_id)
   WHERE e.project_id IS NULL
     AND (b.project_id IS NULL OR w.project_id IS NOT NULL AND w.project_id <> b.project_id);
   ```

   Also verify that the mapping contains exactly one project row per affected Work Unit and that every affected Execution references a Work Unit present in the mapping.
5. Apply the reviewed mapping transactionally, for example:

   ```sql
   BEGIN;

   UPDATE public.vnext_work_units AS w
   SET project_id = b.project_id
   FROM project_backfill AS b
   WHERE w.work_unit_id = b.work_unit_id
     AND w.project_id IS NULL;

   UPDATE public.vnext_executions AS e
   SET project_id = w.project_id
   FROM public.vnext_work_units AS w
   WHERE e.work_unit_id = w.work_unit_id
     AND e.project_id IS NULL;

   -- Both checks must return zero before COMMIT.
   SELECT COUNT(*) AS work_units_missing_project
   FROM public.vnext_work_units
   WHERE project_id IS NULL;

   SELECT COUNT(*) AS executions_missing_project
   FROM public.vnext_executions
   WHERE project_id IS NULL;

   COMMIT;
   ```

6. Apply `006_project_mutation_authority.sql`. If the migration still reports a NULL project identity, stop and reconcile the mapping rather than weakening the migration.

## Important limitation

This repository does not currently define a deterministic project mapping for historical rows. Therefore this document intentionally provides the **upgrade procedure and validation contract**, not a fabricated application-specific backfill query. The operator must populate `project_backfill` from the authoritative project system before migration 006 is applied.

For a fresh database there is no historical backfill: all producers creating vNext Work Units must supply `project_id`, and `createExecution()` propagates that identity from the Work Unit.

## Post-migration hardening

The migration keeps the new columns nullable because historical compatibility is handled by the explicit fail-closed precondition. A future migration may make `project_id` `NOT NULL` after production backfill has been independently qualified; that is not part of Stage 2 A7.
