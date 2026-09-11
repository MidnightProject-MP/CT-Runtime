# Feedback input identity contract

This is the pure Node contract for feedback identity. It is intentionally not
wired into `gas/gas_feedback.js`; the existing sheet layout, header guards, and
admission behavior remain unchanged.

`createSourceIdentity(sourceKey)` requires a non-empty string supplied by the
adapter as its stable key. `createFeedbackInput({ source, messageKey, content,
observedAt, author })` requires an immutable source-record/event key.
The resulting message ID is scoped to the source and message key, never to
content or physical position. Therefore moving a row preserves identity, while
two records containing identical text remain distinct.

`appendRevision(input, { content, observedAt })` returns a new frozen value.
The old value and every prior revision occurrence remain unchanged. Revision
numbers are contiguous and each occurrence has its own ID and original
observation timestamp, so `A -> B -> A` is three occurrences, not a collapse
to one content identity. Authorship is explicitly `{ kind: "unknown" }` until
an authoritative author field exists; the module does not infer authorship.

`validateFeedbackInput` enforces the invariants: frozen identities/history,
stable source/message IDs, contiguous revision numbers, canonical ISO
timestamps, preserved first-observation time, and unknown-only authorship.
