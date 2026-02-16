// src/integrations/discord/interaction-router.ts
// Routes Discord button interactions to workflow run decisions/status.

import { ThreadRunStore, type ThreadRunDecision } from "../../gateway/thread-run-store.js"

export interface DiscordButtonInteractionLike {
  customId: string
  channelId: string | null
  user?: { id?: string | null } | null
  replied?: boolean
  deferred?: boolean
  reply(options: { content: string; ephemeral?: boolean }): Promise<unknown>
  followUp?(options: { content: string; ephemeral?: boolean }): Promise<unknown>
  editReply?(options: { content: string }): Promise<unknown>
}

export interface DiscordInteractionLike {
  isButton?(): boolean
  customId?: string
  channelId?: string | null
  user?: { id?: string | null } | null
  replied?: boolean
  deferred?: boolean
  reply?(options: { content: string; ephemeral?: boolean }): Promise<unknown>
  followUp?(options: { content: string; ephemeral?: boolean }): Promise<unknown>
  editReply?(options: { content: string }): Promise<unknown>
}

interface DiscordInteractionRouterOptions {
  threadRunStore?: ThreadRunStore
  allowedChannelIds?: string[]
  logger?: {
    info(message: string): void
    warn(message: string): void
  }
}

interface ParsedWorkflowAction {
  action: "approve" | "reject" | "status"
  runId: string
  stepId: string | null
}

const CUSTOM_ID_PREFIX = "workflow_gate"

export class DiscordInteractionRouter {
  private readonly threadRunStore: ThreadRunStore
  private readonly allowedChannelIds: Set<string>
  private readonly logger: {
    info(message: string): void
    warn(message: string): void
  }

  constructor(options: DiscordInteractionRouterOptions = {}) {
    this.threadRunStore = options.threadRunStore ?? new ThreadRunStore()
    this.allowedChannelIds = new Set((options.allowedChannelIds ?? []).filter(Boolean))
    this.logger = options.logger ?? console
  }

  async routeInteraction(interaction: DiscordInteractionLike): Promise<boolean> {
    if (!isButtonInteraction(interaction)) return false

    const channelId = interaction.channelId
    if (!channelId) {
      await respondEphemeral(interaction, "This interaction has no channel context.")
      return true
    }

    if (this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(channelId)) {
      await respondEphemeral(interaction, "This channel is not enabled for workflow controls.")
      return true
    }

    const parsed = parseWorkflowAction(interaction.customId)
    if (!parsed) return false

    if (parsed.action === "status") {
      await this.replyStatus(interaction, channelId, parsed)
      return true
    }

    await this.applyDecision(interaction, channelId, parsed)
    return true
  }

  private async applyDecision(
    interaction: DiscordButtonInteractionLike,
    channelId: string,
    parsed: ParsedWorkflowAction,
  ): Promise<void> {
    if (!parsed.stepId) {
      await respondEphemeral(interaction, "Step id is required for approve/reject.")
      return
    }

    const actorUserId = interaction.user?.id ?? null
    const decision = parsed.action as ThreadRunDecision
    const updated = this.threadRunStore.applyDecision({
      threadId: channelId,
      runId: parsed.runId,
      stepId: parsed.stepId,
      decision,
      actorUserId,
    })

    this.logger.info(
      `[discord] workflow ${decision} thread=${channelId} run=${parsed.runId} step=${parsed.stepId} actor=${actorUserId ?? "unknown"}`,
    )
    await respondEphemeral(
      interaction,
      `Recorded ${updated.status} for ${updated.runId}/${updated.stepId}.`,
    )
  }

  private async replyStatus(
    interaction: DiscordButtonInteractionLike,
    channelId: string,
    parsed: ParsedWorkflowAction,
  ): Promise<void> {
    if (parsed.stepId) {
      const step = this.threadRunStore.getStep({
        threadId: channelId,
        runId: parsed.runId,
        stepId: parsed.stepId,
      })
      if (!step) {
        await respondEphemeral(interaction, `No status found for ${parsed.runId}/${parsed.stepId}.`)
        return
      }
      await respondEphemeral(interaction, `Status ${parsed.runId}/${parsed.stepId}: ${step.status}.`)
      return
    }

    const summary = this.threadRunStore.summarizeRun(channelId, parsed.runId)
    await respondEphemeral(
      interaction,
      `Run ${parsed.runId}: approved=${summary.approved}, rejected=${summary.rejected}, pending=${summary.pending}.`,
    )
  }
}

function isButtonInteraction(interaction: DiscordInteractionLike): interaction is DiscordButtonInteractionLike {
  if (typeof interaction.isButton === "function") return interaction.isButton()
  return Boolean(
    typeof interaction.customId === "string"
    && typeof interaction.reply === "function"
    && interaction.customId.length > 0,
  )
}

function parseWorkflowAction(customId: string): ParsedWorkflowAction | null {
  const parts = customId.split(":")
  if (parts.length < 3 || parts[0] !== CUSTOM_ID_PREFIX) return null

  // Preferred format: workflow_gate:<action>:<runId>[:<stepId>]
  const action = parts[1]
  if (action === "approve" || action === "reject") {
    if (parts.length !== 4 || !parts[2] || !parts[3]) return null
    return { action, runId: parts[2], stepId: parts[3] }
  }

  if (action === "status") {
    if (!parts[2]) return null
    return { action: "status", runId: parts[2], stepId: parts[3] ?? null }
  }

  // Legacy format: workflow_gate:<runId>:<stepId>:<decision>
  if (parts.length === 4 && (parts[3] === "approve" || parts[3] === "reject")) {
    if (!parts[1] || !parts[2]) return null
    return { action: parts[3], runId: parts[1], stepId: parts[2] }
  }

  return null
}

async function respondEphemeral(
  interaction: DiscordButtonInteractionLike,
  content: string,
): Promise<void> {
  if (interaction.replied && typeof interaction.followUp === "function") {
    await interaction.followUp({ content, ephemeral: true })
    return
  }
  if (interaction.deferred && typeof interaction.editReply === "function") {
    await interaction.editReply({ content })
    return
  }
  await interaction.reply({ content, ephemeral: true })
}
