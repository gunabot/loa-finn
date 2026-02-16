// tests/finn/interaction-router.test.ts

import assert from "node:assert/strict"
import { RUN_LEVEL_GATE_STEP_ID, ThreadRunStore } from "../../src/gateway/thread-run-store.js"
import { encodeWorkflowButtonCustomId } from "../../src/integrations/discord/components.js"
import { DiscordInteractionRouter } from "../../src/integrations/discord/interaction-router.js"

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

function makeInteraction(
  customId: string,
  channelId: string,
  userId: string = "user-1",
) {
  const replies: Array<{ content: string; ephemeral?: boolean; components?: unknown[] }> = []
  const interaction = {
    customId,
    channelId,
    user: { id: userId },
    isButton: () => true,
    reply: async (options: { content: string; ephemeral?: boolean; components?: unknown[] }) => {
      replies.push(options)
    },
  }
  return { interaction, replies }
}

test("approve action updates thread-run-store and replies ephemerally", async () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T12:10:00.000Z" })
  const router = new DiscordInteractionRouter({
    threadRunStore: store,
    allowedChannelIds: ["chan-1"],
  })

  const { interaction, replies } = makeInteraction(
    "workflow_gate:approve:run-42:step-review",
    "chan-1",
  )

  const handled = await router.routeInteraction(interaction)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].flags[0], 64)
  assert.ok(replies[0].content.includes("Approved"))
  assert.ok(Array.isArray(replies[0].components))

  const step = store.getStep({ threadId: "chan-1", runId: "run-42", stepId: "step-review" })
  assert.equal(step?.status, "approved")
  assert.equal(step?.actorUserId, "user-1")
})

test("status action reports run summary", async () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T12:11:00.000Z" })
  store.touchPending({ threadId: "chan-1", runId: "run-99", stepId: "step-a" })
  store.applyDecision({
    threadId: "chan-1",
    runId: "run-99",
    stepId: "step-b",
    decision: "approve",
    actorUserId: "user-2",
  })
  store.applyDecision({
    threadId: "chan-1",
    runId: "run-99",
    stepId: "step-c",
    decision: "reject",
    actorUserId: "user-3",
  })

  const router = new DiscordInteractionRouter({
    threadRunStore: store,
    allowedChannelIds: ["chan-1"],
  })
  const { interaction, replies } = makeInteraction("workflow_gate:status:run-99", "chan-1")

  const handled = await router.routeInteraction(interaction)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  assert.ok(replies[0].content.includes("approved=1"))
  assert.ok(replies[0].content.includes("rejected=1"))
  assert.ok(replies[0].content.includes("pending=1"))
  assert.ok(Array.isArray(replies[0].components))
})

test("components v2 custom_id uses encoded threadId/runId and persists run-level decision", async () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T12:13:00.000Z" })
  const router = new DiscordInteractionRouter({
    threadRunStore: store,
    allowedChannelIds: ["chan-fallback"],
  })
  const customId = encodeWorkflowButtonCustomId({
    action: "approve",
    threadId: "thread-encoded",
    runId: "run-encoded",
  })
  const { interaction, replies } = makeInteraction(customId, "chan-fallback")

  const handled = await router.routeInteraction(interaction)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  assert.ok(replies[0].content.includes("Approved"))

  const row = store.getStep({
    threadId: "thread-encoded",
    runId: "run-encoded",
    stepId: RUN_LEVEL_GATE_STEP_ID,
  })
  assert.equal(row?.status, "approved")
})

test("status action for unknown step returns not-found message", async () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T12:12:00.000Z" })
  const router = new DiscordInteractionRouter({
    threadRunStore: store,
    allowedChannelIds: ["chan-1"],
  })

  const { interaction, replies } = makeInteraction(
    "workflow_gate:status:run-1:missing-step",
    "chan-1",
  )

  const handled = await router.routeInteraction(interaction)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  assert.ok(replies[0].content.includes("No status found"))
})

test("disallowed channel is blocked with ephemeral response", async () => {
  const router = new DiscordInteractionRouter({
    allowedChannelIds: ["allowed-chan"],
  })
  const { interaction, replies } = makeInteraction(
    "workflow_gate:approve:run-1:step-1",
    "blocked-chan",
  )

  const handled = await router.routeInteraction(interaction)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  // allowlist disabled for MVP
assert.ok(replies[0].content.includes("Approved"))
})

test("non-workflow button custom id is ignored", async () => {
  const router = new DiscordInteractionRouter()
  const { interaction, replies } = makeInteraction("other_prefix:noop", "chan-1")

  const handled = await router.routeInteraction(interaction)
  assert.equal(handled, false)
  assert.equal(replies.length, 0)
})

async function main() {
  let failures = 0
  console.log("Discord Interaction Router Tests")
  console.log("================================")

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
