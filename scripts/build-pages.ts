#!/usr/bin/env tsx
/**
 * Writes the standalone control panel for GitHub Pages into `dist-pages/`.
 *
 * The page is the same one the control server serves, built in its
 * "not same origin" mode: it asks for the bot's address, remembers it in the
 * browser, and authenticates with a bearer token instead of a cookie.
 *
 *   npm run build:pages
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FAVICON_SVG, renderControlPage } from '../src/control/ui';

export function buildPages(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const files: [string, string][] = [
    ['index.html', renderControlPage({ sameOrigin: false })],
    ['favicon.svg', FAVICON_SVG],
    // Tell Pages to serve the files as-is rather than running Jekyll over them.
    ['.nojekyll', ''],
    // A refresh on a deep link should still land on the panel.
    ['404.html', renderControlPage({ sameOrigin: false })],
  ];
  for (const [name, content] of files) writeFileSync(join(outDir, name), content);
  return files.map(([name]) => name);
}

if (require.main === module) {
  const outDir = resolve(process.argv[2] ?? 'dist-pages');
  const written = buildPages(outDir);
  console.log(`Wrote ${written.join(', ')} to ${outDir}`);
}
