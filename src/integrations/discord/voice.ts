// src/integrations/discord/voice.ts
// Voice input stub for Discord attachments.

export interface DiscordAttachmentLike {
  id?: string
  name?: string | null
  url: string
  contentType?: string | null
  size?: number | null
}

export interface VoiceTranscriptionResult {
  ok: boolean
  transcript: string
  attachmentUrl: string
  contentType: string | null
  code: string
}

const AUDIO_MIME_PREFIXES = [
  "audio/",
]

const AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".webm",
  ".flac",
]

export class DiscordVoiceService {
  isAudioAttachment(attachment: DiscordAttachmentLike): boolean {
    const contentType = (attachment.contentType ?? "").toLowerCase()
    if (AUDIO_MIME_PREFIXES.some(prefix => contentType.startsWith(prefix))) return true

    const name = (attachment.name ?? "").toLowerCase()
    return AUDIO_EXTENSIONS.some(ext => name.endsWith(ext))
  }

  async transcribeAttachment(attachment: DiscordAttachmentLike): Promise<VoiceTranscriptionResult> {
    const contentType = attachment.contentType ?? null
    return {
      ok: true,
      transcript: `TODO: transcription placeholder for ${attachment.name ?? "audio-attachment"}`,
      attachmentUrl: attachment.url,
      contentType,
      code: "DISCORD_VOICE_TRANSCRIPTION_TODO",
    }
  }
}
