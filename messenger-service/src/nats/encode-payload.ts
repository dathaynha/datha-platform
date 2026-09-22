/** UTF-8 JSON bytes for NATS JetStream publish (symmetric with ingest parsers). */
export function encodeJsonPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
