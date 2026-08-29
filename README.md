# CT-Runtime

CT-Runtime is an experimental, single-machine V1 filesystem-backed execution mechanic for Celestan. It does not choose task meaning, models, agents, stopping decisions, reflection, or wake requests. The caller or supervisor supplies those values. State is always outside this repository in `--store`. It makes no production claim.

## CLI

```powershell
node bin/ct-runtime.mjs run --store C:\temp\ct --project demo --task "inspect" --model provider/model --agent build --cwd C:\work --opencode opencode
node bin/ct-runtime.mjs schedule --store C:\temp\ct --time 2030-01-01T00:00:00Z --reason maintenance --priority normal --project demo
node bin/ct-runtime.mjs scheduler --store C:\temp\ct --model provider/model --agent build --task "inspect" --cwd C:\work --observer C:\Celestan\projects\CT-Foundry\capabilities\observer\observer.mjs --opencode opencode
node bin/ct-runtime.mjs recover --store C:\temp\ct
node bin/ct-runtime.mjs observe-pending --store C:\temp\ct --observer C:\Celestan\projects\CT-Foundry\capabilities\observer\observer.mjs --semantic-result C:\temp\semantic.json
node bin/ct-runtime.mjs status --store C:\temp\ct
```

`scheduler` is a one-shot Task Scheduler entry point. It claims due wakes durably and launches each with the supervisor's model, agent, bootstrap task, cwd, executable, and optional Observer path. Each schedule stores one deterministic execution/work-order identity; stale interrupted claims are reclaimed for that same execution. A schedule is completed only after launch returns; duplicate schedule and claim calls are safe.

## Result handoff

Every non-dry run receives `CT_RUNTIME_RESULT_FILE` and a bootstrap prompt requiring exactly this JSON object:

```json
{"status":"complete","summary":"bounded factual summary","requested_next_wake":null}
```

The only accepted keys are `status`, `summary`, and `requested_next_wake`. The latter is either `null` or exactly `{time,reason,priority,project}`. Invalid or missing handoff is a bounded validation failure and never causes a guessed wake. A valid request is persisted and scheduled by digest idempotency.

## Recovery and observation

`recover` scans stale `manifested`, `running`, `retrying`, and `requeued` executions using the persisted lease TTL contract, fences the old lease, records the interrupted attempt as crashed, and requeues infrastructure recovery up to a bounded limit. It never reports success or fabricates a terminal recovered state. Terminal records are eligible for `observe-pending`; the manifest records pending, observed, or bounded pending failure. The runtime creates only an Observer digest and semantic task. A caller must provide a validated semantic JSON file or configure an external OpenCode reflection invocation; runtime never invents semantic content.

## Safety and retention

Stdout and stderr are retained as redacted raw evidence, capped at 64 KiB per stream. Manifests record retrievable URI and SHA-256 references, byte counts, and truthful truncation flags. Events and telemetry contain bounded fields and no raw stderr. `--secret-name NAME` selects explicit secret names from the inherited/child environment for redaction; secret values are never persisted. This allowlist is not a claim that arbitrary model output is secret-free.

## V1 limitations

- An external supervisor is required for scheduling, recovery, retention, and policy.
- An Observer semantic provider is not configured by default.
- OpenCode fields are unavailable unless an adapter supplies them; unsupported topology, task, and orchestration fields are not projected as if they survived Foundry projection.
- This is not a production deployment claim.
- Observer immutable conflict detection remains external to this runtime.

Manifest, event, telemetry, schedule, and Observer files are retained until the caller removes the selected store. No automatic retention or deletion policy is hidden in the runtime.
