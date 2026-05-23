// Neo4j helper utilities for E2E tests

import dotenv from "dotenv";

import neo4j, {
  Driver,
  Session,
  RecordShape,
} from "neo4j-driver";

dotenv.config();

const uri =
  process.env["NEO4J_URI"];

const user =
  process.env["NEO4J_USER"];

const password =
  process.env["NEO4J_PASSWORD"];

if (
  !uri ||
  !user ||
  !password
) {

  throw new Error(
    "Missing Neo4j environment variables",
  );
}

const driver: Driver =
  neo4j.driver(
    uri,
    neo4j.auth.basic(
      user,
      password,
    ),
  );

export async function queryNeo4j(
  query: string,
  params: Record<
    string,
    unknown
  > = {},
) {

  const session: Session =
    driver.session();

  try {

    const result =
      await session.run(
        query,
        params,
      );

    return result.records;

  } finally {

    await session.close();
  }
}

export async function clearNeo4j() {

  await queryNeo4j(`
    MATCH (n)
    DETACH DELETE n
  `);
}

export async function closeNeo4j() {

  await driver.close();
}