// Runs every suite, or only the files named after `npm test --`, with the
// runner's options fixed in one place.
import { spawnSync } from 'node:child_process';

const files = process.argv.slice(2);
const { status } = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-force-exit', '--test-reporter=spec', ...(files.length ? files : ['test/*.test.ts'])],
  { stdio: 'inherit' },
);
process.exit(status ?? 1);
