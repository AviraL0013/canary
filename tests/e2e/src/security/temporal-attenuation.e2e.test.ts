import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { randomUUID }
  from "crypto";

import { emitEvent }
  from "../helpers/emitEvent";

const orgId =
  `org_${randomUUID().slice(0, 8)}`;

const scopeId =
  `scope_${randomUUID().slice(0, 8)}`;

const taskId =
  `task_${randomUUID().slice(0, 8)}`;

const humanId =
  `human_${randomUUID().slice(0, 8)}`;

const parentAgent =
  `agent_parent_${randomUUID().slice(0, 8)}`;

const parentExpiration =
  new Date(
    Date.now() + 86400000,
  ).toISOString();

describe(
  "temporal attenuation",
  () => {

    beforeAll(async () => {

      const root =
        await emitEvent(
          orgId,
          "delegation.created",
          {
            human_id:
              humanId,

            agent_id:
              parentAgent,

            scope_id:
              scopeId,

            permissions: [
              "read",
              "write",
            ],

            expires_at:
              parentExpiration,

            grant_reason:
              "temporal attenuation test",

            delegation_edge_id:
              `edge_${randomUUID()}`,
          },
        );

      expect(root.status)
        .toBe(200);
    });

    it(
      "allows child expiration equal to parent",
      async () => {

        const childAgent =
          `agent_child_${randomUUID().slice(0, 8)}`;

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                parentAgent,

              child_agent_id:
                childAgent,

              scope_id:
                scopeId,

              task_id:
                taskId,

              inherited_permissions: [
                "read",
              ],

              expires_at:
                parentExpiration,

              invocation_edge_id:
                `edge_${randomUUID()}`,
            },
          );

        expect(result.status)
          .toBe(200);

        expect(
          result.body.status,
        ).toBe("ingested");
      },
    );

    it(
      "rejects child expiration beyond parent",
      async () => {

        const childAgent =
          `agent_late_${randomUUID().slice(0, 8)}`;

        const invalidExpiration =
          new Date(
            Date.now() +
              172800000,
          ).toISOString();

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                parentAgent,

              child_agent_id:
                childAgent,

              scope_id:
                scopeId,

              task_id:
                taskId,

              inherited_permissions: [
                "read",
              ],

              expires_at:
                invalidExpiration,

              invocation_edge_id:
                `edge_${randomUUID()}`,
            },
          );

        expect(result.status)
          .toBe(400);

        expect(
          result.body.error,
        ).toBe(
          "TEMPORAL_ATTENUATION_VIOLATION",
        );
      },
    );
  },
);