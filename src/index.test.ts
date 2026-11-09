import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serverInfo } from './index.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('serverInfo', () => {
  it('has the server name and the package.json version', () => {
    expect(serverInfo).toEqual({ name: 'stralforsmcp', version: pkg.version });
  });
});
