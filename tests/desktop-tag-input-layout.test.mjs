import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('desktop screenshot tags are removed without changing stored tags or MCP presentation', async () => {
  const card = await readFile('src/components/StashCard.tsx', 'utf8');
  const css = await readFile('src/components/StashCard.module.css', 'utf8');
  assert.doesNotMatch(card, /Reference tags|previewTags|onFilterTag/);
  assert.doesNotMatch(css, /previewTags|previewTag/);
});

test('editor shares a collapsed, click-only existing-tag popover with import forms', async () => {
  const editor = await readFile('src/components/ReferenceEditor.tsx', 'utf8');
  const field = await readFile('src/components/ReferenceTagsField.tsx', 'utf8');
  assert.match(editor, /<ReferenceTagsField value=\{tags\} onValueChange=\{updateTags\}/);
  assert.match(await readFile('src/components/DesktopImportDialog.tsx', 'utf8'), /<ReferenceTagsField/);
  assert.match(field, /import \{ TagInput \}/);
  assert.match(field, /useState\(false\)/); assert.match(field, /<PopoverTrigger asChild>/);
  assert.match(field, /aria-label=\{t\("Existing tags"\)\}/);
  assert.match(field, /value.length >= 12/);
  assert.match(editor, /cleanReferenceTags/);
  assert.match(editor, /querySelector\('input'\)/);
  assert.doesNotMatch(editor, /DesktopTagPicker|Choose tags|No tags|Saved content stays unchanged/);
  assert.match(field, /description=\{t\("Press Enter to add a tag"\)\}/);
  assert.match(field, /event.key === ','/);
  assert.match(field, /availableTags.filter/); assert.doesNotMatch(field, /availableTags.filter\([^;]+!value/);
  assert.match(field, /<ScrollArea maxHeight=/); assert.doesNotMatch(field, /onFocus=/);
  assert.match(field, /collisionBoundary=\{host\}/); assert.match(field, /Portal container=\{host/);
  const css = await readFile('src/components/ReferenceTagsField.module.css', 'utf8');
  assert.match(css, /\.header \{ display: flex/);
  assert.doesNotMatch(css, /grid-area: 1 \/ 1|margin-block-start: calc\(-1/);
  assert.match(field, /label htmlFor=\{inputId\}>\{t\("Tags"\)\}/);
  assert.match(editor, /setSaved\(true\); onClose\(\)/);
});

test('card menu offers separate metadata and content editors only through its trigger', async () => {
  const card = await readFile('src/components/StashCard.tsx', 'utf8');
  const content = await readFile('src/components/ContentEditor.tsx', 'utf8');
  const tags = await readFile('src/components/TagEditor.tsx', 'utf8');
  assert.match(await readFile('src/components/referenceActions.tsx', 'utf8'), /label: 'Edit content'/); assert.match(card, /actions=\{menuActions\}/);
  assert.doesNotMatch(card, /<DesktopMenu context/);
  assert.match(content, /hasContextFile\(item\) \? 'Supplemental context \(optional\)' : 'Context content'/); assert.match(content, /onSave\(item.id, content\)/);
  assert.match(content, /size="wide"/); assert.match(content, /setSaved\(true\); onClose\(\)/);
  assert.match(tags, /setSaved\(true\); onClose\(\)/);
});

test('sidebar has one fading scroll owner beneath static collection controls', async () => {
  const sidebar = await readFile('src/components/Sidebar.tsx', 'utf8');
  const css = await readFile('src/components/Sidebar.module.css', 'utf8');
  assert.equal((sidebar.match(/<ScrollArea/g) || []).length, 1);
  assert.match(sidebar, /<ScrollArea[^>]+label=\{t\("Tag filters"\)\} fade=\{24\}/);
  assert.ok(sidebar.indexOf('className={styles.tagHeading}') < sidebar.indexOf('<ScrollArea'));
  assert.ok(sidebar.indexOf('<NavigationGroup label={t("Collections")}') < sidebar.indexOf('<ScrollArea'));
  assert.equal((sidebar.match(/<span className=\{styles.rowContent\}><motion.span/g) || []).length, 1);
  assert.doesNotMatch(css, /tagScroll|max-height: min\(320px/);
  const toolbar = await readFile('src/components/Toolbar.module.css', 'utf8');
  assert.match(toolbar, /background: var\(--surface\)/);
});
