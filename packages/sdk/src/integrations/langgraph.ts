// LangGraph integration wrapper
// Wraps a LangGraph StructuredTool to inject Canary authorization transparently.

import { CanarySDK } from "../CanarySDK.js";

export interface LangGraphToolConfig {
  name: string;
  description: string;
  tool_id: string;
  action_type: string;
  scope_id: string;
  task_id: string;
}

export interface WrappedLangGraphTool {
  name: string;
  description: string;
  invoke: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * canary.wrapLangGraphTool(tool) → StructuredTool
 * Agent framework code does not change — authorization is injected transparently.
 */
export function wrapLangGraphTool(
  sdk: CanarySDK,
  tool: { name: string; description: string; invoke: (input: Record<string, unknown>) => Promise<unknown> },
  config: Omit<LangGraphToolConfig, "name" | "description">
): WrappedLangGraphTool {
  return {
    name: tool.name,
    description: tool.description,
    invoke: async (input: Record<string, unknown>) => {
      const parametersHash = hashObject(input);
      return sdk.authorizeAndExecute({
        tool_id: config.tool_id,
        action_type: config.action_type,
        scope_id: config.scope_id,
        task_id: config.task_id,
        parameters_hash: parametersHash,
        execute: () => tool.invoke(input),
      });
    },
  };
}

function hashObject(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url").slice(0, 32);
}
