// tests/finn/project-runtime.test.ts

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { RequirementsAnswer } from "../../src/interview/requirements-flow.js"
import { DiscordProjectRuntime } from "../../src/integrations/discord/project-runtime.js"

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "finn-project-runtime-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("ensureProject creates project directory, state.json, and interview.json", async () => {
  await withTempDir(async (dir) => {
    const runtime = new DiscordProjectRuntime({
      projectsRoot: join(dir, "projects"),
      repoRoot: dir,
      now: () => "2026-02-16T14:00:00.000Z",
    })

    const state = await runtime.ensureProject("run-a", "thread-a")
    assert.equal(state.status, "interview_active")

    const stateRaw = await readFile(join(state.projectDir, "state.json"), "utf-8")
    const interviewRaw = await readFile(join(state.projectDir, "interview.json"), "utf-8")
    assert.ok(stateRaw.includes("\"runId\": \"run-a\""))
    assert.ok(interviewRaw.includes("\"answers\": []"))
  })
})

test("persistInterview updates interview snapshot and status on completion", async () => {
  await withTempDir(async (dir) => {
    const runtime = new DiscordProjectRuntime({
      projectsRoot: join(dir, "projects"),
      repoRoot: dir,
      now: () => "2026-02-16T14:01:00.000Z",
    })

    const answers: RequirementsAnswer[] = [
      {
        phase: "PROBLEM",
        questionId: "problem_outcome",
        question: "What outcome?",
        answer: "Build a Discord-driven app generator.",
        answeredAt: "2026-02-16T14:00:01.000Z",
      },
    ]

    const state = await runtime.persistInterview("run-b", "thread-b", answers, true)
    assert.equal(state.status, "awaiting_prd_approval")

    const interviewRaw = await readFile(join(state.projectDir, "interview.json"), "utf-8")
    assert.ok(interviewRaw.includes("Discord-driven app generator"))
    assert.ok(interviewRaw.includes("\"completed\": true"))
  })
})

test("generatePrd writes PRD.md using interview answers", async () => {
  await withTempDir(async (dir) => {
    const runtime = new DiscordProjectRuntime({
      projectsRoot: join(dir, "projects"),
      repoRoot: dir,
      now: () => "2026-02-16T14:02:00.000Z",
    })

    const answers: RequirementsAnswer[] = [
      {
        phase: "PROBLEM",
        questionId: "problem_outcome",
        question: "What outcome?",
        answer: "Ship the feature quickly.",
        answeredAt: "2026-02-16T14:02:01.000Z",
      },
      {
        phase: "USERS",
        questionId: "users_actor",
        question: "Who uses it?",
        answer: "Product team.",
        answeredAt: "2026-02-16T14:02:02.000Z",
      },
    ]

    await runtime.persistInterview("run-c", "thread-c", answers, true)
    const prd = await runtime.generatePrd("run-c", "thread-c")
    const prdRaw = await readFile(prd.prdPath, "utf-8")
    assert.ok(prdRaw.includes("# PRD: run-c"))
    assert.ok(prdRaw.includes("Ship the feature quickly"))
    assert.ok(prdRaw.includes("Product team"))
  })
})

test("startBuild executes command in project dir and emits progress/completion", async () => {
  await withTempDir(async (dir) => {
    const runtime = new DiscordProjectRuntime({
      projectsRoot: join(dir, "projects"),
      repoRoot: dir,
      now: () => "2026-02-16T14:03:00.000Z",
    })

    await runtime.ensureProject("run-d", "thread-d")
    const prdResult = await runtime.generatePrd("run-d", "thread-d")
    const prevBuildCommand = process.env.DISCORD_BUILD_COMMAND
    process.env.DISCORD_BUILD_COMMAND = [
      "echo 'build-start'",
      "printf '%s\\n' 'result-from-build' > BUILD_RESULT.txt",
      "echo 'build-done'",
    ].join(" && ")

    const events: string[] = []
    const result = await runtime.startBuild({
      runId: "run-d",
      threadId: "thread-d",
      prdPath: prdResult.prdPath,
      onEvent: async (event) => {
        events.push(`${event.type}:${event.message}`)
      },
    })
    if (prevBuildCommand === undefined) delete process.env.DISCORD_BUILD_COMMAND
    else process.env.DISCORD_BUILD_COMMAND = prevBuildCommand

    assert.equal(result.exitCode, 0)
    assert.equal(result.state.status, "awaiting_review")
    assert.ok(events.some((entry) => entry.startsWith("started:")))
    assert.ok(events.some((entry) => entry.startsWith("progress:")))
    assert.ok(events.some((entry) => entry.startsWith("completed:")))

    const outputRaw = await readFile(join(result.state.projectDir, "BUILD_RESULT.txt"), "utf-8")
    assert.ok(outputRaw.includes("result-from-build"))
  })
})

test("PROJECT_BASE_DIR env controls default project workspace root", async () => {
  await withTempDir(async (dir) => {
    const prevProjectBaseDir = process.env.PROJECT_BASE_DIR
    const prevDiscordProjectsRoot = process.env.DISCORD_PROJECTS_ROOT
    process.env.PROJECT_BASE_DIR = join(dir, "external-projects")
    delete process.env.DISCORD_PROJECTS_ROOT

    try {
      const runtime = new DiscordProjectRuntime({
        repoRoot: dir,
        now: () => "2026-02-16T14:04:00.000Z",
      })

      const state = await runtime.ensureProject("run-env", "thread-env")
      assert.ok(state.projectDir.startsWith(join(dir, "external-projects")))
    } finally {
      if (prevProjectBaseDir === undefined) delete process.env.PROJECT_BASE_DIR
      else process.env.PROJECT_BASE_DIR = prevProjectBaseDir

      if (prevDiscordProjectsRoot === undefined) delete process.env.DISCORD_PROJECTS_ROOT
      else process.env.DISCORD_PROJECTS_ROOT = prevDiscordProjectsRoot
    }
  })
})

async function main() {
  let failures = 0
  console.log("Discord Project Runtime Tests")
  console.log("=============================")

  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`  PASS  ${name}`)
    } catch (err) {
      failures += 1
      console.error(`  FAIL  ${name}`)
      console.error(err)
    }
  }

  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error("fatal test harness error", err)
  process.exitCode = 1
})
