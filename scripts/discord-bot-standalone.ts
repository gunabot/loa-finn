import "dotenv/config"
import { loadConfig } from "../src/config.js"
import { createDiscordBot } from "../src/integrations/discord/bot.js"

async function main() {
  const config = loadConfig()
  console.log("[finn-discord] starting standalone bot...")
  console.log(`[finn-discord] guild=${process.env.DISCORD_GUILD_ID}, channel=${config.discord.channelId}`)
  
  const bot = await createDiscordBot(config, {
    logger: {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m, e) => console.error(m, e),
    },
  })
  
  await bot.start()
  console.log("[finn-discord] bot is running. Press Ctrl+C to stop.")
  
  process.on("SIGINT", async () => {
    console.log("[finn-discord] shutting down...")
    await bot.stop()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error("[finn-discord] fatal:", err)
  process.exit(1)
})
