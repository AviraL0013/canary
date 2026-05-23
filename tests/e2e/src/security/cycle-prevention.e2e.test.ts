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
  assertSingleActiveParent,
} from "../helpers/graphAssertions";

const orgId =
  `org_${randomUUID().slice(0, 8)}`;

const scopeId =
  `scope_${randomUUID().slice(0, 8)}`;

const taskId =
  `task_${randomUUID().slice(0, 8)}`;

const humanId =
  `human_${randomUUID().slice(0, 8)}`;

const agentA =
  `agent_a_${randomUUID().slice(0, 8)}`;

const agentB =
  `agent_b_${randomUUID().slice(0, 8)}`;

const agentC =
  `agent_c_${randomUUID().slice(0, 8)}`;

const expiresAt =
  new Date(
    Date.now() + 86400000,
  ).toISOString();

describe(
  "cycle prevention",
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
              agentA,

            scope_id:
              scopeId,

            permissions: [
              "read",
              "write",
            ],

            expires_at:
              expiresAt,

            grant_reason:
              "cycle test",

            delegation_edge_id:
              `edge_${randomUUID()}`,
          },
        );

      expect(root.status)
        .toBe(200);
    });

    it(
      "rejects self loop A -> A",
      async () => {

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agentA,

              child_agent_id:
                agentA,

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

        expect(result.status)
          .toBe(400);

        expect(
          result.body.error,
        ).toBe(
          "DELEGATION_CYCLE",
        );
      },
    );

    it(
      "creates valid chain A -> B -> C",
      async () => {

        const ab =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agentA,

              child_agent_id:
                agentB,

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

        expect(ab.status)
          .toBe(200);

        const bc =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agentB,

              child_agent_id:
                agentC,

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

        expect(bc.status)
          .toBe(200);

        await assertSingleActiveParent(
          agentB,
        );

        await assertSingleActiveParent(
          agentC,
        );
      },
    );

    it(
      "rejects transitive cycle C -> A",
      async () => {

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agentC,

              child_agent_id:
                agentA,

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
          
        expect(result.status)
          .toBe(400);

        expect(
          result.body.error,
        ).toBe(
          "DELEGATION_CYCLE",
        );
      },
    );
  },
);