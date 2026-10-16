// Helpers for scripts/release.js: the version commit and tag message, and a
// first draft of the GitHub release, prefilled from the commits it contains.

const SECTIONS = [
  { type: 'feat', title: 'New' },
  { type: 'fix', title: 'Fixed' },
  { type: 'perf', title: 'Improved' },
];

/** "1.0.0 · Media Downloader", or just "1.0.0" without a title. */
export const versionMessage = (version, title) => (title ? `${version} · ${title}` : version);

/**
 * Release notes draft from conventional commit subjects: features, fixes and
 * performance work, in the order they were made. Docs, CI, chores and
 * version commits are left out.
 */
export const draftReleaseNotes = (subjects) => {
  const groups = new Map(SECTIONS.map(({ type }) => [type, []]));
  for (const subject of subjects) {
    const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    if (!match || !groups.has(match[1])) continue;
    const text = match[2].trim();
    groups.get(match[1]).push(text.charAt(0).toUpperCase() + text.slice(1));
  }
  return SECTIONS.filter(({ type }) => groups.get(type).length > 0)
    .map(({ type, title }) => [`## ${title}`, ...groups.get(type).map((item) => `- ${item}`)].join('\n'))
    .join('\n\n');
};

/** GitHub's "new release" page with the tag, title and notes filled in. */
export const newReleaseUrl = (repo, { tag, title, body }) => {
  const params = new URLSearchParams({ tag, title });
  if (body) params.set('body', body);
  return `https://github.com/${repo}/releases/new?${params}`;
};
