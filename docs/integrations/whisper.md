# Whisper-compatible (OpenAI, Groq, self-hosted)

Any `/audio/transcriptions` endpoint: OpenAI, Groq, or a self-hosted faster-whisper / whisper.cpp server — the same provider branch.

```bash
AGENT_STT_PROVIDER=openai
AGENT_STT_BASE=https://api.openai.com/v1   # or https://api.groq.com/openai/v1, or your faster-whisper server
AGENT_STT_API_KEY=…
AGENT_STT_MODEL=whisper-1   # groq: whisper-large-v3-turbo
```

Docs: https://platform.openai.com/docs/guides/speech-to-text
