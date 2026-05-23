import dotenv from "dotenv";

import {
  clearNeo4j,
  closeNeo4j,
} from "../helpers/neo4j";

import {
  waitFor,
} from "../helpers/waitFor";

dotenv.config();

export default async function globalSetup() {

  const required = [
    "INGESTION_URL",
    "AUTHORIZATION_URL",
    "NEO4J_URI",
    "NEO4J_USER",
    "NEO4J_PASSWORD",
  ];

  for (const key of required) {

    if (!process.env[key]) {

      throw new Error(
        `Missing env: ${key}`,
      );
    }
  }

  await waitFor(
    async () => {

      const response =
        await fetch(
          `${process.env.AUTHORIZATION_URL}/v1/health`,
        );

      return response.ok;
    },
    {
      timeoutMs: 30000,
      intervalMs: 1000,
      description:
        "authorization readiness",
    },
  );

  await waitFor(
    async () => {

      const response =
        await fetch(
          `${process.env.INGESTION_URL}/v1/health`,
        );

      return response.ok;
    },
    {
      timeoutMs: 30000,
      intervalMs: 1000,
      description:
        "ingestion readiness",
    },
  );

  await clearNeo4j();

  console.log(
    "E2E global setup complete",
  );

  // REAL vitest teardown
  return async () => {

    try {

      await clearNeo4j();

      await closeNeo4j();

      console.log(
        "E2E global teardown complete",
      );

    } catch (err) {

      console.error(
        "Global teardown cleanup failed",
        err,
      );
    }
  };
}