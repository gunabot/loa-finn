// src/integrations/discord/project-runtime.ts
// Disk-backed runtime for Discord interview -> PRD -> build lifecycle.

import { createWriteStream } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import type { RequirementsAnswer } from "../../interview/requirements-flow.js"

export type ProjectRunStatus =
  | "interview_active"
  | "awaiting_prd_approval"
  | "prd_rejected"
  | "building"
  | "awaiting_review"
  | "completed"
  | "build_failed"

export interface ProjectRunState {
  runId: string
  threadId: string
  projectDir: string
  status: ProjectRunStatus
  createdAt: string
  updatedAt: string
  interviewCompletedAt?: string
  prdGeneratedAt?: string
  buildStartedAt?: string
  buildCompletedAt?: string
  buildExitCode?: number
  buildCommand?: string
  buildLogPath?: string
  notes?: string[]
}

export interface BuildEvent {
  type: "started" | "progress" | "completed" | "failed"
  message: string
}

export interface StartBuildOptions {
  runId: string
  threadId: string
  prdPath: string
  onEvent: (event: BuildEvent) => Promise<void> | void
}

interface DiscordProjectRuntimeOptions {
  projectsRoot?: string
  repoRoot?: string
  now?: () => string
  logger?: {
    info(message: string): void
    warn(message: string): void
    error(message: string, err?: unknown): void
  }
}

const STATE_FILE = "state.json"
const INTERVIEW_FILE = "interview.json"
const PRD_FILE = "PRD.md"
const BUILD_LOG_FILE = "build.log"

export class DiscordProjectRuntime {
  private readonly projectsRoot: string
  private readonly repoRoot: string
  private readonly now: () => string
  private readonly logger: {
    info(message: string): void
    warn(message: string): void
    error(message: string, err?: unknown): void
  }

  constructor(options: DiscordProjectRuntimeOptions = {}) {
    const envProjectsRoot = process.env.PROJECT_BASE_DIR
      ?? process.env.DISCORD_PROJECTS_ROOT
      ?? "projects"
    this.projectsRoot = resolve(options.projectsRoot ?? envProjectsRoot)
    this.repoRoot = resolve(options.repoRoot ?? process.cwd())
    this.now = options.now ?? (() => new Date().toISOString())
    this.logger = options.logger ?? {
      info(message) { console.log(message) },
      warn(message) { console.warn(message) },
      error(message, err) { console.error(message, err) },
    }
  }

  async ensureProject(runId: string, threadId: string): Promise<ProjectRunState> {
    const projectDir = this.projectDirForRun(runId)
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(projectDir, ".claude"), { recursive: true })

    await this.writeScaffoldFiles(projectDir)

    const existing = await this.tryReadState(runId)
    if (existing) return existing

