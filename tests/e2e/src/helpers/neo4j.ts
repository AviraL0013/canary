import dotenv from "dotenv";
import neo4j from "neo4j-driver";

dotenv.config();

const uri =
  process.env["NEO4J_URI"];

const user =
  process.env["NEO4J_USER"];

const password =
  process.env["NEO4J_PASSWORD"];

if (!uri || !user || !password) {
  throw new Error(
    "Missing Neo4j environment variables",
  );
}

const driver = neo4j.driver(
  uri,
  neo4j.auth.basic(
    user,
    password,
  ),
);

export async function queryNeo4j(
  query: string,
  params: Record<string, unknown> = {},
) {
  const session = driver.session();

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

export async function closeNeo4j() {
  await driver.close();
}