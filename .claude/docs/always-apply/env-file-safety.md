# .env File Safety

_Restricts AI from editing .env files containing real secrets_

**NEVER read or edit `.env` files** in any backend service directory (`api-gateway/`, `chatbot-service/`, `file-service/`, or any future service).

These files contain real secrets (API keys, DB passwords, JWT secrets) and must never be touched.

## Allowed

- `.env.example` files in any directory — safe to read and edit (no real secrets)
- `environment.ts` / `environment.*.ts` in frontend projects (`chatbot-frontend/`, `shell-frontend/`) — safe to read and edit

## Forbidden

- `api-gateway/.env`
- `chatbot-service/.env`
- `file-service/.env`
- Any `*.env` or `.env.*` (e.g. `.env.local`, `.env.production`) in backend service directories

When the user asks to update env config, **only update the `.env.example`** and instruct the user to apply the same change to their own `.env`.
