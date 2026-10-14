# MCP tool servers (any language)

Your backend sits behind an MCP server the gateway spawns over stdio: TypeScript (the templates), Python (FastMCP), Go, Java, anything. The user's token and the trace context ride `_meta`, never tool arguments. Existing MCP servers plug in as domains once they expose the validate / preview / create triad.

```bash
# domain.json: "mcp": { "command": "python", "args": ["domains/bookings/mcp/server.py"] }
```

Docs: https://modelcontextprotocol.io
