# OpenCode Routing Proof

## Failure Found

The global OpenCode configuration had no agent definitions. Calls to the
built-in `general` subagent therefore had no explicit model and inherited the
parent session model. The recent implementation children were recorded as:

| Child sessions | Agent | Actual model | Variant |
| --- | --- | --- | --- |
| `ses_fa512541cffeu11OxtTUoW9m8k`, `ses_fa51253e6ffe0Krm6XJHLkvsON` | `general` | `openai/gpt-5.6-sol` | `medium` |

## Intended Route

The verified OpenCode catalog lists `openai/gpt-5.6-luna` and the configured
variant is `default`. `openai/gpt-5.6-luna-fast` is a separate catalog model,
not an assumed variant, and is not used as fallback.

Implementation work must use the global `luna-implementation` subagent, whose
agent definition explicitly binds that model and variant. A routing-policy
plugin refuses implementation-shaped calls targeting an unbound generic agent.

## Controlled Proof

Sol parent session: `ses_fa4f25af3ffeIe5fRHOLnqSeHg`.

Child session: `ses_fa4f1f008ffehW6f6KwaZ0Ixjf`.

The child-session database metadata records:

```json
{
  "agent": "luna-implementation",
  "model": {
    "providerID": "openai",
    "modelID": "gpt-5.6-luna"
  }
}
```

The intended route and actual execution route agree. The child made no file
changes. This is database-backed evidence, not a claim based on the child's
response.

## Reciprocal Proof

Luna parent session: `ses_fa4ec45b4ffeULCS0DAhgzz5DN`.

Sol child session: `ses_fa4ebfd1cffeCIKqk9XmA3bSu1`.

The child-session database records `agent: sol-strategic` and
`modelID: gpt-5.6-sol` with variant `medium`. The parent process timed out
while the read-only child continued, so this proof establishes route and
actual model attribution, not parent command completion.
