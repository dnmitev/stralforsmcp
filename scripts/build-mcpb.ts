// Builds dist/stralforsmcp.mcpb: the stdio bridge bundled into one file, plus manifest and README, zipped deterministically.
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

/** Bundles extension/src/proxy.ts to `<outDir>/server/index.js` (single file, node18, no sourcemap, not minified). */
export async function bundleBridge(outDir: string) {
  const file = join(outDir, 'server/index.js');
  const { metafile } = await build({
    entryPoints: [join(root, 'extension/src/proxy.ts')],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    sourcemap: false,
    minify: false,
    metafile: true,
    logLevel: 'silent',
  });
  return { file, metafile };
}

/** Writes dist/stralforsmcp.mcpb and returns its path. Fails if the manifest version differs from package.json. */
export async function buildMcpb(): Promise<string> {
  const manifest = readFileSync(join(root, 'extension/manifest.json'), 'utf8');
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  if ((JSON.parse(manifest) as { version: string }).version !== version) throw new Error(`extension/manifest.json version differs from package.json (${version})`);
  const stage = join(root, 'dist/stage');
  const { file } = await bundleBridge(stage);
  const mtime = new Date(Date.UTC(2020, 0, 1)); // fixed so identical inputs give identical archives
  const entries = {
    'README.md': readFileSync(join(root, 'extension/README.md')),
    'manifest.json': Buffer.from(manifest),
    'server/index.js': readFileSync(file),
  };
  const zip = zipSync(Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [new Uint8Array(v), { mtime }]])), { level: 9 });
  const out = join(root, 'dist/stralforsmcp.mcpb');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(out, zip);
  return out;
}

if (import.meta.main) console.log(await buildMcpb());
