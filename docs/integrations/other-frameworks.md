# From another agent framework

Two seams. **Tools**: a Marg domain's MCP server is an ordinary MCP server, so ADK, LangGraph, the OpenAI Agents SDK or Claude Code can call the same tools (the write gate holds there too: `create_*` refuses without `confirmed:true`). **Client**: the gateway's [client protocol](../CLIENT-PROTOCOL.md) is plain HTTP + SSE, so a Marg agent can sit behind another framework's router, an A2A agent card or a chat surface you already have — one domain per entry point.

Docs: https://marg-adk.github.io/marg/components/client-protocol
