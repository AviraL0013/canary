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

import { authorize }
  from "../helpers/authorize";

import {
  waitFor,
} from "../helpers/waitFor";

const orgId =
  `org_${randomUUID().slice(0, 8)}`;

const scopeId =
  `scope_${randomUUID().slice(0, 8)}`;

const taskId =
  `task_${randomUUID().slice(0, 8)}`;

const toolId =
  `tool_${randomUUID().slice(0, 8)}`;

const actionId =
  `action_${randomUUID().slice(0, 8)}`;

const humanId =
  `human_${randomUUID().slice(0, 8)}`;

const parentAgent =
  `parent_${randomUUID().slice(0, 8)}`;

const childAgent =
  `child_${randomUUID().slice(0, 8)}`;

const expiresAt =
  new Date(
    Date.now() + 86400000,
  ).toISOString();

const rootEdgeId =
  `edge_root_${randomUUID()}`;

describe(
  "authorization lifecycle",
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
              "execute",
            ],

            expires_at:
              expiresAt,

            grant_reason:
              "lifecycle test",

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
              parentAgent,

            child_agent_id:
              childAgent,

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
              `edge_${randomUUID()}`,
          },
        );

      expect(child.status)
        .toBe(200);

      await emitEvent(
        orgId,
        "tool.called",
        {
          agent_id:
            childAgent,

          tool_id:
            toolId,

          scope_id:
            scopeId,

          parameters_hash:
            "hash",

          authorization_decision_id:
            "bootstrap",

          called_edge_id:
            `edge_${randomUUID()}`,

          tool_risk_tier:
            "LOW",
        },
      );

      await waitFor(
        async () => {

          const result =
            await authorize({
              orgId,
              taskId,
              scopeId,
              agentId:
                childAgent,

              toolId,

              actionType:
                "execute",
            });

          

          return (
            result.status === 200
          );
        },
        {
          timeoutMs: 15000,
          intervalMs: 500,
          description:
            "authorization readiness",
        },
      );

    });

    it(
      "authorizes valid delegated execution",
      async () => {

        const result =
          await authorize({
            orgId,
            taskId,
            scopeId,
            agentId:
              childAgent,

            toolId,

            actionType:
              "execute",
          });

        expect(result.status)
          .toBe(200);

        expect(
          result.body.decision,
        ).toBe("ALLOW");
      },
    );

    it(
      "records executable action",
      async () => {

        const action =
  await emitEvent(
    orgId,
    "action.executed",
    {
      agent_id:
        childAgent,

      tool_id:
        toolId,

      scope_id:
        scopeId,

      authorization_decision_id:
        "dec_test",

      executed_edge_id:
        `edge_${randomUUID()}`,

      action_id:
        actionId,

      action_type:
        "execute",

      target_system:
        "github",

      parameters_hash:
        "hash",

      outcome:
        "APPROVED",

      reversible:
        true,
    },
  );
console.dir(
  action.body,
  { depth: null },
);
        expect(action.status)
          .toBe(200);
      },
    );

    it(
      "revokes delegated authority",
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
                parentAgent,

              revocation_reason:
                "lifecycle revoke",

              cascade_affected_agents: [
                parentAgent,
                childAgent,
              ],
            },
          );

        expect(revoke.status)
          .toBe(200);
      },
    );

    it(
      "blocks authorization after revoke",
      async () => {

        await waitFor(
          async () => {

            const result =
              await authorize({
                orgId,
                taskId,
                scopeId,
                agentId:
                  childAgent,

                toolId,

                actionType:
                  "execute",
              });

            return (
              result.status === 200 &&
              result.body.decision ===
                "BLOCK"
            );
          },
          {
            timeoutMs: 15000,
            intervalMs: 500,
            description:
              "authorization revoke convergence",
          },
        );

        const result =
          await authorize({
            orgId,
            taskId,
            scopeId,
            agentId:
              childAgent,

            toolId,

            actionType:
              "execute",
          });

        expect(result.status)
          .toBe(200);

        expect(
          result.body.decision,
        ).toBe("BLOCK");
      },
    );
  },
);