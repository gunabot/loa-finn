// tests/finn/discord-bridge-module.test.ts — Discord bridge module wiring helpers (slice 1)

import assert from "node:assert/strict"
import {
  DiscordBridge,
  DISCORD_INTERVIEW_CUSTOM_ID_PREFIX,
  DISCORD_INTERACTIONS_PATH,
  DISCORD_WORKFLOW_CUSTOM_ID_PREFIX,
  shouldBypassDiscordApiAuth,
} from "../../src/gateway/discord-bridge.js"

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

test("shouldBypassDiscordApiAuth only bypasses exact interactions route when enabled", () => {
  assert.equal(shouldBypassDiscordApiAuth(true, DISCORD_INTERACTIONS_PATH), true)
  assert.equal(shouldBypassDiscordApiAuth(false, DISCORD_INTERACTIONS_PATH), false)
  assert.equal(shouldBypassDiscordApiAuth(true, "/api/discord/other"), false)
})

test("DiscordBridge returns 401 when signature verification fails", async () => {
  const bridge = new DiscordBridge({
    appId: "app-1",
    publicKey: "public-key",
    channelId: "channel-1",
  })

  const res = await bridge.handleInteraction({
    rawBody: JSON.stringify({ type: 1 }),
    headers: {},
  })
  assert.equal(res.status, 401)
  assert.equal(res.body.code, "DISCORD_SIGNATURE_INVALID")
})

test("DiscordBridge responds to Discord PING interaction", async () => {
  const bridge = new DiscordBridge({
    appId: "app-1",
    publicKey: "public-key",
    channelId: "channel-1",
  })

  const res = await bridge.handleInteraction({
    rawBody: JSON.stringify({ type: 1 }),
    headers: { debugSignatureBypass: "1" },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.type, 1)
})

test("DiscordBridge routes workflow gate button custom_id and calls decision handler", async () => {
  const calls: Array<{ runId: string; stepId: string; decision: string; actorUserId: string | null }> = []
  const bridge = new DiscordBridge({
    appId: "app-1",
    publicKey: "public-key",
    channelId: "channel-1",
  }, {
    workflowGateDecisionHandler: async (input) => {
      calls.push(input)
      return {
        ok: true,
        message: `workflow decision accepted for ${input.runId}/${input.stepId}`,
      }
    },
  })

  const res = await bridge.handleInteraction({
    rawBody: JSON.stringify({
      type: 3,
      data: { custom_id: `${DISCORD_WORKFLOW_CUSTOM_ID_PREFIX}:run-77:step-review:approve` },
      user: { id: "u-1" },
    }),
    headers: { debugSignatureBypass: "1" },
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.code, "DISCORD_WORKFLOW_ACTION_ACCEPTED")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].runId, "run-77")
  assert.equal(calls[0].stepId, "step-review")
  assert.equal(calls[0].decision, "approve")
  assert.equal(calls[0].actorUserId, "u-1")
})

test("DiscordBridge routes requirements command to interview handler", async () => {
  const calls: Array<{ action: string; sessionId: string | null; actorUserId: string | null }> = []
  const bridge = new DiscordBridge({
    appId: "app-1",
    publicKey: "public-key",
    channelId: "channel-1",
  }, {
    interviewActionHandler: async (input) => {
      calls.push({ action: input.action, sessionId: input.sessionId, actorUserId: input.actorUserId })
      return { ok: true, prompt: "Voice-ready prompt ack." }
    },
  })

  const res = await bridge.handleInteraction({
    rawBody: JSON.stringify({
      type: 2,
      data: { name: "requirements" },
      user: { id: "u-9" },
    }),
    headers: { debugSignatureBypass: "1" },
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.code, "DISCORD_INTERVIEW_ACTION_ACCEPTED")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, "start")
  assert.equal(calls[0].sessionId, null)
  assert.equal(calls[0].actorUserId, "u-9")
})

test("DiscordBridge interview button returns default voice-friendly prompt when handler is not wired", async () => {
  const bridge = new DiscordBridge({
    appId: "app-1",
    publicKey: "public-key",
    channelId: "channel-1",
  })

  const res = await bridge.handleInteraction({
    rawBody: JSON.stringify({
      type: 3,
      data: { custom_id: `${DISCORD_INTERVIEW_CUSTOM_ID_PREFIX}:start` },
      user: { id: "u-2" },
    }),
    headers: { debugSignatureBypass: "1" },
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.code, "DISCORD_INTERVIEW_HANDLER_TODO")
  const data = res.body.data as { content?: string }
  assert.ok((data.content ?? "").includes("Interview started"))
})

async function main() {
  let failures = 0
  console.log("Discord Bridge Module Tests")
  console.log("===========================")

  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`  PASS  ${name}`)
    } catch (err) {
      failures++
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
