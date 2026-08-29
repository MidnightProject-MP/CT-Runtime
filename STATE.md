# CT-Runtime State

CT-Runtime is an experimental single-machine V1. It carries no production claim.

State is caller-owned and lives under the selected `--store`: manifests, leases, lock files, schedules, bounded raw evidence, result handoffs, events, telemetry, and the Observer bridge directory. Files are retained indefinitely unless the external supervisor applies its own reviewed retention policy.

The external supervisor supplies model, agent, bootstrap task, cwd, executable, timeout/retry bounds, and Observer path. Task Scheduler may invoke the one-shot `scheduler` command and periodically invoke `recover` and `observe-pending`.

Residual limitations: an external supervisor is required; an Observer semantic provider is not configured by default; OpenCode fields are unavailable unless an adapter supplies them; unsupported topology, task, and orchestration fields are not claimed to survive Foundry projection; and Observer immutable conflict detection remains external.
