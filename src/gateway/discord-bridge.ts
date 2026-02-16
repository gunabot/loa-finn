// src/gateway/discord-bridge.ts — Discord interactions bridge (Slice 2 MVP)
//
// Scope:
// - Verify incoming Discord interaction signatures (stub in slice 1)
// - Route workflow-gate button actions
// - Route requirements-interview actions
// - Keep logic framework-agnostic so Hono routes can delegate here

import { ThreadRunStore, type ThreadRunDecision } from "./thread-run-store.js"

export interface DiscordBridgeConfig {
  appId: string
  publicKey: string
  channelId: string
}

export const DISCORD_INTERACTIONS_PATH = "/api/discord/interactions"

export function shouldBypassDiscordApiAuth(discordEnabled: boolean, path: string): boolean {
  return discordEnabled && path === DISCORD_INTERACTIONS_PATH
}

export interface DiscordInteractionHeaders {
  signatureEd25519?: string
  signatureTimestamp?: string
  // Dev/test bypass for the signature stub. Remove when real verification lands.
  debugSignatureBypass?: string
}

export interface DiscordInteractionRequest {
  rawBody: string
  headers: DiscordInteractionHeaders
}

export interface DiscordInteractionResponse {
  status: number
  body: Record<string, unknown>
}

export interface WorkflowGateDecision {
  runId: string
  stepId: string
  decision: "approve" | "reject"
  actorUserId: string | null
}

export interface WorkflowGateDecisionResult {
  ok: boolean
  message?: string
}

export type WorkflowGateDecisionHandler = (
  input: WorkflowGateDecision,
) => Promise<WorkflowGateDecisionResult>

export interface InterviewActionInput {
  action: string
  sessionId: string | null
  actorUserId: string | null
  utterance: string | null
}

export interface InterviewActionResult {
  ok: boolean
  prompt: string
}

export type InterviewActionHandler = (
  input: InterviewActionInput,
) => Promise<InterviewActionResult>

export interface DiscordBridgeDeps {
  workflowGateDecisionHandler?: WorkflowGateDecisionHandler
  interviewActionHandler?: InterviewActionHandler
  threadRunStore?: ThreadRunStore
}

const DISCORD_PING_INTERACTION = 1
const DISCORD_APPLICATION_COMMAND_INTERACTION = 2
const DISCORD_MESSAGE_COMPONENT_INTERACTION = 3
const DISCORD_PONG_RESPONSE = 1
const DISCORD_CHANNEL_MESSAGE_RESPONSE = 4
const DISCORD_EPHEMERAL_FLAG = 64

export const DISCORD_WORKFLOW_CUSTOM_ID_PREFIX = "workflow_gate"
export const DISCORD_INTERVIEW_CUSTOM_ID_PREFIX = "interview"

export class DiscordBridge {
  private readonly config: DiscordBridgeConfig
  private readonly deps: DiscordBridgeDeps
  private readonly threadRunStore: ThreadRunStore

  constructor(config: DiscordBridgeConfig, deps: DiscordBridgeDeps = {}) {
    this.config = config
    this.deps = deps
    this.threadRunStore = deps.threadRunStore ?? new ThreadRunStore()
  }

  /**
   * Slice 1 stub.
   * TODO: Replace with real Ed25519 verification using Discord public key.
   */
  verifySignature(request: DiscordInteractionRequest): boolean {
    if (request.headers.debugSignatureBypass === "1") return true

    // Basic shape checks so we fail closed by default.
    return Boolean(
      request.headers.signatureEd25519
      && request.headers.signatureTimestamp
      && this.config.publicKey,
    ) && false
  }

  async handleInteraction(request: DiscordInteractionRequest): Promise<DiscordInteractionResponse> {
    if (!this.verifySignature(request)) {
      return {
        status: 401,
        body: { error: "Unauthorized", code: "DISCORD_SIGNATURE_INVALID" },
      }
    }

    const payload = safeParseJson(request.rawBody)
    const payloadObj = asRecord(payload)
    if (!payloadObj) {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_PAYLOAD_INVALID_JSON" },
      }
    }

    const interactionType = getNumberField(payloadObj, "type")
    if (interactionType === DISCORD_PING_INTERACTION) {
      return { status: 200, body: { type: DISCORD_PONG_RESPONSE } }
    }

    if (interactionType === DISCORD_MESSAGE_COMPONENT_INTERACTION) {
      const dataObj = getObjectField(payloadObj, "data")
      const customId = getStringField(dataObj, "custom_id")
      if (!customId) {
        return {
          status: 400,
          body: { error: "Bad Request", code: "DISCORD_COMPONENT_CUSTOM_ID_MISSING" },
        }
      }

      if (customId.startsWith(`${DISCORD_WORKFLOW_CUSTOM_ID_PREFIX}:`)) {
        return this.handleWorkflowGateAction(payloadObj)
      }

      if (customId.startsWith(`${DISCORD_INTERVIEW_CUSTOM_ID_PREFIX}:`)) {
        return this.handleInterviewAction(payloadObj)
      }

      return ephemeralMessage(
        "That button is not wired yet. Use workflow gate or interview controls.",
        "DISCORD_COMPONENT_UNHANDLED",
      )
    }

