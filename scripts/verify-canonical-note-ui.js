// Actual MCP panel, isolated library and current text-native Note contract.
async page => {
  const errors = [], reports = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = new URL(page.url()).origin;
  const call = async (name, args) => {
    const response = await page.request.post(base + '/tool', { data: { name, arguments: args } });
    const result = await response.json();
    if (!response.ok() || result.isError) throw Error(JSON.stringify(result));
    return result;
  };
  const existing = (await call('list_stashdock_shelf', { query: 'Text note' }))._meta.items;
  for (const item of existing.filter(item => /^Text note (light|dark)$/.test(item.title))) {
    await call('delete_stashdock_reference', { id: item.id });
  }
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: theme === 'dark' ? 390 : 768, height: 900 });
    await page.goto(base + '/?theme=' + theme);
    const frame = page.frameLocator('iframe'), title = 'Text note ' + theme;
    const body = '  Saved note body\n\nOriginal formatting  \n';
    await frame.getByRole('button', { name: 'Import references', exact: true }).click();
    await frame.getByRole('tab', { name: 'Note', exact: true }).click();
    await frame.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await frame.getByRole('textbox', { name: 'Content', exact: true }).fill(body);
    await frame.getByRole('button', { name: 'Save note', exact: true }).click();
    await frame.getByRole('dialog', { name: 'Import references', exact: true }).waitFor({ state: 'hidden' });
    const card = frame.locator('article').filter({ hasText: title });
    await card.waitFor();
    if (await card.getByRole('button', { name: 'Open ' + title, exact: true }).count()) throw Error('Note still presents a file-opening action');
    const rows = (await call('list_stashdock_shelf', { query: title }))._meta.items;
    const item = rows.find(item => item.title === title);
    if (!item || item.hasFile) throw Error('Note is missing or classified as a file');
    const id = item.id;
    await card.getByRole('button', { name: 'Edit ' + title, exact: true }).click();
    await frame.getByRole('menuitem', { name: 'Edit content', exact: true }).click();
    const editor = frame.getByLabel('Context content', { exact: true });
    if (!(await editor.inputValue()).includes(body)) throw Error('Saved text lost formatting');
    const final = 'Final edited context.\nUse it directly in this conversation.';
    await editor.fill(final);
    await frame.getByRole('button', { name: 'Save changes', exact: true }).click();
    await frame.getByRole('dialog', { name: 'Edit content', exact: true, includeHidden: true }).waitFor({ state: 'detached' });
    const prepared = await call('prepare_stashdock_attachment', { ids: [id] });
    if (prepared._meta.attachment.content[0].resource.text !== final) throw Error('Final context was not preserved');
    const after = (await call('get_stashdock_context', { id }))._meta.item;
    if (after.content !== body || after.assetPath) throw Error('Stored note body or type changed');
    await card.hover();
    await card.getByRole('button', { name: 'Add ' + title + ' to chat', exact: true }).click();
    await page.waitForFunction(text => window.testRequests?.at(-1)?.params.content[0].text === text, final);
    if (await page.getByRole('textbox', { name: 'Test draft', exact: true }).inputValue() !== 'Keep this draft unchanged.') throw Error('Existing draft changed');
    await page.screenshot({ path: 'output/playwright/text-note-' + theme + '.png' });
    reports.push({ theme, textNote: true, fullBody: true, editorFinalContext: true, textDraftReceived: true });
  }
  if (errors.length) throw Error(errors.join('\n'));
  return reports;
}
