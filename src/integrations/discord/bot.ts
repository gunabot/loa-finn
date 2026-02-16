// src/integrations/discord/bot.ts
// Discord.js lifecycle wrapper for Loa/Finn thread workflow control.

import type { FinnConfig } from "../../config.js"
import { RUN_LEVEL_GATE_STEP_ID, ThreadRunStore } from "../../gateway/thread-run-store.js"
import { RequirementsFlow } from "../../interview/requirements-flow.js"
import { buildWorkflowActionRows } from "./components.js"
import { DiscordInteractionRouter } from "./interaction-router.js"
import { DiscordProjectRuntime } from "./project-runtime.js"
import { DiscordVoiceService } from "./voice.js"

export interface DiscordBotLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

export interface DiscordBotDeps {
  threadRunStore?: ThreadRunStore
  requirementsFlow?: RequirementsFlow
  projectRuntime?: DiscordProjectRuntime
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
  channels?: {
    fetch(channelId: string): Promise<unknown>
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
  fetchReply?(): Promise<{ startThread?: (options: { name: string; autoArchiveDuration: number }) => Promise<{ id?: string; send?: (options: { content: string; components?: unknown[] } | string) => Promise<unknown> }> }>
}

interface DiscordThreadStarterLike {
  startThread?(options: { name: string; autoArchiveDuration: number }): Promise<{ id?: string }>
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
  const projectRuntime = deps.projectRuntime ?? new DiscordProjectRuntime({ logger })
  const voiceService = deps.voiceService ?? new DiscordVoiceService()
  const activeBuilds = new Set<string>()
  const threadRunIndex = new Map<string, string>()

  const discordModuleName = "discord.js"
  const discord = await import(discordModuleName)
  const Client = (discord as { Client?: new (config: unknown) => DiscordJsClientLike }).Client
  if (!Client) {
    throw new Error("discord.js Client export not found")
  }

  const intents = buildIntents(discord as Record<string, unknown>)
  const partials = buildPartials(discord as Record<string, unknown>)
  const client = new Client({ intents, partials })

