# create-marg-app

```bash
npx create-marg-app my-agent
cd my-agent && npm install && npm run gateway      # http://localhost:8787
```

A fresh [Marg](https://github.com/marg-adk/marg) project: the example domain (support ticket
intake, runs offline on a scripted mock model), the templates and `npm run new-domain` to
scaffold your own, the shared skills, and a `package.json` depending on the published
`@marg/*` packages at this tool's version. Nothing is installed or started by the command itself.

Marg is an Agent Development Kit for conversational agents that complete a job: the runtime
owns forms, pickers, the confirmation and the write gate; the model owns the conversation.
