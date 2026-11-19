// Checks a built .mcpb: expected entries only, manifest version matches package.json, licence files present, no source map, no credential-looking file.
import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED = ['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES', 'manifest.json', 'server/index.js', 'server/package.json'];
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Returns a list of problems (empty when the archive is fine). */
export function verifyMcpb(zip: Uint8Array, packageVersion: string): string[] {
  const out: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    return ['archive is not a readable zip'];
  }
  for (const n of Object.keys(files)) if (!EXPECTED.includes(n)) out.push(`unexpected entry: ${n}`);
  for (const n of EXPECTED) if (files[n] === undefined) out.push(`missing entry: ${n}`);
  for (const n of ['LICENSE', 'THIRD-PARTY-NOTICES']) if (files[n] !== undefined && files[n].length === 0) out.push(`${n} is empty`);
  if (files['manifest.json'] !== undefined) {
    try {
      const v = (JSON.parse(dec(files['manifest.json'])) as { version?: unknown }).version;
      if (v !== packageVersion) out.push(`manifest version ${String(v)} differs from package.json ${packageVersion}`);
    } catch {
      out.push('manifest.json is not valid JSON');
    }
  }
  if (files['server/index.js'] !== undefined && /sourceMappingURL/.test(dec(files['server/index.js']))) out.push('server/index.js references a source map');
  return out;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('mcpb-verify: usage: node scripts/mcpb-verify.ts <file.mcpb>');
    process.exit(2);
  }
  const root = join(import.meta.dirname, '..');
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const problems = verifyMcpb(new Uint8Array(readFileSync(file)), version);
  if (problems.length > 0) {
    for (const p of problems) console.error(`mcpb-verify: ${p}`);
    process.exit(1);
  }
  console.log('mcpb-verify: ok');
}
