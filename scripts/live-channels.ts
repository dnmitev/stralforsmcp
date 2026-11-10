import { resolve } from 'node:path';
import { ConfigError, createClient, loadConfig, StralforsError, type Claims, type Profile } from '../src/stralfors/index.ts';

export interface ChannelsClient {
  token: { get(): Promise<{ claims: Claims }> };
  channels(actionId?: string): Promise<string[]>;
}

/** Builds the report. Agreements are shown by label (or #n), never by id; one failing agreement does not stop the rest. */
export async function report(client: ChannelsClient, actionIds: Profile['actionIds']): Promise<string> {
  const { scopes, exp, aud, customerCountry } = (await client.token.get()).claims.summary();
  const out = [
    `scopes: ${scopes.join(' ')}`,
    `exp: ${exp}`,
    `aud: ${aud.join(' ')}`,
    `customerCountry: ${customerCountry}`,
    `client channels: ${(await client.channels()).join(', ')}`,
  ];
  for (const [i, a] of actionIds.entries()) {
    const name = a.label ?? `#${i + 1}`;
    try {
      out.push(`${name}: ${(await client.channels(a.id)).join(', ')}`);
    } catch (e) {
      out.push(`${name}: ${e instanceof StralforsError ? e.kind : 'unknown'}`);
    }
  }
  return out.join('\n');
}

async function main(): Promise<number> {
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const config = loadConfig(process.env);
    const profile = Object.values(config.profiles)[0];
    if (!profile) throw new ConfigError('no profile configured');
    client = createClient({ config, profileId: profile.id });
    console.log(await report(client, profile.actionIds));
    return 0;
  } catch (e) {
    console.error(e instanceof StralforsError ? `${e.kind}: ${e.safeMessage}` : 'unknown error');
    return 1;
  } finally {
    await client?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main();
}
