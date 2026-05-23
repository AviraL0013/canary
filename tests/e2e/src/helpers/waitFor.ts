import { queryNeo4j } from "./neo4j";

export async function waitFor(
  condition: () => Promise<boolean>,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
    description?: string;
  },
): Promise<void> {
  const timeoutMs =
    options?.timeoutMs ?? 15000;

  const intervalMs =
    options?.intervalMs ?? 250;

  const start = Date.now();

  while (
    Date.now() - start <
    timeoutMs
  ) {
    const ok =
      await condition();

    if (ok) {
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, intervalMs),
    );
  }

  throw new Error(
    `waitFor timeout: ${
      options?.description ??
      "condition"
    }`,
  );
}

/**
 * Wait until an edge reaches
 * a target status.
 */
export async function waitForEdgeStatus(
  edgeId: string,
  expectedStatus: string,
) {
  await waitFor(
    async () => {
      const result =
        await queryNeo4j(
          `
          MATCH ()-[r:DELEGATED_TO]->()
          WHERE r.id = $edgeId
          RETURN r.status AS status
          `,
          { edgeId },
        );

      if (result.length !== 1) {
        return false;
      }

      return (
        result[0].get("status") ===
        expectedStatus
      );
    },
    {
      description:
        `edge ${edgeId} status=${expectedStatus}`,
    },
  );
}

/**
 * Wait until an agent has
 * zero ACTIVE incoming edges.
 */
export async function waitForNoActiveEdges(
  agentId: string,
) {
  await waitFor(
    async () => {
      const result =
        await queryNeo4j(
          `
          MATCH (:Agent {id: $agentId})
            <-[r:DELEGATED_TO]-()
          WHERE r.status = "ACTIVE"
          RETURN count(r) AS activeCount
          `,
          { agentId },
        );

      const count = Number(
        result[0].get("activeCount"),
      );

      return count === 0;
    },
    {
      description:
        `no active edges for ${agentId}`,
    },
  );
}

/**
 * Wait until Neo4j is reachable.
 */
export async function waitForNeo4j() {
  await waitFor(
    async () => {
      try {
        const result =
          await queryNeo4j(
            "RETURN 1 AS value",
          );

        return (
          Number(
            result[0].get("value"),
          ) === 1
        );
      } catch {
        return false;
      }
    },
    {
      timeoutMs: 30000,
      intervalMs: 1000,
      description:
        "neo4j connectivity",
    },
  );
}