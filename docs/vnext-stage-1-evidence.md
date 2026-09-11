# vNext Stage 1 recovery evidence

Stage 1 is limited to durable outer-loop mechanics. It does not claim a live
Feedback source, GAS operation, deployment, or terminal objective judgment.
The PostgreSQL suite is the acceptance evidence; the in-memory suite is only a
fast reference implementation.

| Guarantee | Durable mechanism | PostgreSQL evidence |
| --- | --- | --- |
| Receipt identity is canonical | `vnext_events.event_id` is unique and conflict-checked; receipt status is separate from processing | `Neon consumes duplicate wakes once and rejects event identity collisions`; `Neon keeps a received event discoverable when processing stops before execution` |
| Claim ownership is exclusive | Work Unit row lock, monotonically increasing fence, owner and claim fence | `two concurrent wakes cannot both claim one Work Unit` |
| Expiry permits takeover, not concurrency | Bounded `claim_expires_at`; expired execution is marked `expired` before successor claim | `Neon takes over an expired claim and fences out the dead execution` |
| Settlements are atomic | One transaction updates execution, continuation/evidence, settlement attempt, and Work Unit | `Neon settlement rolls back all mutations when Work Unit transition fails` |
| Failure is bounded | Attempt count, retry timestamp, and `review` bound | `Neon persists bounded failure retry state` |
| Settlement identity is exact | Settlement attempt binds event, Work Unit, execution, and fence | `Neon readback is exact and preserves uncertainty when the database becomes unavailable` verifies the committed execution/fence identity |
| Lost settlement responses are safe | `003_settlement_attempts.sql` records the committed result in the settlement transaction; readback verifies it | `an ambiguous committed settlement is not replayed for the same event` is the memory seam; `Neon readback is exact and preserves uncertainty when the database becomes unavailable` verifies durable committed readback |
| Readback uncertainty is preserved | Readback distinguishes committed, same-authority-active, superseded, definitively-uncommitted, and inconclusive | `Neon readback is exact and preserves uncertainty when the database becomes unavailable` verifies committed and inconclusive database readback; `Neon rejects stale settlement and preserves a newer claim` verifies supersession |
| Processing recovery is non-executing | A bounded supervisor scan marks stale active executions `expired`; the claim remains fenced for takeover | `Neon takes over an expired claim and fences out the dead execution` plus `processing recovery expires stale executions without starting successor work` |

The migration runner is independent from the application schema lineage. It applies
only missing, checksum-matching files; an already-applied version is never rerun
with different SQL.

Run the real database evidence with:

```text
TEST_DATABASE_URL=postgresql://... node --test test/vnext-neon.integration.test.mjs
```

The suite is skipped when `TEST_DATABASE_URL` is absent. A skipped run is not
PostgreSQL evidence.
