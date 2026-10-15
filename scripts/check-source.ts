// Checks the two rules in CODING_STANDARDS.md that a pattern decides: a test
// reaches the package only through a pi SDK session (One seam), and a comment
// names no ticket (Lasting behavior and its reason). Runs in `npm run lint`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const problems: string[] = [];

for (const dir of ['src', 'test']) {
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts')) continue;
    const file = join(dir, name);
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        const at = `${file}:${index + 1}`;
        if (dir === 'test' && /['"]\.\.\/src\//.test(line)) problems.push(`${at}: a test imports src/ (One seam)`);
        const comment = line.match(/\/\/(.*)$/)?.[1];
        if (comment && /\bticket\b|#\d+/i.test(comment)) problems.push(`${at}: a comment names a ticket (Lasting behavior and its reason)`);
      });
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