    if (interactionType === DISCORD_APPLICATION_COMMAND_INTERACTION) {
      const commandName = getStringField(getObjectField(payloadObj, "data"), "name")
      if (commandName === "requirements" || commandName === "requirements-interview") {
        return this.handleInterviewAction(payloadObj)
      }
    }

    return {
      status: 202,
      body: {
        ok: true,
        code: "DISCORD_INTERACTION_UNHANDLED",
        interactionType,
      },
    }
  }

  async handleWorkflowGateAction(payload: Record<string, unknown>): Promise<DiscordInteractionResponse> {
    const parsed = parseWorkflowAction(payload)
    if (!parsed) {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_WORKFLOW_ACTION_INVALID" },
      }
    }

    if (parsed.action === "approve") {
      return this.handleApproveAction(payload)
    }
    if (parsed.action === "reject") {
      return this.handleRejectAction(payload)
    }
    return this.handleStatusAction(payload)
  }

  async handleApproveAction(payload: Record<string, unknown>): Promise<DiscordInteractionResponse> {
    return this.handleDecisionAction(payload, "approve")
  }

  async handleRejectAction(payload: Record<string, unknown>): Promise<DiscordInteractionResponse> {
    return this.handleDecisionAction(payload, "reject")
  }

  async handleStatusAction(payload: Record<string, unknown>): Promise<DiscordInteractionResponse> {
    const parsed = parseWorkflowAction(payload)
    if (!parsed || parsed.action !== "status") {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_WORKFLOW_STATUS_INVALID" },
      }
    }

    const threadId = getStringField(payload, "channel_id") ?? this.config.channelId
    if (!threadId) {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_THREAD_ID_MISSING" },
      }
    }

    if (parsed.stepId) {
      const step = this.threadRunStore.getStep({
        threadId,
        runId: parsed.runId,
        stepId: parsed.stepId,
      })
      if (!step) {
        return ephemeralMessage(
          `No status found for ${parsed.runId}/${parsed.stepId}.`,
          "DISCORD_WORKFLOW_STATUS_EMPTY",
        )
      }
      return ephemeralMessage(
        `Status ${parsed.runId}/${parsed.stepId}: ${step.status}.`,
        "DISCORD_WORKFLOW_STATUS_OK",
      )
    }

    const summary = this.threadRunStore.summarizeRun(threadId, parsed.runId)
    return ephemeralMessage(
      `Run ${parsed.runId}: steps=${summary.totalSteps}, approved=${summary.approved}, rejected=${summary.rejected}, pending=${summary.pending}.`,
      "DISCORD_WORKFLOW_STATUS_OK",
    )
  }

  private async handleDecisionAction(
    payload: Record<string, unknown>,
    expectedDecision: ThreadRunDecision,
  ): Promise<DiscordInteractionResponse> {
    const parsed = parseWorkflowAction(payload)
    if (!parsed || parsed.action !== expectedDecision || !parsed.stepId) {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_WORKFLOW_ACTION_INVALID" },
      }
    }

    const actorUserId = getStringField(getObjectField(payload, "user"), "id")
      ?? getStringField(getObjectField(getObjectField(payload, "member"), "user"), "id")
    const threadId = getStringField(payload, "channel_id") ?? this.config.channelId
    if (!threadId) {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_THREAD_ID_MISSING" },
      }
    }

    if (this.deps.workflowGateDecisionHandler) {
      const result = await this.deps.workflowGateDecisionHandler({
        runId: parsed.runId,
        stepId: parsed.stepId,
        decision: expectedDecision,
        actorUserId,
      })
      if (!result.ok) {
        return ephemeralMessage(
          result.message ?? "Workflow gate action was not accepted.",
          "DISCORD_WORKFLOW_ACTION_REJECTED",
        )
      }
    }

    this.threadRunStore.applyDecision({
      threadId,
      runId: parsed.runId,
      stepId: parsed.stepId,
      decision: expectedDecision,
      actorUserId,
    })

    if (!this.deps.workflowGateDecisionHandler) {
      return ephemeralMessage(
        `Captured workflow decision: ${expectedDecision} (${parsed.runId}/${parsed.stepId}). Handler not wired yet.`,
        "DISCORD_WORKFLOW_HANDLER_TODO",
      )
    }

    return ephemeralMessage(
      `Workflow step ${parsed.stepId} marked ${expectedDecision}.`,
      "DISCORD_WORKFLOW_ACTION_ACCEPTED",
    )
  }

  async handleInterviewAction(payload: Record<string, unknown>): Promise<DiscordInteractionResponse> {
    const parsed = parseInterviewAction(payload)
    if (!parsed) {
      return {
        status: 400,
        body: { error: "Bad Request", code: "DISCORD_INTERVIEW_ACTION_INVALID" },
      }
    }

    if (!this.deps.interviewActionHandler) {
      return ephemeralMessage(
        defaultInterviewPrompt(parsed.action),
        "DISCORD_INTERVIEW_HANDLER_TODO",
      )
    }

    const result = await this.deps.interviewActionHandler(parsed)
    if (!result.ok) {
      return ephemeralMessage(
        "I could not process that interview action. Please retry.",
        "DISCORD_INTERVIEW_ACTION_REJECTED",
      )
    }

    return ephemeralMessage(result.prompt, "DISCORD_INTERVIEW_ACTION_ACCEPTED")
  }
}

