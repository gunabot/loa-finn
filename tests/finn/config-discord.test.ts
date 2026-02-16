// tests/finn/config-discord.test.ts — Discord config loading (slice 1)

import assert from "node:assert/strict"
import { loadConfig } from "../../src/config.js"

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

async function withEnv(
  updates: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {}
  for (const key of Object.keys(updates)) prev[key] = process.env[key]

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    await fn()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("discord config defaults are loaded when env vars are absent", async () => {
  await withEnv(
    {
      ANTHROPIC_API_KEY: "test-ant-key",
      DISCORD_ENABLED: undefined,
      DISCORD_BOT_TOKEN: undefined,
      DISCORD_APP_ID: undefined,
      DISCORD_PUBLIC_KEY: undefined,
      DISCORD_CHANNEL_ID: undefined,
    },
    () => {
      const config = loadConfig()
      assert.deepEqual(config.discord, {
        enabled: false,
        botToken: "",
        appId: "",
        publicKey: "",
        channelId: "",
      })
    },
  )
})

test("discord config env overrides are loaded", async () => {
  await withEnv(
    {
      ANTHROPIC_API_KEY: "test-ant-key",
      DISCORD_ENABLED: "true",
      DISCORD_BOT_TOKEN: "bot-token-123",
      DISCORD_APP_ID: "app-456",
      DISCORD_PUBLIC_KEY: "pub-key-789",
      DISCORD_CHANNEL_ID: "chan-42",
    },
    () => {
      const config = loadConfig()
      assert.deepEqual(config.discord, {
        enabled: true,
        botToken: "bot-token-123",
        appId: "app-456",
        publicKey: "pub-key-789",
        channelId: "chan-42",
      })
    },
  )
})

async function main() {
  let failures = 0
  console.log("Discord Config Loading Tests")
  console.log("============================")

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
