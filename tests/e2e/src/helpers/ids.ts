import { randomUUID } from "crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function edgeId(prefix = "edge"): string {
  return `${prefix}_${randomUUID()}`;
}

export function orgId(): string {
  return id("org");
}

export function scopeId(): string {
  return id("scope");
}

export function taskId(): string {
  return id("task");
}