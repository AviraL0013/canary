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
  assertEdgeStatus,
  assertNoActiveEdges,
} from "../helpers/graphAssertions";

import {
  waitForEdgeStatus,
  waitForNoActiveEdges,
} from "../helpers/waitFor";

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

const expiresAt =
  new Date(
    Date.now() + 86400000,
  ).toISOString();

const rootEdgeId =
  `edge_root_${randomUUID()}`;

const childEdgeId =
  `edge_child_${randomUUID()}`;

describe(
  "revocation",
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
              "execute",
            ],

            expires_at:
              expiresAt,

            grant_reason:
              "revocation test",

            delegation_edge_id:
              rootEdgeId,
          },
        );

      expect(root.status)
        .toBe(200);

      const child =
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
              "execute",
            ],

            expires_at:
              expiresAt,

            invocation_edge_id:
              childEdgeId,
          },
        );

      expect(child.status)
        .toBe(200);
    });

    it(
      "revokes authority transitively",
      async () => {

        const revoke =
          await emitEvent(
            orgId,
            "delegation.revoked",
            {
              delegation_edge_id:
                rootEdgeId,

              human_id:
                humanId,

              agent_id:
                agentA,

              revocation_reason:
                "security test",

              cascade_affected_agents: [
                agentA,
                agentB,
              ],
            },
          );

        expect(revoke.status)
          .toBe(200);

        await waitForEdgeStatus(
          rootEdgeId,
          "REVOKED",
        );

        await waitForEdgeStatus(
          childEdgeId,
          "REVOKED",
        );

        await assertEdgeStatus(
          rootEdgeId,
          "REVOKED",
        );

        await assertEdgeStatus(
          childEdgeId,
          "REVOKED",
        );
      },
    );

    it(
      "rejects delegation from revoked authority",
      async () => {

        const result =
          await emitEvent(
            orgId,
            "delegation.invoked",
            {
              parent_agent_id:
                agentB,

              child_agent_id:
                `agent_${randomUUID().slice(0, 8)}`,

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
console.log(result.body);
        expect(result.status)
          .toBe(400);

        expect(
          result.body.error,
        ).toBe(
          "PARENT_AUTHORITY_INVALID",
        );
      },
    );

    it(
      "removes active edges after cascade",
      async () => {

        await waitForNoActiveEdges(
          agentB,
        );

        await assertNoActiveEdges(
          agentB,
        );
      },
    );
  },
);