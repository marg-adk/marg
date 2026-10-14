# LiteRT-LM and other on-device runtimes

Marg's gateway is a Node service; an on-device runtime (LiteRT-LM, MLC, MediaPipe) belongs in the client, not behind the gateway. Serve the same model locally with Ollama or llama.cpp for development, and put the on-device model behind the client protocol if you build a native client.

Provider docs: https://ai.google.dev/edge/litert
