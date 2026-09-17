# vNext migration 006: project mutation authority

Migration `006_project_mutation_authority.sql` makes `project_id` part of the durable identity of every vNext Work Unit and Execution and creates the per-project mutation-authority table.

## Upgrade rule

The migration is deliberately fail-closed. It adds the columns first, then aborts if any pre-existing Work Unit or Execution has `project_id IS NULL`, if any Execution's project differs from its Work Unit's project, or if an Execution references a missing Work Unit. After those checks pass, the migration sets both `project_id` columns `NOT NULL`, so the invariant is enforced for direct SQL writes as well as application writes. Do **not** invent a project identifier, copy an identifier from an unrelated field, or run the migration repeatedly hoping invalid rows will resolve themselves.

For a database that already contains vNext rows, the historical backfill is a **two-phase upgrade** because migration 006 owns creation of the new columns:

### Phase 1: add nullable columns and backfill historical rows

Run this preparation manually, or as an equivalent controlled preflight migration, **before** applying `006_project_mutation_authority.sql`:

1. Take the normal database backup/snapshot required for a schema migration.
2. Add the new columns as nullable. This is intentionally only the temporary pre-migration shape; migration 006 will later make both columns `NOT NULL`.

   ```sql
   ALTER TABLE public.vnext_work_units
     ADD COLUMN IF NOT EXISTS project_id text;

   ALTER TABLE public.vnext_executions
     ADD COLUMN IF NOT EXISTS project_id text;
   ```

3. Inventory rows that need a project identity:

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

4. Obtain the authoritative project mapping from the system that owns project identity. The mapping must be deterministic and must assign exactly one project to each existing Work Unit. Execution rows inherit the project of their Work Unit; do not independently guess execution ownership.
5. Validate the proposed mapping before changing the database. The following checks should return zero rows:

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
6. Apply the reviewed mapping transactionally, for example:

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

   -- This must also return zero before COMMIT.
   SELECT COUNT(*) AS executions_with_project_mismatch
   FROM public.vnext_executions AS e
   JOIN public.vnext_work_units AS w USING (work_unit_id)
   WHERE e.project_id <> w.project_id;

   COMMIT;
   ```

   If any check is non-zero, roll back and reconcile the mapping before proceeding.

### Phase 2: apply migration 006

After Phase 1 has committed successfully, apply `006_project_mutation_authority.sql` normally through the repository migration runner. The migration independently repeats the NULL, mismatch, and orphan checks before adding the foreign key and setting `NOT NULL`. If any check reports a violation, stop and reconcile the mapping rather than weakening the migration.

The preparation in Phase 1 does **not** mark migration 006 as applied. Migration 006 must still run so that its schema constraints, authority table, indexes, and deferred integrity triggers are installed and its fail-closed validation is executed.

For a fresh database there is no historical backfill: all producers creating vNext Work Units must supply `project_id`, and `createExecution()` propagates that identity from the Work Unit.

## Important limitation

This repository does not currently define a deterministic project mapping for historical rows. Therefore this document intentionally provides the **upgrade procedure and validation contract**, not a fabricated application-specific backfill query. The operator must populate `project_backfill` from the authoritative project system before migration 006 is applied.

## Post-migration invariant

After migration 006 completes, `project_id` is `NOT NULL` on both Work Units and Executions. The composite foreign key additionally requires each Execution's project to match its Work Unit, and the authority table's composite foreign key requires its Work Unit, Execution, and project identities to correspond.
