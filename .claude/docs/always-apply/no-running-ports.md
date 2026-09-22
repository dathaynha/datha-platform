# No Running Dev Servers

_Never start or restart dev servers — user manages all ports_

The user manages all ports and servers. Follow these rules:

- **Never background a dev server** and leave it running at the end of a task.
- You MAY start a dev server temporarily to verify a fix (e.g. check compilation), but you **must kill it before ending your turn**.
- You MAY kill a port whenever the user asks.

**Sole exception:** an explicit run request from the user ("run platform", "run chatbot", "run all", …) via the **`run-platform`** skill — those servers are meant to stay running after the turn. See `.claude/skills/run-platform/SKILL.md`. Never start servers the request didn't cover.
