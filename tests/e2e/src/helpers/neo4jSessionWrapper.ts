/**
 * Injectable Neo4j session wrapper for failure injection.
 *
 * Does NOT monkey-patch queryNeo4j.
 * Creates a thin wrapper around the real Neo4j driver
 * that can simulate actual transactional failure modes:
 *
 * - Transient deadlock errors
 * - Lock conflict errors
 * - Delayed transaction execution (simulated lock wait)
 *
 * This exercises real tx retry/rollback paths in production code
 * because it throws Neo4j-compatible error objects with real error codes.
 *
 * Usage in tests:
 *
 *   const wrapper = new InstrumentedNeo4jSession(driver, {
 *     transientFailRate: 0.3,
 *     errorCode: "Neo.TransientError.Transaction.DeadlockDetected",
 *   });
 *
 *   // Use wrapper.run() instead of session.run()
 *   const records = await wrapper.run(query, params);
 */

import neo4j, {
  type Driver,
  type Session,
  type Record as Neo4jRecord,
} from "neo4j-driver";

import dotenv from "dotenv";
dotenv.config();

export interface FailureConfig {
  /** Probability (0.0-1.0) of injecting a transient failure per query */
  transientFailRate: number;

  /** Simulate lock wait by delaying this many ms before execution */
  lockDelayMs: number;

  /** Neo4j error code to throw on injected failures */
  errorCode: string;
}

const DEFAULT_CONFIG: FailureConfig = {
  transientFailRate: 0,
  lockDelayMs: 0,
  errorCode: "Neo.TransientError.Transaction.DeadlockDetected",
};

/**
 * Neo4j-compatible error for failure injection.
 * Matches the shape that production code checks:
 *   err.code.startsWith("Neo.TransientError")
 *   err.message.includes("deadlock")
 */
class InjectedNeo4jError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Neo4jError";
    this.code = code;
  }
}

export class InstrumentedNeo4jSession {
  private readonly driver: Driver;
  private config: FailureConfig;

  /** Total injected failures */
  public failureCount: number = 0;

  /** Total queries executed (including failures) */
  public queryCount: number = 0;

  /** Total successful queries */
  public successCount: number = 0;

  constructor(
    driver: Driver,
    config?: Partial<FailureConfig>,
  ) {
    this.driver = driver;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a query, optionally injecting transient failures.
   * Mirrors the signature of queryNeo4j().
   */
  async run(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<Neo4jRecord[]> {
    this.queryCount++;

    // Inject delay (simulated lock contention)
    if (this.config.lockDelayMs > 0) {
      await new Promise((r) =>
        setTimeout(r, this.config.lockDelayMs),
      );
    }

    // Inject transient failure
    if (
      this.config.transientFailRate > 0 &&
      Math.random() < this.config.transientFailRate
    ) {
      this.failureCount++;
      throw new InjectedNeo4jError(
        this.config.errorCode,
        `Injected transient failure: ${this.config.errorCode}`,
      );
    }

    // Execute real query
    const session: Session = this.driver.session();
    try {
      const result = await session.run(query, params);
      this.successCount++;
      return result.records;
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a function within a write transaction,
   * with failure injection applied per-query inside the tx.
   */
  async writeTransaction<T>(
    work: (run: (query: string, params?: Record<string, unknown>) => Promise<Neo4jRecord[]>) => Promise<T>,
  ): Promise<T> {
    const session: Session = this.driver.session({
      defaultAccessMode: "WRITE",
    });

    const tx = session.beginTransaction();

    try {
      const txRun = async (
        query: string,
        params: Record<string, unknown> = {},
      ): Promise<Neo4jRecord[]> => {
        this.queryCount++;

        if (this.config.lockDelayMs > 0) {
          await new Promise((r) =>
            setTimeout(r, this.config.lockDelayMs),
          );
        }

        if (
          this.config.transientFailRate > 0 &&
          Math.random() < this.config.transientFailRate
        ) {
          this.failureCount++;
          throw new InjectedNeo4jError(
            this.config.errorCode,
            `Injected tx failure: ${this.config.errorCode}`,
          );
        }

        const result = await tx.run(query, params);
        this.successCount++;
        return result.records;
      };

      const result = await work(txRun);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      await session.close();
    }
  }

  /** Update failure config mid-test */
  setFailureConfig(config: Partial<FailureConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Reset all counters */
  reset(): void {
    this.failureCount = 0;
    this.queryCount = 0;
    this.successCount = 0;
  }

  /** Get current stats */
  stats(): {
    failureCount: number;
    queryCount: number;
    successCount: number;
    failureRate: number;
  } {
    return {
      failureCount: this.failureCount,
      queryCount: this.queryCount,
      successCount: this.successCount,
      failureRate:
        this.queryCount > 0
          ? this.failureCount / this.queryCount
          : 0,
    };
  }
}

/**
 * Create an InstrumentedNeo4jSession using env vars.
 * Convenience factory for tests.
 */
export function createInstrumentedSession(
  config?: Partial<FailureConfig>,
): InstrumentedNeo4jSession {
  const uri = process.env["NEO4J_URI"]!;
  const user = process.env["NEO4J_USER"]!;
  const password = process.env["NEO4J_PASSWORD"]!;

  const driver = neo4j.driver(
    uri,
    neo4j.auth.basic(user, password),
  );

  return new InstrumentedNeo4jSession(driver, config);
}
