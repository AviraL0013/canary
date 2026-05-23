import {
  describe,
  expect,
  it,
} from "vitest";

import { randomUUID } from "crypto";

const INGESTION_URL =
  process.env["INGESTION_URL"] ??
  "http://localhost:3001";

describe("idempotency", () => {
  it(
    "deduplicates duplicate events",
    async () => {
      const eventId =
        randomUUID();

      const payload = {
        human_id:
          `human_${randomUUID().slice(0, 8)}`,

        agent_id:
          `agent_${randomUUID().slice(0, 8)}`,

        scope_id:
          `scope_${randomUUID().slice(0, 8)}`,

        permissions: [
          "read",
        ],

        expires_at:
          new Date(
            Date.now() +
              86400000,
          ).toISOString(),

        grant_reason:
          "idempotency test",

        delegation_edge_id:
          `edge_${randomUUID()}`,
      };

      const event = {
        event_id: eventId,
        event_type:
          "delegation.created",

        spec_version: "1.0",

        org_id:
          `org_${randomUUID().slice(0, 8)}`,

        sequence_id: 1,

        timestamp:
          new Date().toISOString(),

        source_framework:
          "CUSTOM",

        idempotency_key:
          eventId,

        payload,
      };

      const post = () =>
        fetch(
          `${INGESTION_URL}/v1/events`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify(
              event,
            ),
          },
        );

      const first =
        await post();

      expect(first.status)
        .toBe(200);

      const firstBody =
        await first.json();

      expect(
        firstBody.status,
      ).toBe("ingested");

      const second =
        await post();

      expect(second.status)
        .toBe(200);

      const secondBody =
        await second.json();

      expect(
        secondBody.status,
      ).toBe("duplicate");
    },
  );
});