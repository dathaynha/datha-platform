process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://localhost/notification_service_test";
process.env.NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS =
  process.env.NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS ?? "3";
