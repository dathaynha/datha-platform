# AI context — `chatbot-service`

AI guidance for this project is maintained in **`.claude/docs/`**:

- **`lang/lang-python-fastapi.md`** — Python / FastAPI best practices
- **`services/chatbot-service-architecture.md`** — chatbot-service business workflow and service rules
- **`products/chatbot-architecture.md`** — cross-service chat flow
- **`platform/chatbot-file-events.md`** — **canonical** NATS flow: conversation delete → orphan files → file-service (edit this file when that story changes; do not duplicate long prose in `CLAUDE.md`)
