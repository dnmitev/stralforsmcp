import type { StralforsClient } from '../stralfors/index.ts';
import { flattenRulesWithCriteria } from '../stralfors/rules.ts';
import type { RulesCache } from './rules-cache.ts';

/** The one cached rules value per (profile, channel, template), shared by get_rules and validate_invoice. Callers must not mutate it. */
export const loadRules = (cache: RulesCache, client: Pick<StralforsClient, 'rules'>, profile: string, channel: string, templateStandardId: number) =>
  cache.get(profile, channel, templateStandardId, () => client.rules(channel, { templateStandardId }).then((r) => flattenRulesWithCriteria(r.rules)));
