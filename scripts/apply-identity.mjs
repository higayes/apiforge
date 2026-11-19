#!/usr/bin/env node
/**
 * Rewrite every project-identity reference in one pass.
 *
 * The repository ships with placeholder identities (a GitHub org that does not
 * exist and an email that is not verified). Rather than hand-editing fourteen
 * files — and risking a half-applied identity — this applies the real values
 * deterministically and then proves no stale reference survives.
 *
 * Usage:
 *   node scripts/apply-identity.mjs \
 *     --github-owner YOUR_USER --npm-name @YOUR_USER/apiforge-cli \
 *     --email you@example.com [--repo apiforge] [--dry-run]
 *
 * Nothing is guessed: every value must be supplied explicitly. The script
 * prints exactly which files it touched and fails if the result still contains
 * a stale reference.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const OLD_OWNER = 'apiforge';
const OLD_REPO = 'apiforge';
const OLD_PACKAGE = 'apiforge';
const OLD_EMAIL = 'maintainers@apiforge.dev';

function parseArgs(argv) {
  const out = { repo: 'apiforge', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const required = ['githubOwner', 'npmName', 'email'];
for (const key of required) {
  if (!args[key]) {
    console.error(`✖ Missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    console.error(
      '  Usage: node scripts/apply-identity.mjs --github-owner USER --npm-name NAME --email ADDR',
    );
    process.exit(2);
  }
}

const owner = args.githubOwner.replace(/^@/, '');
const repo = args.repo;
const npmName = args.npmName;
const email = args.email;

// --- sanity checks that need no network -------------------------------------
const problems = [];
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
  problems.push(`--github-owner "${owner}" is not a valid GitHub username`);
}
if (!/^[a-z0-9][a-z0-9._-]*$/.test(repo)) problems.push(`--repo "${repo}" is not a valid name`);
// npm rules: scoped names are @scope/name, unscoped must be lowercase, url-safe.
const scoped = npmName.startsWith('@');
const validName = scoped
  ? /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(npmName)
  : /^[a-z0-9][a-z0-9._-]*$/.test(npmName);
if (!validName) problems.push(`--npm-name "${npmName}" is not a valid npm package name`);
if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) === false) problems.push('--email is not an address');
if (problems.length > 0) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(2);
}

const newRepoUrl = `https://github.com/${owner}/${repo}`;
const newPackage = npmName;
const newEmail = email;

console.log(`Applying identity:`);
console.log(`  GitHub   ${OLD_OWNER}/${OLD_REPO}  →  ${owner}/${repo}`);
console.log(`  npm      ${OLD_PACKAGE}  →  ${newPackage}`);
console.log(`  email    ${OLD_EMAIL}  →  ${newEmail}`);
console.log(args.dryRun ? '  (dry run — nothing written)\n' : '\n');

// --- tracked files that carry an identity -----------------------------------
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

// Longest-first so `github.com/apiforge/apiforge` wins over bare `apiforge`.
const replacements = [
  ['https://github.com/apiforge/apiforge', newRepoUrl],
  ['github.com/apiforge/apiforge', `github.com/${owner}/${repo}`],
  [OLD_EMAIL, newEmail],
];

let touched = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable
  }
  const before = text;
  for (const [from, to] of replacements) text = text.split(from).join(to);

  // package.json needs the package name and, for a scope, public publish access.
  if (file.endsWith('package.json')) {
    const pkg = JSON.parse(text);
    const isCli = pkg.name === OLD_PACKAGE || pkg.bin?.apiforge !== undefined;
    if (isCli) {
      pkg.name = newPackage;
      if (scoped) pkg.publishConfig = { ...(pkg.publishConfig ?? {}), access: 'public' };
      pkg.repository = { type: 'git', url: `git+${newRepoUrl}.git` };
      pkg.homepage = `${newRepoUrl}#readme`;
      pkg.bugs = { url: `${newRepoUrl}/issues` };
      text = `${JSON.stringify(pkg, null, 2)}\n`;
    }
  }

  // The engines' user-agent and the HTML footer carry the repo URL.
  if (text !== before) {
    touched++;
    console.log(`  ${args.dryRun ? 'would update' : 'updated'}  ${file}`);
    if (!args.dryRun) writeFileSync(file, text, 'utf8');
  }
}

// --- pnpm filters -------------------------------------------------------
// `pnpm --filter <name>` stops matching once the package is renamed, which
// silently breaks `pnpm build` (the CLI never builds). Filter by directory
// instead — that stays correct no matter what the package is called.
if (!args.dryRun) {
  const filterTargets = [
    ['package.json', ['build', 'typecheck', 'pack:check']],
    ['.github/workflows/release.yml', null],
  ];
  for (const [file] of filterTargets) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const next = text
      .split('pnpm --filter apiforge run build')
      .join('pnpm --filter ./packages/cli run build')
      .split('pnpm --filter apiforge run typecheck')
      .join('pnpm --filter ./packages/cli run typecheck')
      .split('pnpm --filter apiforge exec npm pack')
      .join('pnpm --filter ./packages/cli exec npm pack')
      .split('pnpm --filter apiforge publish')
      .join('pnpm --filter ./packages/cli publish');
    if (next !== text) {
      writeFileSync(file, next, 'utf8');
      console.log(`  updated  ${file} (pnpm filter → path)`);
    }
  }
}

// --- README install commands ------------------------------------------------
// `npm install -g apiforge` must name the real package while the bin stays apiforge.
if (!args.dryRun) {
  for (const file of ['README.md', 'packages/cli/README.md']) {
    try {
      const text = readFileSync(file, 'utf8');
      const next = text
        .split('npm install -g apiforge')
        .join(`npm install -g ${newPackage}`)
        .split('`apiforge`') // prose that refers to the package, not the command
        .join(`\`${newPackage}\``);
      if (next !== text) console.log(`  updated  ${file} (install command)`);
      writeFileSync(file, next, 'utf8');
    } catch {
      /* file absent */
    }
  }
}

console.log(`\n${touched} file(s) ${args.dryRun ? 'matched' : 'updated'}.`);

if (args.dryRun) process.exit(0);

// --- prove it --------------------------------------------------------------
const stale = [];
for (const file of execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')) {
  if (!file || file === 'scripts/apply-identity.mjs') continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [from] of replacements) if (text.includes(from)) stale.push(`${file}: ${from}`);
}
if (stale.length > 0) {
  console.error('\n✖ Stale identity references remain:');
  for (const s of stale) console.error(`   ${s}`);
  process.exit(1);
}
// Rewritten lines can change wrapping, so normalise formatting the same way CI
// checks it. Without this, `pnpm verify` fails at format:check after a rewrite.
try {
  execFileSync('npx', ['prettier', '--write', '.'], { stdio: 'ignore' });
  console.log('✔ Formatting normalised (prettier --write).');
} catch {
  console.warn('⚠ Could not run prettier; run `pnpm format` before verifying.');
}

console.log('✔ No stale identity references remain.');
console.log(`\nNext:\n  git remote add origin ${newRepoUrl}.git`);
