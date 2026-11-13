import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext } from '../src/lib/context-format.mjs';
import { prepareAttachment } from '../plugins/stashdock/server/library.mjs';
import { readFileSync } from 'node:fs';
const item = { id: 'a', title: 'CS 168 Spring 2026 | Intro to the Internet at UC Berkeley', source: 'sp26.cs168.io', url: 'https://sp26.cs168.io/?', tags: [], content: 'Intro to the Internet at UC Berkeley', origin: { platform: 'sp26.cs168.io' } };
test('editor context is the exact source-qualified final AI payload', () => {
  const expected = '# StashDock context\n\n## CS 168 Spring 2026 | Intro to the Internet at UC Berkeley\nURL: https://sp26.cs168.io/?\n\n### Saved content\nIntro to the Internet at UC Berkeley';
  assert.equal(buildContext([item]), expected);
  assert.equal(prepareAttachment([item], ['a']).content[0].resource.text, expected);
});
test('manual context remains verbatim without truncation, trimming or double wrapping', () => {
  for (const contextOverride of ['', '  Custom context\n\n', '# StashDock context\n\n## Curated\n' + '😀'.repeat(25_000)]) {
    const edited = { ...item, contextOverride };
    assert.equal(buildContext([edited]), contextOverride);
    assert.equal(prepareAttachment([edited], ['a']).content[0].resource.text, contextOverride);
  }
});
test('batch preserves selected order with one standard outer heading', () => {
  const a = { ...item, contextOverride: '# StashDock context\n\n## Edited\nFinal A' };
  const b = { ...item, id: 'b', title: 'Second', contextOverride: 'Final B' };
  const expected = '# StashDock context\n\nFinal B\n\n---\n\n## Edited\nFinal A';
  assert.equal(buildContext([b, a]), expected);
  assert.equal(prepareAttachment([a, b], ['b', 'a']).content[0].resource.text, expected);
});

test('AI-generated provenance and source URLs survive editor/MCP context without altering final overrides', () => {
  const note = { id: 'ai-context', title: 'Review checklist', kind: 'note', source: 'AI conversation', content: 'Check keyboard behavior.', tags: ['Design'],
    origin: { platform: 'AI conversation', importMethod: 'ai_context', contentOrigin: 'generated', sourceUrls: ['https://example.org/guide'] } };
  const expected = '# StashDock context\n\n## Review checklist\nContent origin: AI-generated\nSources: https://example.org/guide\nTags: Design\n\n### Note text\nCheck keyboard behavior.';
  assert.equal(buildContext([note]), expected);
  assert.equal(prepareAttachment([note], ['ai-context']).content[0].resource.text, expected);
  assert.equal(buildContext([{ ...note, contextOverride: '  User\'s final context\n' }]), '  User\'s final context\n');
});

for (const fixture of JSON.parse(readFileSync(new URL('./fixtures/context-contract.json', import.meta.url)))) {
  test(`shared native/JS context contract: ${fixture.name}`, () => {
    assert.equal(buildContext(fixture.items), fixture.expected);
  });
}

test('export truncation is explicit, Unicode-safe and separate from capture incompleteness', () => {
  const text = buildContext([{ ...item, content: '😀'.repeat(20_001), origin: { truncated: true } }]);
  assert.equal((text.match(/😀/gu) || []).length, 20_000);
  assert.match(text, /saved source content is incomplete/);
  assert.match(text, /exported text was truncated to 20,000 characters/);
  assert.doesNotMatch(buildContext([{ ...item, content: '😀'.repeat(20_000) }]), /truncated/);
});

test('file delivery instructions survive empty overrides and never leak managed paths', () => {
  const file = { ...item, kind: 'file', hasFile: true, assetPath: 'C:/private/assets/report.xlsx', origin: { fileName: 'C:\\private\\report.xlsx' }, contextOverride: '' };
  const result = prepareAttachment([file], ['a']).content[0].resource.text;
  assert.match(result, /get_stashdock_file/);
  assert.match(result, /^- report\.xlsx · ID a$/m);
  assert.doesNotMatch(result, /C:[/\\]|private/);
  assert.equal(buildContext([file]), '');
});
