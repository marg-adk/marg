# Render, Fly, Railway, Docker

One non-root image with a health check; Compose profiles for the stores, observability, decisions and the TLS edge; a Render Blueprint for a demo. [Deploy](../../deploy/DEPLOY.md) and the [production checklist](../PRODUCTION-CHECKLIST.md).

```bash
# render.yaml at the repository root: New → Blueprint
# docker build -f deploy/Dockerfile -t marg-gateway . && docker run -p 8787:8787 --env-file .env marg-gateway
```

Docs: https://render.com/docs/blueprint-spec
