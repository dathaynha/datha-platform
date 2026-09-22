/** Minimal env so `src/config.ts` loads in unit tests (no real `.env`). */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://localhost/file_service_test";
process.env.AZURE_STORAGE_ACCOUNT =
  process.env.AZURE_STORAGE_ACCOUNT ?? "testaccount";
process.env.AZURE_STORAGE_CONTAINER =
  process.env.AZURE_STORAGE_CONTAINER ?? "files";
process.env.AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP =
  process.env.NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP ??
  "3";
