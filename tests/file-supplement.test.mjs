import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContext, buildNativeContext, editorContext, fileSupplement } from '../src/lib/context-format.mjs';
import { prepareAttachment } from '../plugins/stashdock/server/library.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/native-context-contract.json', import.meta.url)));
for (const fixture of fixtures) test(fixture.name, () => {
  assert.equal(buildNativeContext(fixture.items), fixture.expected);
  assert.equal(prepareAttachment(fixture.items, fixture.items.map(item => item.id), 'native').content[0].resource.text, fixture.expected);
});

test('file editor starts with annotations only; old generated preview saves do not become annotations', () => {
  const file = fixtures[0].items[0];
  assert.equal(editorContext(file), '');
  assert.equal(fileSupplement({...file, contextOverride: buildContext([file])}), '');
  assert.equal(editorContext({...file, contextOverride: 'Focus on errors.'}), 'Focus on errors.');
  const manual = fixtures[1].items[0];
  assert.equal(fileSupplement({...manual, contextOverride: buildContext([manual])}), manual.content);
});

test('ChatGPT keeps a file-reading entry without extracted body, default tags or MIME-size summaries', () => {
  const file = fixtures[0].items[0];
  const text = prepareAttachment([file], [file.id]).content[0].resource.text;
  assert.match(text, /get_stashdock_file/); assert.match(text, /report.csv/);
  assert.doesNotMatch(text, /Automatically extracted rows|Tags:|30 B|D:\/private/);
  const native = prepareAttachment([file], [file.id], 'native');
  assert.deepEqual(native.files, [file.id]); assert.equal(native.content[0].resource.text, '');
});