    const state: ProjectRunState = {
      runId,
      threadId,
      projectDir,
      status: "interview_active",
      createdAt: this.now(),
      updatedAt: this.now(),
      notes: [],
    }
    await this.writeState(state)
    await this.writeInterview(runId, {
      runId,
      threadId,
      answers: [],
      updatedAt: this.now(),
      completed: false,
    })
    return state
  }

  async persistInterview(
    runId: string,
    threadId: string,
    answers: RequirementsAnswer[],
    completed: boolean,
  ): Promise<ProjectRunState> {
    const state = await this.ensureProject(runId, threadId)
    const next: ProjectRunState = {
      ...state,
      status: completed ? "awaiting_prd_approval" : "interview_active",
      interviewCompletedAt: completed ? this.now() : state.interviewCompletedAt,
      updatedAt: this.now(),
    }
    await this.writeState(next)
    await this.writeInterview(runId, {
      runId,
      threadId,
      answers,
      updatedAt: this.now(),
      completed,
    })
    return next
  }

  async markRejected(runId: string, threadId: string, note: string): Promise<ProjectRunState> {
    const state = await this.ensureProject(runId, threadId)
    const next = this.appendNote({
      ...state,
      status: "prd_rejected",
      updatedAt: this.now(),
    }, note)
    await this.writeState(next)
    return next
  }

  async markReviewApproved(runId: string, threadId: string, note: string): Promise<ProjectRunState> {
    const state = await this.ensureProject(runId, threadId)
    const next = this.appendNote({
      ...state,
      status: "completed",
      updatedAt: this.now(),
    }, note)
    await this.writeState(next)
    return next
  }

  async readState(runId: string): Promise<ProjectRunState | null> {
    return this.tryReadState(runId)
  }

  async generatePrd(runId: string, threadId: string): Promise<{ prdPath: string; content: string; state: ProjectRunState }> {
    const state = await this.ensureProject(runId, threadId)
    const interview = await this.readInterview(runId)
    const template = await this.loadTemplate()
    const content = renderPrdFromInterview(runId, interview.answers, template, this.now)
    const prdPath = join(state.projectDir, PRD_FILE)
    await writeFile(prdPath, content, "utf-8")

    const next: ProjectRunState = {
      ...state,
      status: "building",
      prdGeneratedAt: this.now(),
      updatedAt: this.now(),
    }
    await this.writeState(next)
    return { prdPath, content, state: next }
  }

  async startBuild(options: StartBuildOptions): Promise<{ exitCode: number; state: ProjectRunState }> {
    const state = await this.ensureProject(options.runId, options.threadId)
    const logPath = join(state.projectDir, BUILD_LOG_FILE)
    const command = this.buildCommandForRun({
      runId: options.runId,
      projectDir: state.projectDir,
      prdPath: options.prdPath,
    })

    const preStartState: ProjectRunState = {
      ...state,
      status: "building",
      buildStartedAt: this.now(),
      buildLogPath: logPath,
      buildCommand: command,
      updatedAt: this.now(),
    }
    await this.writeState(preStartState)

    await options.onEvent({
      type: "started",
      message: `Build started for \`${options.runId}\`.`,
    })

    const logStream = createWriteStream(logPath, { flags: "a", encoding: "utf-8" })
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: state.projectDir,
      env: {
        ...process.env,
        RUN_ID: options.runId,
        PROJECT_DIR: state.projectDir,
        PRD_PATH: options.prdPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const flushProgress = createProgressBuffer(async (text) => {
      if (!text.trim()) return
      await options.onEvent({ type: "progress", message: text })
    })

    child.stdout?.on("data", async (chunk: Buffer | string) => {
      const text = chunk.toString()
      logStream.write(text)
      await flushProgress.push(`[stdout] ${text}`)
    })
    child.stderr?.on("data", async (chunk: Buffer | string) => {
      const text = chunk.toString()
      logStream.write(text)
      await flushProgress.push(`[stderr] ${text}`)
    })

    const exitCode = await new Promise<number>((resolveCode) => {
      child.on("close", (code) => resolveCode(code ?? 1))
      child.on("error", () => resolveCode(1))
    })

    await flushProgress.flush()
    logStream.end()

    const doneState: ProjectRunState = {
      ...preStartState,
      status: exitCode === 0 ? "awaiting_review" : "build_failed",
      buildCompletedAt: this.now(),
      buildExitCode: exitCode,
      updatedAt: this.now(),
    }
    await this.writeState(doneState)

    if (exitCode === 0) {
      await options.onEvent({
        type: "completed",
        message: `Build completed for \`${options.runId}\`. Review and approve or reject.`,
      })
    } else {
      await options.onEvent({
        type: "failed",
        message: `Build failed for \`${options.runId}\` (exit ${exitCode}). Check \`${logPath}\`.`,
      })
    }

    return { exitCode, state: doneState }
  }

  private buildCommandForRun(input: { runId: string; projectDir: string; prdPath: string }): string {
    const template = process.env.DISCORD_BUILD_COMMAND
    if (template && template.trim().length > 0) {
      return template
        .replaceAll("{RUN_ID}", input.runId)
        .replaceAll("{PROJECT_DIR}", input.projectDir)
        .replaceAll("{PRD_PATH}", input.prdPath)
    }

    const model = process.env.DISCORD_BUILD_AGENT_MODEL ?? "gpt-5.3-codex"
    return [
      "if command -v codex >/dev/null 2>&1; then",
      `  codex --model ${escapeShellArg(model)} "Read PRD.md and implement the project in this directory. Create source files, tests, and a README. Continue until implementation is complete."`,
      "else",
      "  echo 'codex binary not found; writing scaffold placeholder.'",
      "  printf '%s\\n' '# Build Placeholder' 'Codex CLI was not found on PATH.' > BUILD_PLACEHOLDER.md",
      "fi",
    ].join(" ")
  }

  private projectDirForRun(runId: string): string {
    return join(this.projectsRoot, sanitizeRunId(runId))
  }

  private async tryReadState(runId: string): Promise<ProjectRunState | null> {
    const path = join(this.projectDirForRun(runId), STATE_FILE)
    try {
      const raw = await readFile(path, "utf-8")
      return JSON.parse(raw) as ProjectRunState
    } catch {
      return null
    }
  }

  private async writeState(state: ProjectRunState): Promise<void> {
    await mkdir(state.projectDir, { recursive: true })
    const path = join(state.projectDir, STATE_FILE)
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
  }

  private async readInterview(runId: string): Promise<{
    runId: string
    threadId: string
    answers: RequirementsAnswer[]
    updatedAt: string
    completed: boolean
  }> {
    const path = join(this.projectDirForRun(runId), INTERVIEW_FILE)
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as {
      runId: string
      threadId: string
      answers: RequirementsAnswer[]
      updatedAt: string
      completed: boolean
    }
  }

  private async writeInterview(
    runId: string,
    payload: {
      runId: string
      threadId: string
      answers: RequirementsAnswer[]
      updatedAt: string
      completed: boolean
    },
  ): Promise<void> {
    const projectDir = this.projectDirForRun(runId)
    await mkdir(projectDir, { recursive: true })
    const path = join(projectDir, INTERVIEW_FILE)
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8")
  }

  private async writeScaffoldFiles(projectDir: string): Promise<void> {
    const claudeDir = join(projectDir, ".claude")
    await mkdir(claudeDir, { recursive: true })

    const readmePath = join(claudeDir, "README.md")
    try {
      await stat(readmePath)
    } catch {
      await writeFile(
        readmePath,
        [
          "# Loa/Finn Project Scaffold",
          "",
          "This workspace was created by Finn from a Discord requirements interview.",
          "Use `PRD.md` as the authoritative product spec for build agents.",
        ].join("\n"),
        "utf-8",
      )
    }
  }

  private async loadTemplate(): Promise<string> {
    const candidates = [
      join(this.repoRoot, ".claude", "templates", "prd.md"),
      join(this.repoRoot, "grimoires", "loa", "prd.md"),
    ]
    for (const candidate of candidates) {
      try {
        const raw = await readFile(candidate, "utf-8")
        if (raw.trim().length > 0) return raw
      } catch {
        // continue
      }
    }
    return ""
  }

  private appendNote(state: ProjectRunState, note: string): ProjectRunState {
    const notes = [...(state.notes ?? []), `[${this.now()}] ${note}`]
    return { ...state, notes }
  }
}

