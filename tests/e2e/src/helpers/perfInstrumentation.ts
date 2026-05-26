/**
 * Performance instrumentation utilities.
 *
 * Phase 1: collect metrics, compute distributions, establish baselines.
 * NO hard SLAs — different machines/docker setups would make them flaky.
 *
 * Future phases will add:
 * - regression thresholds
 * - percentile alerts
 * - CI performance gates
 *
 * Usage:
 *
 *   const collector = createCollector("revocation_cascade");
 *
 *   const { result, duration_ms } = await measure(
 *     "cascade_100_agents",
 *     () => revocationCascade(edgeId),
 *   );
 *
 *   collector.record("cascade_100_agents", duration_ms, { agents: 100 });
 *
 *   const report = await collector.flush();
 *   // → writes JSON to tests/e2e/output/
 */

import { promises as fs } from "fs";
import { join } from "path";
import { platform, version as nodeVersion } from "os";

// ─── types ────────────────────────────────────────────────────────────────────

export interface TimingMetric {
  name: string;
  duration_ms: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface PercentileSummary {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  count: number;
}

export interface PerfReport {
  suite: string;
  run_at: string;

  environment: {
    node_version: string;
    os: string;
    neo4j_uri: string;
  };

  metrics: TimingMetric[];
  summary: PercentileSummary;
}

// ─── measure ──────────────────────────────────────────────────────────────────

/**
 * Wrap an async operation and capture wall-clock duration.
 */
export async function measure<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{
  result: T;
  duration_ms: number;
  metric: TimingMetric;
}> {
  const start = performance.now();

  const result = await fn();

  const duration_ms = performance.now() - start;

  const metric: TimingMetric = {
    name,
    duration_ms: Math.round(duration_ms * 100) / 100,
    timestamp: new Date().toISOString(),
  };

  return { result, duration_ms, metric };
}

// ─── percentiles ──────────────────────────────────────────────────────────────

/**
 * Compute percentile distribution from collected durations.
 */
export function computePercentiles(
  durations: number[],
): PercentileSummary {
  if (durations.length === 0) {
    return {
      p50: 0, p90: 0, p95: 0, p99: 0,
      min: 0, max: 0, mean: 0, stddev: 0, count: 0,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;

  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * n) - 1;
    return sorted[Math.max(0, Math.min(idx, n - 1))];
  };

  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance =
    sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;

  return {
    p50: round(percentile(50)),
    p90: round(percentile(90)),
    p95: round(percentile(95)),
    p99: round(percentile(99)),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
    count: n,
  };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─── reporter ─────────────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = join(
  process.cwd(),
  "output",
);

/**
 * Write a performance report as JSON to the output directory.
 */
export async function writeReport(
  report: PerfReport,
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const filename = `${report.suite}_${timestamp}.json`;
  const filepath = join(outputDir, filename);

  await fs.writeFile(
    filepath,
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  return filepath;
}

// ─── collector ────────────────────────────────────────────────────────────────

/**
 * Create a metric collector for a test suite.
 *
 * Usage:
 *   const collector = createCollector("my_suite");
 *   collector.record("op_name", 42.5, { agents: 100 });
 *   const report = await collector.flush();
 */
export function createCollector(suiteName: string) {
  const metrics: TimingMetric[] = [];

  return {
    /**
     * Record a timing metric.
     */
    record(
      name: string,
      duration_ms: number,
      metadata?: Record<string, unknown>,
    ): void {
      metrics.push({
        name,
        duration_ms: round(duration_ms),
        timestamp: new Date().toISOString(),
        metadata,
      });
    },

    /**
     * Compute summary and write report to disk.
     * Returns the complete PerfReport.
     */
    async flush(
      outputDir?: string,
    ): Promise<PerfReport> {
      const durations = metrics.map((m) => m.duration_ms);
      const summary = computePercentiles(durations);

      const report: PerfReport = {
        suite: suiteName,
        run_at: new Date().toISOString(),
        environment: {
          node_version: process.version,
          os: `${platform()}`,
          neo4j_uri: process.env["NEO4J_URI"] ?? "unknown",
        },
        metrics,
        summary,
      };

      await writeReport(report, outputDir);
      return report;
    },

    /**
     * Get collected metrics without flushing.
     */
    getMetrics(): TimingMetric[] {
      return [...metrics];
    },

    /**
     * Get current count.
     */
    count(): number {
      return metrics.length;
    },
  };
}
