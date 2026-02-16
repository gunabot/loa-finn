// src/integrations/discord/bot.ts
// Discord.js lifecycle wrapper for Loa/Finn thread workflow control.

import type { FinnConfig } from "../../config.js"
import { RUN_LEVEL_GATE_STEP_ID, ThreadRunStore } from "../../gateway/thread-run-store.js"
import { RequirementsFlow } from "../../interview/requirements-flow.js"
import { buildWorkflowActionRows } from "./components.js"
import { DiscordInteractionRouter } from "./interaction-router.js"
import { DiscordVoiceService } from "./voice.js"

export interface DiscordBotLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

export interface DiscordBotDeps {
  threadRunStore?: ThreadRunStore
  requirementsFlow?: RequirementsFlow
  voiceService?: DiscordVoiceService
  logger?: DiscordBotLogger
}

export interface DiscordBotLifecycle {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
}

interface DiscordJsClientLike {
  on(eventName: string, handler: (...args: unknown[]) => void | Promise<void>): void
  login(token: string): Promise<string>
  destroy(): void
  guilds?: {
    fetch(guildId: string): Promise<{ id?: string; name?: string }>
  }
  user?: {
    tag?: string
  }
}

interface DiscordMessageLike {
  author?: { bot?: boolean }
  channelId?: string | null
  content?: string | null
  attachments?: Iterable<unknown> | Map<unknown, unknown>
  reply?(options: { content: string; components?: unknown[] }): Promise<unknown>
}

interface DiscordInteractionLike {
  channelId?: string | null
  commandName?: string
  replied?: boolean
  deferred?: boolean
  options?: { getString(name: string, required?: boolean): string | null }
  isButton?(): boolean
  isChatInputCommand?(): boolean
  reply?(options: { content: string; ephemeral?: boolean; components?: unknown[] }): Promise<unknown>
  followUp?(options: { content: string; ephemeral?: boolean; components?: unknown[] }): Promise<unknown>
  editReply?(options: { content: string; components?: unknown[] }): Promise<unknown>
}

