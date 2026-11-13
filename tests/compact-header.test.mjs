import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('context modes use the shared labelled segmented control without a tooltip', async () => {
  const editor = await readFile('src/components/ContentEditor.tsx', 'utf8');
  assert.match(editor, /<SegmentedControl label=\{t\('Content view'\)\}/);
  assert.match(editor, /value: 'content', label: t\('Content'\)/);
  assert.match(editor, /value: 'preview', label: t\('Preview'\)/);
  assert.doesNotMatch(editor, /data-tooltip|Preview Markdown|Edit Markdown/);
  assert.match(editor, /inert=\{busy\}/);
  assert.match(editor, /labelAction=/);
  assert.match(editor, /label=\{t\('Content view'\)\} size="sm"/);
  assert.doesNotMatch(editor, /SquarePen|Eye|previewToggle|previewLabel/);
  const field = await readFile('src/components/arc/textarea/textarea.tsx', 'utf8');
  assert.match(field, /className=\{styles.heading\}/);
  assert.match(field, /<label htmlFor=\{controlId\}>\{label\}<\/label>\{labelAction\}/);
  const dialog = await readFile('src/components/FluidDialog.tsx', 'utf8');
  assert.match(dialog, /<motion.section layoutRoot/);
});

test('narrow desktop keeps search and view together, filters and tag actions together', async () => {
  const css = await readFile('src/components/Toolbar.module.css', 'utf8');
  assert.match(css, /"search views views" "filters tags sort"/);
  const toolbar = await readFile('src/components/Toolbar.tsx', 'utf8');
  assert.match(toolbar, /onClick=\{onSettings\}/);
  assert.doesNotMatch(toolbar, /handleTitlebarDrag|window-titlebar/);
  const shell = await readFile('src/features/library/LibraryView.tsx', 'utf8');
  assert.match(shell, /onSettings=\{openSettings\}/);
  assert.doesNotMatch(shell, /styles.compactSettings/);
});