  async function sendToChannel(channelId: string, content: string, components?: unknown[]): Promise<void> {
    try {
      const channel = await client.channels?.fetch(channelId)
      if (!channel || typeof (channel as { send?: unknown }).send !== "function") return

      const send = (channel as { send: (payload: { content: string; components?: unknown[] } | string) => Promise<unknown> }).send
      const chunks = splitMessage(content, 1900)
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && components && components.length > 0) {
          await send({ content: chunks[i], components })
        } else {
          await send(chunks[i])
        }
      }
    } catch (err) {
      logger.error(`[discord-bot] failed to send to channel ${channelId}`, err)
    }
  }

  async function startInterviewInThread(threadId: string, runId: string): Promise<void> {
    threadRunIndex.set(threadId, runId)
    threadRunStore.touchPending({
      threadId,
      runId,
      stepId: RUN_LEVEL_GATE_STEP_ID,
    })
    await projectRuntime.ensureProject(runId, threadId)

    const prompt = requirementsFlow.start(threadId, runId)
    await projectRuntime.persistInterview(
      runId,
      threadId,
      requirementsFlow.listAnswers(threadId, runId),
      false,
    )

    await sendToChannel(
      threadId,
      [
        `Interview started for \`${runId}\`.`,
        "Reply naturally in this thread. I will ask one focused question at a time.",
        "",
        formatInterviewPrompt(prompt.phase, prompt.question),
      ].join("\n"),
    )
  }

  async function createInterviewThread(
    parentChannelId: string,
    threadName: string,
    reply?: DiscordThreadStarterLike,
  ): Promise<string> {
    try {
      const channel = await client.channels?.fetch(parentChannelId)
      const threads = (channel as {
        threads?: {
          create?: (options: { name: string; autoArchiveDuration: number; reason?: string }) => Promise<{ id?: string }>
        }
      }).threads
      if (threads && typeof threads.create === "function") {
        const thread = await threads.create({
          name: threadName,
          autoArchiveDuration: 1440,
          reason: "Finn requirements interview",
        })
        if (thread.id) return thread.id
      }
    } catch (err) {
      logger.warn(`[discord-bot] channel thread creation failed, trying reply thread fallback: ${err}`)
    }

    try {
      if (reply?.startThread) {
        const thread = await reply.startThread({
          name: threadName,
          autoArchiveDuration: 1440,
        })
        if (thread.id) return thread.id
      }
    } catch (err) {
      logger.warn(`[discord-bot] reply thread creation failed, using channel fallback: ${err}`)
    }

    return parentChannelId
  }

  function resolveRunIdForChannel(channelId: string): string | null {
    const activeRunId = requirementsFlow.findActiveRunId(channelId)
    if (activeRunId) return activeRunId

    const indexedRunId = threadRunIndex.get(channelId)
    if (indexedRunId) return indexedRunId

    const runIds = threadRunStore.listThreadRunIds(channelId)
    if (runIds.length > 0) return runIds[0]
    return null
  }

  function isProcessableChannel(channelId: string | null): boolean {
    if (!channelId) return false
    if (allowedChannelIds.length === 0) return true
    if (allowedChannelIds.includes(channelId)) return true
    if (threadRunIndex.has(channelId)) return true
    if (requirementsFlow.findActiveRunId(channelId)) return true
    return threadRunStore.hasThread(channelId)
  }

  async function maybeStartBuild(channelId: string, runId: string): Promise<void> {
    if (activeBuilds.has(runId)) {
      await sendToChannel(channelId, `Build already running for \`${runId}\`.`)
      return
    }
    activeBuilds.add(runId)

    try {
      const { prdPath, content } = await projectRuntime.generatePrd(runId, channelId)
      await sendToChannel(channelId, `PRD generated at \`${prdPath}\`.`)
      await sendToChannel(channelId, renderPrdPreview(content))

      await projectRuntime.startBuild({
        runId,
        threadId: channelId,
        prdPath,
        onEvent: async (event) => {
          if (event.type === "progress") {
            await sendToChannel(channelId, `Build update:\n\n${event.message}`)
            return
          }
          await sendToChannel(channelId, event.message)
        },
      })

      const controls = buildWorkflowActionRows({ threadId: channelId, runId })
      await sendToChannel(
        channelId,
        "Build finished. Review output in the project folder and approve/reject in this thread.",
        controls,
      )
    } catch (err) {
      logger.error(`[discord-bot] build pipeline failed for ${runId}`, err)
      await sendToChannel(channelId, `Build pipeline failed for \`${runId}\`. Check runtime logs.`)
    } finally {
      activeBuilds.delete(runId)
    }
  }

  const interactionRouter = new DiscordInteractionRouter({
    threadRunStore,
    allowedChannelIds,
    logger,
    async onApprove(channelId, runId, actorUserId) {
      threadRunIndex.set(channelId, runId)
      const state = await projectRuntime.readState(runId) ?? await projectRuntime.ensureProject(runId, channelId)

      if (state.status === "interview_active") {
        await sendToChannel(
          channelId,
          `Run \`${runId}\` interview is still active. Complete all interview phases before approval.`,
        )
        return
      }

      if (state.status === "awaiting_review") {
        await projectRuntime.markReviewApproved(
          runId,
          channelId,
          `Review approved by ${actorUserId ?? "unknown"}`,
        )
        await sendToChannel(channelId, `Review approved for \`${runId}\`. Marked complete.`)
        return
      }

      if (state.status === "building") {
        await sendToChannel(channelId, `Build is already in progress for \`${runId}\`.`)
        return
      }

      if (state.status === "completed") {
        await sendToChannel(channelId, `Run \`${runId}\` is already completed.`)
        return
      }

      void maybeStartBuild(channelId, runId)
    },
    async onReject(channelId, runId, actorUserId) {
      await projectRuntime.markRejected(
        runId,
        channelId,
        `Rejected by ${actorUserId ?? "unknown"}`,
      )
      await sendToChannel(
        channelId,
        [
          `Run \`${runId}\` marked rejected.`,
          "You can continue discussing requirements in this thread, then approve when ready.",
        ].join("\n"),
      )
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
              type: 3,
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
      if (!isProcessableChannel(channelId)) return

      const handled = await interactionRouter.routeInteraction(interaction)
      if (handled) return

      if (interaction.isChatInputCommand?.() && interaction.commandName === "status") {
        if (!channelId) {
          await replyEphemeral(interaction, "No channel context available.")
          return
        }
        const runId = resolveRunIdForChannel(channelId)
        if (!runId) {
          await replyEphemeral(interaction, "No workflow run found for this channel yet.")
          return
        }
        const summary = threadRunStore.summarizeRun(channelId, runId)
        await replyEphemeral(
          interaction,
          `Run ${runId}: approved=${summary.approved}, rejected=${summary.rejected}, pending=${summary.pending}.`,
          buildWorkflowActionRows({ threadId: channelId, runId }),
        )
        return
      }

      if (interaction.isChatInputCommand?.() && interaction.commandName === "requirements") {
        const projectName = interaction.options?.getString("project", false)
        const runId = projectName
          ? slugifyRunId(projectName)
          : `project-${Date.now()}`

        if (!channelId) {
          await replyEphemeral(interaction, "Could not determine channel context.")
          return
        }

        // Acknowledge command first.
        await interaction.reply?.({
          content: `Starting requirements interview for \`${runId}\`...`,
          ephemeral: true,
        })

        const reply = await interaction.fetchReply?.()
        const targetThreadId = await createInterviewThread(
          channelId,
          `📋 ${projectName || runId}`,
          reply,
        )

        await startInterviewInThread(targetThreadId, runId)
        if (targetThreadId !== channelId) {
          await replyEphemeral(interaction, `Interview thread ready: <#${targetThreadId}>`)
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
      if (!isProcessableChannel(channelId)) return
      if (!channelId) return

      await handleVoiceAttachments(message, voiceService)

      const text = (message.content ?? "").trim()
      if (!text) return

      const activeRunId = requirementsFlow.findActiveRunId(channelId)
      if (!activeRunId) return

      const result = requirementsFlow.answer(channelId, activeRunId, text)
      if (!result.accepted) {
        await message.reply?.({ content: "Please provide a little more detail so I can capture this requirement." })
        return
      }

      await projectRuntime.persistInterview(
        activeRunId,
        channelId,
        requirementsFlow.listAnswers(channelId, activeRunId),
        result.completed,
      )

      if (result.completed) {
        const summary = requirementsFlow.buildSummary(channelId, activeRunId)
        for (const chunk of splitMessage(`Draft PRD summary:\n\n${summary}`, 1900)) {
          await message.reply?.({ content: chunk })
        }
        await message.reply?.({
          content: "Interview complete. Approve to lock PRD and start build, or reject to refine requirements.",
          components: buildWorkflowActionRows({ threadId: channelId, runId: activeRunId }),
        })
        return
      }

      if (result.prompt?.phase === "SUMMARY") {
        const draftSummary = requirementsFlow.buildSummary(channelId, activeRunId)
        for (const chunk of splitMessage(`Current summary:\n\n${draftSummary}`, 1900)) {
          await message.reply?.({ content: chunk })
        }
      }

      if (result.prompt) {
        await message.reply?.({
          content: formatInterviewPrompt(result.prompt.phase, result.prompt.question),
        })
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

function slugifyRunId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
  return slug.length > 0 ? slug : `project-${Date.now()}`
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
      content: `[voice optional] ${transcription.transcript}`,
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
    await interaction.followUp({ content, ephemeral: true, components })
    return
  }
  if (interaction.deferred && typeof interaction.editReply === "function") {
    await interaction.editReply({ content, components })
    return
  }
  if (typeof interaction.reply === "function") {
    await interaction.reply({ content, ephemeral: true, components })
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
  return [`Interview phase: **${phase}**`, question].join("\n")
}

function renderPrdPreview(prdContent: string): string {
  const preview = prdContent.split("\n").slice(0, 40).join("\n")
  return `PRD preview:\n\n${preview}`
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen)
    if (splitAt < maxLen * 0.5) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, "")
  }
  return chunks
}
