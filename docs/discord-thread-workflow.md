# Discord Thread Workflow

This runtime supports driving Finn from a Discord thread with:

- workflow gate buttons (`Approve`, `Reject`, `Status`)
- thread-scoped requirements interview prompts
- in-memory gate status persistence keyed by `threadId + runId`

## API Notes

### Interaction ingress

- Endpoint: `POST /api/discord/interactions`
- Path bypasses regular `/api/*` bearer auth when `DISCORD_ENABLED=true`.
- Signature verification is currently a fail-closed stub unless debug header bypass is used.

### Workflow button custom IDs

- Preferred Components v2 format: `workflow_v2:<action>:<threadId>:<runId>`
- Supported actions: `approve`, `reject`, `status`
- Legacy workflow format remains accepted:
- `workflow_gate:<action>:<runId>:<stepId>`
- `workflow_gate:<runId>:<stepId>:<decision>`

### Persistence behavior

- `ThreadRunStore` is in-memory for MVP and shared by both:
- Discord webhook bridge (`src/gateway/discord-bridge.ts`)
- Discord bot interaction router (`src/integrations/discord/interaction-router.ts`)
- Run-level decisions from v2 IDs are stored under step id `__run_gate__`.

## Interview UX Notes

- Interview flow phases: `PROBLEM`, `USERS`, `FEATURES`, `CONSTRAINTS`, `PRIORITIES`, `SUMMARY`, `CONFIRM`
- Each phase asks 1-3 guided questions.
- State is keyed by `threadId + runId` in `RequirementsFlow`.
- Thread replies include workflow buttons to keep gate actions available during interview.

## Migration Notes

### From older workflow button IDs

If you currently generate workflow IDs like:

- `workflow_gate:<runId>:<stepId>:approve`

move to:

- `workflow_v2:approve:<threadId>:<runId>`

Key migration changes:

- Thread identity is encoded directly in the custom ID.
- Run-level gate decisions do not require explicit step IDs.
- Status lookups can target full run summaries without step granularity.

### Deployment notes

- Ensure `DISCORD_ALLOWED_CHANNEL_IDS` includes your Finn thread parent channel(s).
- Keep `DISCORD_CHANNEL_ID` set for fallback/default thread context.
- Voice pipeline is optional; current runtime only ships an attachment transcription stub.
