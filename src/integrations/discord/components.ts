// src/integrations/discord/components.ts
// Discord Components v2 builders for workflow gate controls.

export type WorkflowButtonAction = "approve" | "reject" | "status"

export interface WorkflowButtonPayload {
  threadId: string
  runId: string
  action: WorkflowButtonAction
}

export interface DiscordButtonComponentV2 {
  type: 2
  style: 1 | 2 | 3 | 4
  label: string
  custom_id: string
}

export interface DiscordActionRowComponentV2 {
  type: 1
  components: DiscordButtonComponentV2[]
}

export interface WorkflowActionRowsOptions {
  threadId: string
  runId: string
  approveLabel?: string
  rejectLabel?: string
  statusLabel?: string
}

const CUSTOM_ID_PREFIX = "workflow_v2"

export function encodeWorkflowButtonCustomId(payload: WorkflowButtonPayload): string {
  return `${CUSTOM_ID_PREFIX}:${payload.action}:${escapeToken(payload.threadId)}:${escapeToken(payload.runId)}`
}

export function decodeWorkflowButtonCustomId(customId: string): WorkflowButtonPayload | null {
  const parts = customId.split(":")
  if (parts.length !== 4) return null
  if (parts[0] !== CUSTOM_ID_PREFIX) return null

  const action = parts[1]
  if (action !== "approve" && action !== "reject" && action !== "status") return null

  return {
    action,
    threadId: unescapeToken(parts[2]),
    runId: unescapeToken(parts[3]),
  }
}

export function buildWorkflowActionRows(options: WorkflowActionRowsOptions): DiscordActionRowComponentV2[] {
  const approveLabel = options.approveLabel ?? "Approve"
  const rejectLabel = options.rejectLabel ?? "Reject"
  const statusLabel = options.statusLabel ?? "Status"

  const row: DiscordActionRowComponentV2 = {
    type: 1,
    components: [
      buildButton({
        threadId: options.threadId,
        runId: options.runId,
        action: "approve",
      }, approveLabel, 3),
      buildButton({
        threadId: options.threadId,
        runId: options.runId,
        action: "reject",
      }, rejectLabel, 4),
      buildButton({
        threadId: options.threadId,
        runId: options.runId,
        action: "status",
      }, statusLabel, 2),
    ],
  }

  return [row]
}

function buildButton(
  payload: WorkflowButtonPayload,
  label: string,
  style: DiscordButtonComponentV2["style"],
): DiscordButtonComponentV2 {
  return {
    type: 2,
    style,
    label,
    custom_id: encodeWorkflowButtonCustomId(payload),
  }
}

function escapeToken(value: string): string {
  return encodeURIComponent(value)
}

function unescapeToken(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
