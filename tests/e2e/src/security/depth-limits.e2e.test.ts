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

import {
  assertEdgeDepth,
} from "../helpers/graphAssertions";

const orgId =
  `org_${randomUUID().slice(0, 8)}`;

const scopeId =
  `scope_${randomUUID().slice(0, 8)}`;

const taskId =
  `task_${randomUUID().slice(0, 8)}`;

const humanId =
  `human_${randomUUID().slice(0, 8)}`;

const expiresAt =
  new Date(
    Date.now() + 86400000,
  ).toISOString();

describe(
  "depth limits",
  () => {

    const agents: string[] = [];

    beforeAll(async () => {

      for (let i = 0; i < 7; i++) {
        agents.push(
          `agent_${i}_${randomUUID().slice(0, 8)}`,
        );
      }

      const rootEdgeId =
        `edge_root_${randomUUID()}`;

      const root =
        await emitEvent(
          orgId,
          "delegation.created",
          {
            human_id:
              humanId,

            agent_id:
              agents[0],

            scope_id:
              scopeId,

            permissions: [
              "read",
            ],

            expires_at:
              expiresAt,

            grant_reason:
              "depth test",

            delegation_edge_id:
              rootEdgeId,
          },
        );

      expect(root.status)
        .toBe(200);

      await assertEdgeDepth(
        rootEdgeId,
        0,
      );
    });

    it(
      "increments delegation depth deterministically",
      async () => {

        let previous =
          agents[0];

        for (
          let depth = 1;
          depth <= 4;
          depth++
        ) {
          const edgeId =
            `edge_${randomUUID()}`;

          const result =
            await emitEvent(
              orgId,
              "delegation.invoked",
              {
                parent_agent_id:
                  previous,

                child_agent_id:
                  agents[depth],

                scope_id:
                  scopeId,

                task_id:
                  taskId,

                inherited_permissions: [
                  "read",
                ],

                expires_at:
                  expiresAt,

                invocation_edge_id:
                  edgeId,
              },
            );

          expect(result.status)
            .toBe(200);

          await assertEdgeDepth(
            edgeId,
            depth,
          );

          previous =
            agents[depth];
        }
      },
    );

    it(
      "rejects delegations beyond max depth",
      async () => {

        const edge5 =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agents[4],

              child_agent_id:
                agents[5],

              scope_id:
                scopeId,

              task_id:
                taskId,

              inherited_permissions: [
                "read",
              ],

              expires_at:
                expiresAt,

              invocation_edge_id:
                `edge_${randomUUID()}`,
            },
          );

        expect(edge5.status)
          .toBe(200);

        const overflow =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agents[5],

              child_agent_id:
                agents[6],

              scope_id:
                scopeId,

              task_id:
                taskId,

              inherited_permissions: [
                "read",
              ],

              expires_at:
                expiresAt,

              invocation_edge_id:
                `edge_${randomUUID()}`,
            },
          );

        expect(overflow.status)
          .toBe(400);

        expect(
          overflow.body.error,
        ).toBe(
          "DEPTH_EXCEEDED",
        );
      },
    );
  },
);