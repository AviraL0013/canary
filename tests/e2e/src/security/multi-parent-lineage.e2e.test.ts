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

const rootAgent =
  `root_${randomUUID().slice(0, 8)}`;

const parentA =
  `parent_a_${randomUUID().slice(0, 8)}`;

const parentB =
  `parent_b_${randomUUID().slice(0, 8)}`;

const childAgent =
  `child_${randomUUID().slice(0, 8)}`;

const expiresAt =
  new Date(
    Date.now() + 86400000,
  ).toISOString();

describe(
  "multi parent lineage",
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
              rootAgent,

            scope_id:
              scopeId,

            permissions: [
              "read",
              "write",
            ],

            expires_at:
              expiresAt,

            grant_reason:
              "lineage test",

            delegation_edge_id:
              `edge_${randomUUID()}`,
          },
        );

      expect(root.status)
        .toBe(200);

      const a =
        await emitEvent(
          orgId,
          "delegation.invoked",
          {
            parent_agent_id:
              rootAgent,

            child_agent_id:
              parentA,

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

      expect(a.status)
        .toBe(200);

      const b =
        await emitEvent(
          orgId,
          "delegation.invoked",
          {
            parent_agent_id:
              rootAgent,

            child_agent_id:
              parentB,

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

      expect(b.status)
        .toBe(200);
    });

    it(
      "allows first active authority source",
      async () => {

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                parentA,

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
                expiresAt,

              invocation_edge_id:
                `edge_${randomUUID()}`,
            },
          );

        expect(result.status)
          .toBe(200);

        await assertSingleActiveParent(
          childAgent,
        );
      },
    );

    it(
      "rejects second active authority source",
      async () => {

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                parentB,

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
          "MULTIPLE_ACTIVE_AUTHORITIES",
        );
      },
    );
  },
);