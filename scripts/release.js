// Releases a new version: development gets the version commit and tag, CI runs
// on it, and main is fast-forwarded to that exact commit once CI passes.
// Finally it prints a link to GitHub's new release page, prefilled from the commits.
//
//   npm run release -- patch|minor|major ["Title"] [--dry-run]
//
// The optional title goes into the version commit, the tag and the release
// ("1.0.0 · Media Downloader"); it is asked for when not given.
//
// Set GITHUB_TOKEN to raise the GitHub API rate limit while waiting for CI.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { draftReleaseNotes, newReleaseUrl, versionMessage } from './lib/releaseNotes.js';

const DEVELOP = 'development';
const MAIN = 'main';
const CI_POLL_MS = 20_000;
const CI_TIMEOUT_MS = 20 * 60_000;

const [bump, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
let title = rest
  .filter((arg) => !arg.startsWith('--'))
  .join(' ')
  .trim();

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

if (!['patch', 'minor', 'major'].includes(bump)) {
  fail('Usage: npm run release -- patch|minor|major ["Title"] [--dry-run]');
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const step = (title) => console.log(`\n→ ${title}`);

/** Like `git`, but returns null instead of throwing (e.g. no tags or no upstream yet). */
const tryGit = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/** Runs a command that changes something; only printed in a dry run. */
const run = (command) => {
  console.log(`  $ ${command}`);
  if (!dryRun) execSync(command, { stdio: 'inherit' });
};

/** Runs git without a shell, so messages need no quoting; only printed in a dry run. */
const runGit = (...args) => {
  console.log(`  $ git ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  if (!dryRun) execFileSync('git', args, { stdio: 'inherit' });
};

/** Runs a read-only check, also in a dry run. */
const check = (command) => {
  console.log(`  $ ${command}`);
  execSync(command, { stdio: 'inherit' });
};

const nextVersion = (version, part) => {
  const [major, minor, patch] = version.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const githubRepo = () => {
  const url = git('remote', 'get-url', 'origin');
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) fail(`origin is not a GitHub repository: ${url}`);
  return `${match[1]}/${match[2]}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the CI run of the pushed commit; resolves to the finished run, or
 * to null when it does not finish in time. A re-run on GitHub reuses the same
 * run, so calling this again after one picks up the new attempt.
 */
const waitForCi = async (repo, sha) => {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&event=push&branch=${DEVELOP}`;
  const deadline = Date.now() + CI_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let status = 'GitHub did not answer, trying again';
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        const [ciRun] = (await response.json()).workflow_runs ?? [];
        if (ciRun?.status === 'completed') return ciRun;
        status = ciRun ? ciRun.status : 'waiting for the run to start';
      } else {
        status = `GitHub API returned ${response.status}, trying again`;
      }
    } catch {
      // A network hiccup while polling is not a failed release.
    }
    process.stdout.write(`  ${status}…          \r`);
    await sleep(CI_POLL_MS);
  }
  return null;
};

/** What is left to do by hand once the version is tagged but main was not updated. */
const finishByHand = (version) =>
  [
    `v${version} is already committed, tagged and pushed to ${DEVELOP}; ${MAIN} was not touched.`,
    '  Do NOT run the release again: that would create another version.',
    '',
    '  If CI failed because of the code: fix it and release a patch.',
    '  If it was a one-off and CI passes after a re-run, finish this release with:',
    `    git switch ${MAIN} && git pull --ff-only && git merge --ff-only ${DEVELOP} && git push && git switch ${DEVELOP}`,
    '  and then publish its GitHub release.',
  ].join('\n');

// 1. Preconditions
step('Checking the repository');
if (git('branch', '--show-current') !== DEVELOP) fail(`Switch to ${DEVELOP} first.`);
if (git('status', '--porcelain')) fail('Commit or stash your changes first.');
if (!tryGit('rev-parse', '--abbrev-ref', '@{upstream}')) {
  fail(`${DEVELOP} is not on GitHub yet. Push it once with: git push -u origin ${DEVELOP}`);
}
const repo = githubRepo();

run('git pull --ff-only');
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const version = nextVersion(current, bump);

// 2. Local checks, so a broken build never gets a tag
step('Running lint and tests');
check('npm run lint');
check('npm test');

// 3. Confirm
const rl = createInterface({ input: process.stdin, output: process.stdout });
if (!title) title = (await rl.question('\nRelease title (optional, e.g. Media Downloader): ')).trim();
const message = versionMessage(version, title);
const answer = await rl.question(
  `\nRelease "v${message}" (from v${current}) to ${MAIN}${dryRun ? ' [dry run]' : ''}? [y/N] `,
);
rl.close();
if (answer.trim().toLowerCase() !== 'y') fail('Cancelled.');

// 4. Version commit and tag on development, with the title in both.
// The first release has no previous tag, so its notes cover the whole history.
const previousTag = tryGit('describe', '--tags', '--abbrev=0');
const range = previousTag ? [`${previousTag}..HEAD`] : ['HEAD'];
const commits = git('log', ...range, '--format=%s').split('\n').filter(Boolean);

step(`Creating v${version}`);
run(`npm version ${bump} --no-git-tag-version`);
runGit('add', 'package.json', 'package-lock.json');
runGit('commit', '-m', message);
runGit('tag', '-a', `v${version}`, '-m', message);
run('git push --follow-tags');

// 5. Wait for CI on that commit
step('Waiting for CI');
if (dryRun) {
  console.log('  (dry run: skipped)');
} else {
  const sha = git('rev-parse', 'HEAD');
  // CI can fail for reasons that have nothing to do with the code (a download
  // error while installing, an outage): those are re-run on GitHub and checked
  // again here, instead of leaving a tagged version that never reached main.
  for (;;) {
    const ciRun = await waitForCi(repo, sha);
    if (ciRun?.conclusion === 'success') {
      console.log(`  ✓ CI passed: ${ciRun.html_url}`);
      break;
    }
    console.log(ciRun ? `\n  ✗ CI ${ciRun.conclusion}: ${ciRun.html_url}` : '\n  ✗ CI did not finish in time. Check GitHub Actions.');
    const retry = createInterface({ input: process.stdin, output: process.stdout });
    const reply = await retry.question(
      '  If it was a one-off, re-run the failed job on GitHub, then press Enter to check again.\n  Type q to stop here: ',
    );
    retry.close();
    if (reply.trim().toLowerCase() === 'q') fail(finishByHand(version));
    // GitHub takes a moment to show a re-run as running again.
    await sleep(CI_POLL_MS);
  }
}

// 6. Fast-forward main to the released commit, then come back
step(`Updating ${MAIN}`);
try {
  run(`git switch ${MAIN}`);
  run('git pull --ff-only');
  run(`git merge --ff-only ${DEVELOP}`);
  run('git push');
} finally {
  run(`git switch ${DEVELOP}`);
}

// 7. GitHub release: prefilled here, reviewed and published by hand
step('GitHub release');
const releaseUrl = newReleaseUrl(repo, { tag: `v${version}`, title: `v${message}`, body: draftReleaseNotes(commits) });
console.log(`  Open this link (Ctrl+click), review the notes and publish:\n  ${releaseUrl}`);

console.log(`\n✓ Released v${version}${dryRun ? ' (dry run, nothing changed)' : ''}`);