export async function createDiscordBot(
  config: FinnConfig,
  deps: DiscordBotDeps = {},
): Promise<DiscordBotLifecycle> {
  const logger = deps.logger ?? defaultLogger()

  if (!config.discord.enabled) {
    logger.info("[discord-bot] disabled by config")
    return createNoopBot()
  }

  const token = config.discord.botToken.trim()
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required when DISCORD_ENABLED=true")
  }

  const guildId = (process.env.DISCORD_GUILD_ID ?? "").trim() || null
  const allowedChannelIds = parseAllowedChannelIds(
    config.discord.channelId,
    process.env.DISCORD_ALLOWED_CHANNEL_IDS,
  )

  const threadRunStore = deps.threadRunStore ?? new ThreadRunStore()
  const requirementsFlow = deps.requirementsFlow ?? new RequirementsFlow()
  const voiceService = deps.voiceService ?? new DiscordVoiceService()
  const discordModuleName = "discord.js"
  const discord = await import(discordModuleName)
  const Client = (discord as { Client?: new (config: unknown) => DiscordJsClientLike }).Client
  if (!Client) {
    throw new Error("discord.js Client export not found")
  }

  const intents = buildIntents(discord as Record<string, unknown>)
  const partials = buildPartials(discord as Record<string, unknown>)
  const client = new Client({ intents, partials })

  /** Send a visible message to a channel/thread by ID */
  async function sendToChannel(channelId: string, content: string): Promise<void> {
    try {
      const channel = await (client as any).channels?.fetch(channelId)
      if (channel && typeof channel.send === "function") {
        // Split long messages
        const chunks = splitMessage(content, 1900)
        for (const chunk of chunks) {
          await channel.send(chunk)
        }
      }
    } catch (err) {
      logger.error(`[discord-bot] failed to send to channel ${channelId}`, err)
    }
  }

  const interactionRouter = new DiscordInteractionRouter({
    threadRunStore,
    allowedChannelIds,
    logger,
    async onApprove(channelId, runId, _actorUserId) {
      const summary = requirementsFlow.buildSummary(channelId, runId)
      const prd = formatPRD(runId, summary)
      await sendToChannel(channelId, prd)
      await sendToChannel(channelId, `🚀 **PRD approved and locked.** Next step: build phase.\n\nTo proceed, the build agent will use this PRD as its specification. The implementation will be tracked in this thread.`)
    },
    async onReject(channelId, runId, _actorUserId) {
      await sendToChannel(channelId, `❌ **PRD rejected.** Use \`/requirements\` to start a new interview, or continue discussing changes in this thread.`)
    },
  })

  let running = false

  client.on("ready", async () => {
    logger.info(`[discord-bot] ready as ${client.user?.tag ?? "unknown-user"}`)

    // Register slash commands
    try {
      const { REST, Routes } = await import(discordModuleName)
      const rest = new REST({ version: "10" }).setToken(token)
      const commands = [
        {
          name: "requirements",
          description: "Start a requirements interview for a new project",
          options: [
            {
              name: "project",
              description: "Project name (used as run ID)",
              type: 3, // STRING
              required: false,
            },
          ],
        },
        {
          name: "status",
          description: "Check workflow status for the current thread",
          options: [],
        },
      ]

      if (guildId) {
        await rest.put(
          Routes.applicationGuildCommands(config.discord.appId, guildId),
          { body: commands },
        )
        logger.info(`[discord-bot] registered ${commands.length} guild slash commands`)
      } else {
        await rest.put(
          Routes.applicationCommands(config.discord.appId),
          { body: commands },
        )
        logger.info(`[discord-bot] registered ${commands.length} global slash commands`)
      }
    } catch (error) {
      logger.error("[discord-bot] failed to register slash commands", error)
    }

    if (!guildId || !client.guilds?.fetch) return
    try {
      const guild = await client.guilds.fetch(guildId)
      logger.info(`[discord-bot] connected to guild ${guild.name ?? guild.id ?? guildId}`)
    } catch (error) {
      logger.error(`[discord-bot] failed to fetch guild ${guildId}`, error)
    }
  })

  client.on("interactionCreate", async (rawInteraction: unknown) => {
    const interaction = rawInteraction as DiscordInteractionLike
    try {
      const channelId = interaction.channelId ?? null
      logger.info(`[discord-bot] interaction received: channel=${channelId} isButton=${interaction.isButton?.()} isCommand=${interaction.isChatInputCommand?.()} commandName=${(interaction as any).commandName}`)
      if (!isAllowedChannel(channelId, allowedChannelIds)) {
        logger.warn(`[discord-bot] channel ${channelId} not allowed`)
        return
      }

      const handled = await interactionRouter.routeInteraction(interaction)
      if (handled) return

      if (interaction.isChatInputCommand?.() && interaction.commandName === "status") {
        const runId = deriveRunIdFromChannel(channelId)
        const summary = threadRunStore.summarizeRun(channelId!, runId)
        await replyEphemeral(
          interaction,
          `Run ${runId}: approved=${summary.approved}, rejected=${summary.rejected}, pending=${summary.pending}.`,
          buildWorkflowActionRows({ threadId: channelId!, runId }),
        )
        return
      }

      if (interaction.isChatInputCommand?.() && interaction.commandName === "requirements") {
        const projectName = interaction.options?.getString("project", false)
        const runId = projectName
          ? projectName.replace(/\s+/g, "-").toLowerCase()
          : `project-${Date.now()}`
        if (!channelId) {
          await replyEphemeral(interaction, "Could not determine channel context.")
          return
        }

        // Reply first so we have a message to create a thread from
        if (typeof interaction.reply === "function") {
          await interaction.reply({
            content: `🚀 **Starting requirements interview** for \`${runId}\``,
          })
        }

        // Create a thread from the reply message
        try {
          const reply = await (interaction as any).fetchReply?.()
          if (reply && typeof reply.startThread === "function") {
            const thread = await reply.startThread({
              name: `📋 ${projectName || runId}`,
              autoArchiveDuration: 1440, // 24h
            })
            const threadId = thread.id ?? channelId

            threadRunStore.touchPending({
              threadId,
              runId,
              stepId: RUN_LEVEL_GATE_STEP_ID,
            })
            const prompt = requirementsFlow.start(threadId, runId)
            await thread.send(`**${prompt.phase}**\n${prompt.question}`)
            logger.info(`[discord-bot] created interview thread ${threadId} for ${runId}`)
          } else {
            // Fallback: no thread, run in channel
            threadRunStore.touchPending({
              threadId: channelId,
              runId,
              stepId: RUN_LEVEL_GATE_STEP_ID,
            })
            const prompt = requirementsFlow.start(channelId, runId)
            const fetchedReply = await (interaction as any).followUp?.({
              content: `**${prompt.phase}**\n${prompt.question}`,
            })
            logger.info(`[discord-bot] fallback: interview in channel ${channelId} for ${runId}`)
          }
        } catch (threadErr) {
          logger.error("[discord-bot] failed to create interview thread", threadErr)
          // Still start interview in channel as fallback
          threadRunStore.touchPending({
            threadId: channelId,
            runId,
            stepId: RUN_LEVEL_GATE_STEP_ID,
          })
          const prompt = requirementsFlow.start(channelId, runId)
          await (interaction as any).followUp?.({
            content: `**${prompt.phase}**\n${prompt.question}`,
          })
        }
      }
    } catch (error) {
      logger.error("[discord-bot] interactionCreate handler failed", error)
      await safeInteractionErrorReply(interaction)
    }
  })

  client.on("messageCreate", async (rawMessage: unknown) => {
    const message = rawMessage as DiscordMessageLike
    try {
      if (message.author?.bot) return

      const channelId = message.channelId ?? null
      if (!isAllowedChannel(channelId, allowedChannelIds)) return
      if (!channelId) return

      await handleVoiceAttachments(message, voiceService)

      // In an active interview thread, treat any message as an interview answer
      const activeRunId = requirementsFlow.findActiveRunId(channelId)
      
      if (activeRunId && (message.content ?? "").trim()) {
        const answerText = (message.content ?? "").trim()
        const result = requirementsFlow.answer(channelId, activeRunId, answerText)
        if (!result.accepted) {
          await message.reply?.({ content: "I need a bit more detail — could you elaborate?" })
          return
        }
        if (result.completed) {
          const summary = requirementsFlow.buildSummary(channelId, activeRunId)
          // Split summary into Discord-safe chunks (max 2000 chars)
          const chunks = splitMessage(summary, 1900)
          for (const chunk of chunks) {
            await message.reply?.({ content: chunk })
          }
          // Final message with gate buttons
          const workflowControls = buildWorkflowActionRows({
            threadId: channelId,
            runId: activeRunId,
          })
          await message.reply?.({
            content: `✅ **Interview complete!** Review the summary above, then use the buttons to approve the PRD or request changes.`,
            components: workflowControls,
          })
          return
        }
        // When entering SUMMARY phase, show the draft summary before the question
        if (result.prompt!.phase === "SUMMARY") {
          const draftSummary = requirementsFlow.buildSummary(channelId, activeRunId)
          const fullText = `📝 **Draft Summary**\n\n${draftSummary}`
          const chunks = splitMessage(fullText, 1900)
          for (const chunk of chunks) {
            await message.reply?.({ content: chunk })
          }
          await message.reply?.({
            content: `**${result.prompt!.phase}**\n${result.prompt!.question}`,
          })
        } else {
          await message.reply?.({
            content: `**${result.prompt!.phase}**\n${result.prompt!.question}`,
          })
        }
      }
    } catch (error) {
      logger.error("[discord-bot] messageCreate handler failed", error)
    }
  })

  return {
    async start() {
      if (running) return
      await client.login(token)
      running = true
      logger.info("[discord-bot] login complete")
    },
    async stop() {
      if (!running) return
      client.destroy()
      running = false
      logger.info("[discord-bot] stopped")
    },
    isRunning() {
      return running
    },
  }
}