function sanitizeRunId(runId: string): string {
  const normalized = runId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
  return normalized.length > 0 ? normalized : `run-${Date.now()}`
}

function renderPrdFromInterview(
  runId: string,
  answers: RequirementsAnswer[],
  template: string,
  now: () => string,
): string {
  const sections = new Map<string, RequirementsAnswer[]>()
  for (const answer of answers) {
    const key = answer.phase
    const rows = sections.get(key) ?? []
    rows.push(answer)
    sections.set(key, rows)
  }

  const lines: string[] = []
  lines.push(`# PRD: ${runId}`)
  lines.push("")
  lines.push(`> Version: 1.0.0`)
  lines.push(`> Date: ${now().slice(0, 10)}`)
  lines.push(`> Status: Draft`)
  lines.push(`> Source: Discord requirements interview`)
  lines.push("")
  lines.push("## 1. Problem Statement")
  lines.push(renderAnswerLine(sections, "PROBLEM"))
  lines.push("")
  lines.push("## 2. Target Users")
  lines.push(renderAnswerLine(sections, "USERS"))
  lines.push("")
  lines.push("## 3. Feature Requirements")
  lines.push(renderAnswerLine(sections, "FEATURES"))
  lines.push("")
  lines.push("## 4. Constraints")
  lines.push(renderAnswerLine(sections, "CONSTRAINTS"))
  lines.push("")
  lines.push("## 5. Priorities")
  lines.push(renderAnswerLine(sections, "PRIORITIES"))
  lines.push("")
  lines.push("## 6. Summary / Clarifications")
  lines.push(renderAnswerLine(sections, "SUMMARY"))
  lines.push("")
  lines.push("## 7. Approval")
  lines.push(renderAnswerLine(sections, "CONFIRM"))
  lines.push("")
  if (template.trim().length > 0) {
    lines.push("---")
    lines.push("## Appendix: Reference Template Context")
    lines.push("")
    lines.push("The following snippet was loaded from existing Loa PRD patterns:")
    lines.push("")
    lines.push("```md")
    lines.push(template.split("\n").slice(0, 40).join("\n"))
    lines.push("```")
  }
  return `${lines.join("\n")}\n`
}

function renderAnswerLine(
  sections: Map<string, RequirementsAnswer[]>,
  phase: string,
): string {
  const rows = sections.get(phase) ?? []
  if (rows.length === 0) return "_No interview answers captured._"
  return rows
    .map((row) => `- **${row.question}** ${row.answer}`)
    .join("\n")
}

function escapeShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function createProgressBuffer(
  onFlush: (text: string) => Promise<void>,
): {
  push(text: string): Promise<void>
  flush(): Promise<void>
} {
  let buffer = ""
  let lastFlush = Date.now()
  const FLUSH_EVERY_MS = 4_000
  const MAX_BUFFER = 1_300

  return {
    async push(text: string): Promise<void> {
      const cleaned = text.replace(/\r/g, "")
      buffer += cleaned
      const now = Date.now()
      if (buffer.length >= MAX_BUFFER || now - lastFlush >= FLUSH_EVERY_MS) {
        const chunk = trimForDiscord(buffer)
        buffer = ""
        lastFlush = now
        await onFlush(chunk)
      }
    },
    async flush(): Promise<void> {
      if (!buffer.trim()) return
      const chunk = trimForDiscord(buffer)
      buffer = ""
      await onFlush(chunk)
    },
  }
}

function trimForDiscord(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 1800) return trimmed
  return `${trimmed.slice(0, 1790)}...`
}
