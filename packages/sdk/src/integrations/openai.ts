// OpenAI function integration wrapper

import { CanarySDK } from "../CanarySDK.js";

export interface OpenAIFunctionConfig {
  tool_id: string;
  action_type: string;
  scope_id: string;
  task_id: string;
}

export interface OpenAIFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface WrappedOpenAIFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * canary.wrapOpenAIFunction(fn) → ChatCompletionTool
 */
export function wrapOpenAIFunction(
  sdk: CanarySDK,
  fn: OpenAIFunction,
  config: OpenAIFunctionConfig
): WrappedOpenAIFunction {
  return {
    type: "function",
    function: {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    },
    execute: async (args: Record<string, unknown>) => {
      const parametersHash = Buffer.from(JSON.stringify(args))
        .toString("base64url")
        .slice(0, 32);

      return sdk.authorizeAndExecute({
        tool_id: config.tool_id,
        action_type: config.action_type,
        scope_id: config.scope_id,
        task_id: config.task_id,
        parameters_hash: parametersHash,
        execute: () => fn.execute(args),
      });
    },
  };
}
