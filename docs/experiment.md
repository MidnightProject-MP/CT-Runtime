# A/B/C Continuity Experiment

Run the fixed workload on Cloud Run, Oracle A1, then a fresh Cloud Run job. Record each result with `lib/experiment.mjs` using the same image digest, config digest, Git commit, database, and bucket. Compare execution IDs, work orders, fences, evidence hashes, Observer hashes, and exit states. `verified` remains false until an independent review confirms all acceptance criteria; this repository does not claim a cloud result.