function createNoopBot(): DiscordBotLifecycle {
  return {
    async start() {},
    async stop() {},
    isRunning() { return false },
  }
}

function defaultLogger(): DiscordBotLogger {
  return {
    info(message: string) { console.log(message) },
    warn(message: string) { console.warn(message) },
    error(message: string, error?: unknown) { console.error(message, error) },
  }
}

function parseAllowedChannelIds(...rawValues: Array<string | undefined>): string[] {
  const output: string[] = []
  for (const raw of rawValues) {
    if (!raw) continue
    for (const part of raw.split(",")) {
      const trimmed = part.trim()
      if (trimmed && !output.includes(trimmed)) output.push(trimmed)
    }
  }
  return output
}

function isAllowedChannel(_channelId: string | null, _allowedChannelIds: string[]): boolean {
  // MVP: allow all channels in the guild. The bot only joins one server.
  // TODO: re-enable allowlist with parent-channel resolution for threads.
  return _channelId !== null
}

function buildIntents(discord: Record<string, unknown>): number[] {
  const bits = discord.GatewayIntentBits as Record<string, number> | undefined
  if (!bits) return []
  return [
    bits.Guilds,
    bits.GuildMessages,
    bits.MessageContent,
  ].filter((value): value is number => typeof value === "number")
}

