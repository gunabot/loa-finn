// src/integrations/discord/bot.ts
// Discord.js lifecycle wrapper for Loa/Finn thread workflow control.

import type { FinnConfig } from "../../config.js"
import { ThreadRunStore } from "../../gateway/thread-run-store.js"
import { RequirementsFlow } from "../../interview/requirements-flow.js"
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
  reply?(options: { content: string }): Promise<unknown>
}

interface DiscordInteractionLike {
  channelId?: string | null
  commandName?: string
  replied?: boolean
  deferred?: boolean
  options?: { getString(name: string, required?: boolean): string | null }
  isButton?(): boolean
  isChatInputCommand?(): boolean
  reply?(options: { content: string; ephemeral?: boolean }): Promise<unknown>
  followUp?(options: { content: string; ephemeral?: boolean }): Promise<unknown>
  editReply?(options: { content: string }): Promise<unknown>
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
  const interactionRouter = new DiscordInteractionRouter({
    threadRunStore,
    allowedChannelIds,
    logger,
  })

  const discordModuleName = "discord.js"
  const discord = await import(discordModuleName)
  const Client = (discord as { Client?: new (config: unknown) => DiscordJsClientLike }).Client
  if (!Client) {
    throw new Error("discord.js Client export not found")
  }

  const intents = buildIntents(discord as Record<string, unknown>)
  const partials = buildPartials(discord as Record<string, unknown>)
  const client = new Client({ intents, partials })

  let running = false

  client.on("ready", async () => {
    logger.info(`[discord-bot] ready as ${client.user?.tag ?? "unknown-user"}`)
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
      if (!isAllowedChannel(channelId, allowedChannelIds)) return

      const handled = await interactionRouter.routeInteraction(interaction)
      if (handled) return

      if (interaction.isChatInputCommand?.() && interaction.commandName === "requirements") {
        const runId = interaction.options?.getString("run_id", false)
          ?? deriveRunIdFromChannel(channelId)
        if (!runId || !channelId) {
          await replyEphemeral(interaction, "A run_id is required to start requirements interview.")
          return
        }

        const prompt = requirementsFlow.start(channelId, runId)
        await replyEphemeral(
          interaction,
          `[${prompt.phase}] ${prompt.question}`,
        )
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

      const runIdFromContent = parseRunIdFromText(message.content ?? "")
      await handleVoiceAttachments(message, voiceService)

      // Minimal text workflow for interview progression in thread.
      if ((message.content ?? "").startsWith("!requirements start")) {
        const runId = runIdFromContent ?? deriveRunIdFromChannel(channelId)
        const prompt = requirementsFlow.start(channelId, runId)
        await message.reply?.({ content: `[${prompt.phase}] ${prompt.question}` })
        return
      }

      if ((message.content ?? "").startsWith("!requirements answer")) {
        const runId = runIdFromContent ?? deriveRunIdFromChannel(channelId)
        const answerText = extractAnswerText(message.content ?? "")
        const result = requirementsFlow.answer(channelId, runId, answerText)
        if (!result.accepted) {
          await message.reply?.({ content: "Please provide a non-empty answer." })
          return
        }
        if (result.completed) {
          const summary = requirementsFlow.buildSummary(channelId, runId)
          await message.reply?.({ content: `${summary}\n\nInterview complete.` })
          return
        }
        await message.reply?.({ content: `[${result.prompt!.phase}] ${result.prompt!.question}` })
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

function isAllowedChannel(channelId: string | null, allowedChannelIds: string[]): boolean {
  if (!channelId) return false
  if (allowedChannelIds.length === 0) return true
  return allowedChannelIds.includes(channelId)
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

async function replyEphemeral(interaction: DiscordInteractionLike, content: string): Promise<void> {
  if (interaction.replied && typeof interaction.followUp === "function") {
    await interaction.followUp({ content, ephemeral: true })
    return
  }
  if (interaction.deferred && typeof interaction.editReply === "function") {
    await interaction.editReply({ content })
    return
  }
  if (typeof interaction.reply === "function") {
    await interaction.reply({ content, ephemeral: true })
  }
}

async function safeInteractionErrorReply(interaction: DiscordInteractionLike): Promise<void> {
  try {
    await replyEphemeral(interaction, "Discord handler failed. Check runtime logs.")
  } catch {
    // Best-effort only.
  }
}
