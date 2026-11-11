import pkg from '../package.json' with { type: 'json' };

export const serverInfo = { name: pkg.name, version: pkg.version };
export { start } from './server/main.ts';
