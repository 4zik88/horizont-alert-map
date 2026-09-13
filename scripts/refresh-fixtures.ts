/**
 * Re-downloads the test fixtures. Run this when a parsePage test starts failing so you
 * can diff the old and new markup in one command and see exactly what Telegram changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchChannelPage } from '../src/telegram/fetchPage.js';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures');

const FIXTURES: { file: string; channel: string; before?: number }[] = [
  { file: 'kpszsu.html', channel: 'kpszsu' },
  { file: 'kozakchornobay.html', channel: 'KozakChornobay' },
  { file: 'sectorv666.html', channel: 'sectorv666' },
];

async function main(): Promise<void> {
  for (const fixture of FIXTURES) {
    const html = await fetchChannelPage(
      fixture.channel,
      fixture.before === undefined ? {} : { before: fixture.before },
      15_000,
    );
    writeFileSync(join(DIR, fixture.file), html, 'utf8');
    console.log(`wrote ${fixture.file} (${html.length} bytes)`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log('\nFixture assertions in test/parsePage.test.ts reference specific message');
  console.log('ids and text — update them alongside the fixtures.');
}

void main();
