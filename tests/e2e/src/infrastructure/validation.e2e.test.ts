import {
  describe,
  expect,
  it,
} from "vitest";

const INGESTION_URL =
  process.env["INGESTION_URL"] ??
  "http://localhost:3001";

describe("validation", () => {
  it(
    "rejects invalid event payload",
    async () => {
      const res = await fetch(
        `${INGESTION_URL}/v1/events`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            event_id: "bad-id",
            event_type: "bad.type",
            payload: {},
          }),
        },
      );

      expect(res.status)
        .toBe(400);

      const body =
        await res.json();

      expect(body.error)
        .toBe(
          "VALIDATION_ERROR",
        );
    },
  );
});