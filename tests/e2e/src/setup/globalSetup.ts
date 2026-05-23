import dotenv from "dotenv";

import {
  queryNeo4j,
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
    "NEO4J_USERNAME",
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
          `${process.env.AUTHORIZATION_URL}/health`,
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
          `${process.env.INGESTION_URL}/health`,
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

  // deterministic graph cleanup

  await queryNeo4j(`
    MATCH (n)
    DETACH DELETE n
  `);

  console.log(
    "E2E global setup complete",
  );
}