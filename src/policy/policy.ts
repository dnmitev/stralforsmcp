import type { Env, Principal } from '../auth/index.ts';

export type Access = 'read' | 'validate' | 'write';
export interface ToolSpec { name: string; access: Access; requiredScope?: string }
export type DenyReason = 'env' | 'role' | 'write' | 'validate' | 'scope';
export type Decision = { allow: true } | { allow: false; reason: DenyReason };
/** `Claims` satisfies this; policy needs nothing else from it. */
export interface ScopeHolder { hasScope(s: string): boolean }
export interface PolicyContext { principal: Principal; env: Env; allowWrite: boolean; prodValidateEnabled: boolean; claims?: ScopeHolder }

export const WRITE_SCOPE = 'apiomni.write';

const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

/** Order matters: env, role, write, validate, scope. The first failing rule is the reason. */
export function decide({ principal, env, allowWrite, prodValidateEnabled, tool, claims }: PolicyContext & { tool: ToolSpec }): Decision {
  if (!principal.envs.includes(env)) return deny('env');
  if (env === 'prod' && principal.role !== 'dev') return deny('role');
  const write = tool.access === 'write';
  if (write && env === 'prod') return deny('write'); // hard constant: never depends on allowWrite
  if (write && !allowWrite) return deny('write');
  if (tool.access === 'validate' && env === 'prod' && !prodValidateEnabled) return deny('validate');
  const required = tool.requiredScope ?? (write ? WRITE_SCOPE : undefined);
  if (required !== undefined && !claims?.hasScope(required)) return deny('scope');
  return { allow: true };
}

export const visibleTools = (ctx: PolicyContext, tools: ToolSpec[]): ToolSpec[] => tools.filter((tool) => decide({ ...ctx, tool }).allow);
