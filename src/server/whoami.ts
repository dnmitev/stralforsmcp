import * as z from 'zod/v4';
import type { ToolDef } from './tools.ts';

export const whoamiOutput = z.object({
  name: z.string(),
  role: z.enum(['dev', 'qa', 'pm']),
  envs: z.array(z.enum(['test', 'prod'])),
  env: z.enum(['test', 'prod']),
  tools: z.array(z.string()),
});

export const whoami: ToolDef<z.ZodObject<{}>, typeof whoamiOutput> = {
  spec: { name: 'whoami', access: 'read' },
  title: 'Who am I',
  description: 'Returns the caller name, role, allowed environments, the deployment environment and the tools visible to the caller.',
  inputSchema: z.object({}),
  outputSchema: whoamiOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(_, ctx) {
    return { name: ctx.principal.name, role: ctx.principal.role, envs: [...ctx.principal.envs], env: ctx.env, tools: ctx.visible.map((t) => t.name) };
  },
};
