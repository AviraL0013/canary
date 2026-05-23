import {
  describe,
  expect,
  it,
} from "vitest";

import { randomUUID } from "crypto";

import { emitEvent }
  from "../helpers/emitEvent";

const AUDIT_URL =
  process.env["AUDIT_URL"] ??
  "http://localhost:3003";

describe("inventory", () => {
  it(
    "lists agents for org",
    async () => {
      const orgId =
        `org_${randomUUID().slice(0, 8)}`;

      const humanId =
        `human_${randomUUID().slice(0, 8)}`;

      const agentId =
        `agent_${randomUUID().slice(0, 8)}`;

      await emitEvent(
        orgId,
        "delegation.created",
        {
          human_id: humanId,

          agent_id: agentId,

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
            "inventory test",

          delegation_edge_id:
            `edge_${randomUUID()}`,
        },
      );

      const params =
        new URLSearchParams({
          org_id: orgId,
        });

      const res = await fetch(
        `${AUDIT_URL}/v1/inventory/agents?${params}`,
      );

      expect(res.status)
        .toBe(200);

      const body =
        await res.json();

      expect(
        Array.isArray(
          body.agents,
        ),
      ).toBe(true);
    },
  );
});