function ephemeralMessage(message: string, code: string): DiscordInteractionResponse {
  return {
    status: 200,
    body: {
      type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
      data: {
        content: message,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
      code,
    },
  }
}

interface ParsedWorkflowAction {
  action: "approve" | "reject" | "status"
  runId: string
  stepId: string | null
}

function parseWorkflowAction(payload: Record<string, unknown>): ParsedWorkflowAction | null {
  const customId = getStringField(getObjectField(payload, "data"), "custom_id")
  if (!customId) return null

  const parts = customId.split(":")
  if (parts.length < 3 || parts[0] !== DISCORD_WORKFLOW_CUSTOM_ID_PREFIX) return null

  // Preferred format: workflow_gate:<action>:<runId>[:<stepId>]
  const actionCandidate = parts[1]
  if (actionCandidate === "approve" || actionCandidate === "reject") {
    if (parts.length !== 4 || !parts[2] || !parts[3]) return null
    return { action: actionCandidate, runId: parts[2], stepId: parts[3] }
  }
  if (actionCandidate === "status") {
    if (!parts[2]) return null
    const stepId = parts.length >= 4 && parts[3] ? parts[3] : null
    return { action: "status", runId: parts[2], stepId }
  }

  // Legacy format fallback: workflow_gate:<runId>:<stepId>:<decision>
  if (parts.length === 4 && (parts[3] === "approve" || parts[3] === "reject")) {
    if (!parts[1] || !parts[2]) return null
    return { action: parts[3], runId: parts[1], stepId: parts[2] }
  }

  return null
}

function parseInterviewAction(payload: Record<string, unknown>): InterviewActionInput | null {
  const interactionType = getNumberField(payload, "type")
  const dataObj = getObjectField(payload, "data")

  if (interactionType === DISCORD_MESSAGE_COMPONENT_INTERACTION) {
    const customId = getStringField(dataObj, "custom_id")
    if (!customId) return null

    const parts = customId.split(":")
    if (parts.length < 2 || parts[0] !== DISCORD_INTERVIEW_CUSTOM_ID_PREFIX) return null
    const action = parts[1]
    const sessionId = parts.length >= 3 ? parts[2] : null
    if (!action) return null

    return {
      action,
      sessionId,
      actorUserId: getStringField(getObjectField(getObjectField(payload, "member"), "user"), "id")
        ?? getStringField(getObjectField(payload, "user"), "id"),
      utterance: getStringField(dataObj, "value"),
    }
  }

  if (interactionType === DISCORD_APPLICATION_COMMAND_INTERACTION) {
    const commandName = getStringField(dataObj, "name")
    if (commandName !== "requirements" && commandName !== "requirements-interview") return null
    return {
      action: "start",
      sessionId: null,
      actorUserId: getStringField(getObjectField(getObjectField(payload, "member"), "user"), "id")
        ?? getStringField(getObjectField(payload, "user"), "id"),
      utterance: null,
    }
  }

  return null
}

function defaultInterviewPrompt(action: string): string {
  if (action === "start") {
    return "Interview started. In one sentence, what outcome do you want this automation to achieve?"
  }
  if (action === "repeat") {
    return "Please repeat the requirement slowly, one constraint at a time."
  }
  return "Got it. Next, describe constraints: deadline, data sources, and approval points."
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getObjectField(value: unknown, key: string): Record<string, unknown> | null {
  const obj = asRecord(value)
  if (!obj) return null
  return asRecord(obj[key])
}

function getStringField(value: unknown, key: string): string | null {
  const obj = asRecord(value)
  if (!obj) return null
  const field = obj[key]
  return typeof field === "string" && field.trim().length > 0 ? field : null
}

function getNumberField(value: unknown, key: string): number | null {
  const obj = asRecord(value)
  if (!obj) return null
  const field = obj[key]
  return typeof field === "number" && Number.isFinite(field) ? field : null
}
