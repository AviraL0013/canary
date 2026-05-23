import { randomUUID } from "crypto";

const AUTHORIZATION_URL =
  process.env["AUTHORIZATION_URL"] ??
  "http://localhost:3002";

export async function authorize(params: {
  orgId: string;
  taskId: string;
  agentId: string;
  toolId: string;
  scopeId: string;
  actionType: string;
}) {
  const requestId = randomUUID();

  const res = await fetch(
    `${AUTHORIZATION_URL}/v1/authorize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: requestId,
        requesting_agent_id: params.agentId,
        tool_id: params.toolId,
        action_type: params.actionType,
        scope_id: params.scopeId,
        task_id: params.taskId,
        org_id: params.orgId,
        timestamp: new Date().toISOString(),
        parameters_hash: "e2e_hash",
      }),
    },
  );

  return {
    status: res.status,
    body: await res.json(),
    requestId,
  };
}