import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import JSZip from 'jszip';
import { buildArchiveTree } from '../src/archive-tree.ts';

const tree = entries => buildArchiveTree({ entries, truncated: false });
test('infers parent folders and sorts siblings rather than full paths', () => {
  const entries = [
    { name: 'root.txt', dir: false },
    { name: 'icons/icon10.png', dir: false },
    { name: '_locales/en/messages.json', dir: false, uncompressedSize: 42 },
    { name: '_locales/How-to.txt', dir: false },
    { name: 'icons/icon2.png', dir: false },
  ];
  const before = structuredClone(entries);
  const { rows } = tree(entries);
  assert.deepEqual(rows.map(r => [r.path, r.depth]), [
    ['_locales', 0], ['_locales/en', 1], ['_locales/en/messages.json', 2],
    ['_locales/How-to.txt', 1], ['icons', 0], ['icons/icon2.png', 1],
    ['icons/icon10.png', 1], ['root.txt', 0],
  ]);
  assert.equal(rows[2].parent, 1);
  assert.equal(rows[2].entry.uncompressedSize, 42);
  assert.deepEqual(entries, before, 'must not reorder or mutate reader data');
});

test('explicit folders merge with inferred parents; empty folders and file duplicates survive', () => {
  const entries = [
    { name: 'a/b.txt', dir: false }, { name: 'a/', dir: true, dateParts: [2026, 9, 10, 1, 2, 3] },
    { name: 'empty/', dir: true }, { name: 'a/b.txt', dir: false },
    { name: 'A/c.txt', dir: false }, { name: 'a', dir: false },
  ];
  const { rows } = tree(entries);
  assert.equal(rows.filter(r => r.path === 'a' && r.entry.dir).length, 1);
  assert.deepEqual(rows.find(r => r.path === 'a').entry.dateParts, entries[1].dateParts);
  assert.equal(rows.filter(r => r.entry.dir).length, 3);
  assert.equal(rows.filter(r => r.path === 'a/b.txt').length, 2);
  assert.equal(rows.filter(r => r.path === 'a' && !r.entry.dir).length, 1);
});

test('handles backslashes and dot prefixes without resolving traversal paths', () => {
  const { rows } = tree([{ name: './folder\\child.txt', dir: false }, { name: '../outside.txt', dir: false }]);
  assert.ok(rows.some(r => r.path === 'folder/child.txt' && r.depth === 1));
  assert.ok(rows.some(r => r.path === '../outside.txt' && r.depth === 1));
});

test('inferred nodes and path depth are bounded; truncation is reported', () => {
  const result = buildArchiveTree({ entries: [{ name: 'a/b/c/d/e.txt', dir: false }], truncated: false }, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(tree([{ name: 'a/'.repeat(10000) + 'file', dir: false }]).truncated, true);
  assert.deepEqual(buildArchiveTree({ entries: [], truncated: true }), { rows: [], truncated: true });
});

const sample = new URL('../testfiles/SmartProxy-v1.7-Firefox.zip', import.meta.url);
test('SmartProxy: all 113 files have real parent rows even with zero folder records', { skip: !existsSync(sample) }, async () => {
  const zip = await JSZip.loadAsync(readFileSync(sample), { createFolders: false });
  const entries = Object.values(zip.files).map(e => ({ name: e.name, dir: e.dir }));
  assert.equal(entries.length, 113);
  assert.equal(entries.filter(e => e.dir).length, 0);
  const { rows, truncated } = tree(entries);
  assert.equal(truncated, false);
  assert.equal(rows.filter(r => !r.entry.dir).length, 113);
  for (const row of rows) {
    if (row.depth > 0) {
      assert.equal(rows[row.parent].entry.dir, true);
      assert.equal(row.path.slice(0, row.path.lastIndexOf('/')), rows[row.parent].path);
    }
  }
  console.log(`SmartProxy: 113 files, ${rows.filter(r => r.entry.dir).length} inferred folders`);
});
