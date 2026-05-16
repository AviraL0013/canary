// ContextCache — Redis wrapper for AuthorizationContext caching
// Namespace: authz:context:{org_id}:{agent_id}
// TTL: 30 seconds
// Revocation events immediately invalidate affected cache keys.

import type { Redis } from "ioredis";
import type { AuthorizationContext } from "@canary/graph-core";

const CACHE_TTL_SECONDS = 30;
const KEY_PREFIX = "authz:context";

export class ContextCache {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private key(org_id: string, agent_id: string): string {
    return `${KEY_PREFIX}:${org_id}:${agent_id}`;
  }

  async get(
    org_id: string,
    agent_id: string
  ): Promise<AuthorizationContext | null> {
    const raw = await this.redis.get(this.key(org_id, agent_id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthorizationContext;
    } catch {
      // Corrupted cache entry — treat as miss
      await this.invalidate(org_id, agent_id);
      return null;
    }
  }

  async set(
    org_id: string,
    agent_id: string,
    context: AuthorizationContext
  ): Promise<void> {
    await this.redis.set(
      this.key(org_id, agent_id),
      JSON.stringify(context),
      "EX",
      CACHE_TTL_SECONDS
    );
  }

  async invalidate(org_id: string, agent_id: string): Promise<void> {
    await this.redis.del(this.key(org_id, agent_id));
  }

  async invalidateMany(
    org_id: string,
    agent_ids: string[]
  ): Promise<void> {
    if (agent_ids.length === 0) return;
    const keys = agent_ids.map((id) => this.key(org_id, id));
    await this.redis.del(...keys);
  }

  async verifyConnectivity(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === "PONG";
    } catch {
      return false;
    }
  }
}
