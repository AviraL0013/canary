import { randomUUID } from "crypto";

const INGESTION_URL =
  process.env["INGESTION_URL"] ??
  "http://localhost:3001";

let sequence = 0;

export async function emitEvent(
  orgId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const eventId = randomUUID();

  const body = {
    event_id: eventId,
    event_type: eventType,
    spec_version: "1.0",
    org_id: orgId,
    sequence_id: ++sequence,
    timestamp: new Date().toISOString(),
    source_framework: "CUSTOM",
    idempotency_key: eventId,
    payload,
  };

  const res = await fetch(
    `${INGESTION_URL}/v1/events`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  return {
    status: res.status,
    body: await res.json(),
    eventId,
  };
}