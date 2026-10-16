import { describe, expect, it } from 'vitest';
import { draftReleaseNotes, newReleaseUrl, versionMessage } from './releaseNotes.js';

describe('versionMessage', () => {
  it('adds the title after the version', () => {
    expect(versionMessage('1.0.0', 'Media Downloader')).toBe('1.0.0 · Media Downloader');
    expect(versionMessage('1.0.0', '')).toBe('1.0.0');
  });
});

describe('draftReleaseNotes', () => {
  it('groups features, fixes and performance work and skips the rest', () => {
    const notes = draftReleaseNotes([
      'feat(downloader): add media downloader as the first tool',
      'docs: describe the toolbox',
      'fix(downloader): keep the chosen quality on retries',
      '0.9.0 · Preview',
      'feat!: add a tool menu',
      'perf: reuse the yt-dlp process',
      'ci: run lint and tests',
      "Merge branch 'development'",
    ]);
    expect(notes).toBe(
      [
        '## New',
        '- Add media downloader as the first tool',
        '- Add a tool menu',
        '',
        '## Fixed',
        '- Keep the chosen quality on retries',
        '',
        '## Improved',
        '- Reuse the yt-dlp process',
      ].join('\n'),
    );
  });

  it('is empty when there is nothing for users', () => {
    expect(draftReleaseNotes(['docs: readme', 'chore: deps'])).toBe('');
  });
});

describe('newReleaseUrl', () => {
  it('prefills the tag, title and notes', () => {
    const url = new URL(
      newReleaseUrl('umbra-code/umbra-tools', { tag: 'v1.0.0', title: 'v1.0.0 · Media Downloader', body: '## New' }),
    );
    expect(url.pathname).toBe('/umbra-code/umbra-tools/releases/new');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tag: 'v1.0.0',
      title: 'v1.0.0 · Media Downloader',
      body: '## New',
    });
  });
});
