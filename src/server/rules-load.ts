import type { StralforsClient } from '../stralfors/index.ts';
import { flattenRulesWithCriteria } from '../stralfors/rules.ts';
import type { RulesCache } from './rules-cache.ts';

/**
 * The one cached rules value per (profile, channel, template), shared by get_rules and validate_invoice. Callers must not mutate it.
 * `fetchedAt` (from `now`) lets validate_invoice tell fresh rules from cached ones (ADR 0017 item 3).
 */
export const loadRules = (cache: RulesCache, client: Pick<StralforsClient, 'rules'>, profile: string, channel: string, templateStandardId: number, now: () => number = Date.now) =>
  cache.get(profile, channel, templateStandardId, () => client.rules(channel, { templateStandardId }).then((r) => ({ ...flattenRulesWithCriteria(r.rules), fetchedAt: now() })));
