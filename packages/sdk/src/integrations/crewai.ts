// CrewAI integration wrapper

import { CanarySDK } from "../CanarySDK.js";

export interface CrewAIToolConfig {
  tool_id: string;
  action_type: string;
  scope_id: string;
  task_id: string;
}

export interface CrewAITool {
  name: string;
  description: string;
  run: (input: string) => Promise<string>;
}

export interface WrappedCrewAITool {
  name: string;
  description: string;
  run: (input: string) => Promise<string>;
}

/**
 * canary.wrapCrewAITool(tool) → BaseTool
 */
export function wrapCrewAITool(
  sdk: CanarySDK,
  tool: CrewAITool,
  config: CrewAIToolConfig
): WrappedCrewAITool {
  return {
    name: tool.name,
    description: tool.description,
    run: async (input: string) => {
      const parametersHash = Buffer.from(input)
        .toString("base64url")
        .slice(0, 32);

      return sdk.authorizeAndExecute({
        tool_id: config.tool_id,
        action_type: config.action_type,
        scope_id: config.scope_id,
        task_id: config.task_id,
        parameters_hash: parametersHash,
        execute: () => tool.run(input),
      });
    },
  };
}