function buildPartials(discord: Record<string, unknown>): number[] {
  const partials = discord.Partials as Record<string, number> | undefined
  if (!partials) return []
  return [partials.Channel].filter((value): value is number => typeof value === "number")
}

function deriveRunIdFromChannel(channelId: string | null): string {
  return channelId ? `run-${channelId}` : "run-unknown"
}

function parseRunIdFromText(content: string): string | null {
  const match = content.match(/\brun[_-]?id[:= ]+([a-zA-Z0-9._-]+)/i)
  return match?.[1] ?? null
}

function extractAnswerText(content: string): string {
  const marker = "!requirements answer"
  const idx = content.toLowerCase().indexOf(marker)
  if (idx < 0) return content
  return content.slice(idx + marker.length).trim()
}

async function handleVoiceAttachments(
  message: DiscordMessageLike,
  voiceService: DiscordVoiceService,
): Promise<void> {
  const attachments = normalizeAttachments(message.attachments)
  for (const attachment of attachments) {
    if (!voiceService.isAudioAttachment(attachment)) continue
    const transcription = await voiceService.transcribeAttachment(attachment)
    await message.reply?.({
      content: `[voice] ${transcription.transcript} (${transcription.code})`,
    })
  }
}

function normalizeAttachments(input: DiscordMessageLike["attachments"]): Array<{
  name?: string | null
  url: string
  contentType?: string | null
}> {
  if (!input) return []

  const rows: unknown[] = []
  if (input instanceof Map) {
    for (const value of input.values()) rows.push(value)
  } else {
    for (const value of input) rows.push(value)
  }

  const attachments: Array<{ name?: string | null; url: string; contentType?: string | null }> = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    const url = typeof record.url === "string" ? record.url : null
    if (!url) continue
    attachments.push({
      name: typeof record.name === "string" ? record.name : null,
      url,
      contentType: typeof record.contentType === "string" ? record.contentType : null,
    })
  }
  return attachments
}

async function replyEphemeral(
  interaction: DiscordInteractionLike,
  content: string,
  components?: unknown[],
): Promise<void> {
  if (interaction.replied && typeof interaction.followUp === "function") {
    await interaction.followUp({ content, flags: [1 << 6], components })
    return
  }
  if (interaction.deferred && typeof interaction.editReply === "function") {
    await interaction.editReply({ content, components })
    return
  }
  if (typeof interaction.reply === "function") {
    await interaction.reply({ content, flags: [1 << 6], components })
  }
}

async function safeInteractionErrorReply(interaction: DiscordInteractionLike): Promise<void> {
  try {
    await replyEphemeral(interaction, "Discord handler failed. Check runtime logs.")
  } catch {
    // Best-effort only.
  }
}

function formatInterviewPrompt(phase: string, question: string): string {
  return `Interview phase ${phase}\n${question}`
}

function formatPRD(runId: string, summary: string): string {
  return `📋 **Product Requirements Document — \`${runId}\`**\n\n${summary}\n\n---\n*Generated from requirements interview. This is the locked specification for the build phase.*`
}

/** Split a message into chunks that fit Discord's 2000-char limit. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLen)
    if (splitAt < maxLen * 0.5) splitAt = maxLen // no good newline, hard cut
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, "")
  }
  return chunks
}
