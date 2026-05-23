import { describe, it, expect } from "vitest";

const AUTHORIZATION_URL =
  process.env["AUTHORIZATION_URL"] ??
  "http://localhost:3002";

describe("health", () => {
  it("authorization service is healthy", async () => {
    const res = await fetch(
      `${AUTHORIZATION_URL}/v1/health`,
    );

    expect(res.status).toBe(200);

    const body =
      await res.json();

    expect(body.status)
      .toBe("healthy");
  });
});