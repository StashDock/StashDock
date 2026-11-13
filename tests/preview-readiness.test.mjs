import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const probe = readFileSync('src-tauri/src/preview_ready.js', 'utf8');
function fixture(html = '<main>Ready content</main>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.org/' });
  const { document } = dom.window;
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => document.body.textContent });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } });
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 300, width: 600, height: 300 };
  for (const node of document.querySelectorAll('*')) node.getBoundingClientRect = () => rect;
  document.elementFromPoint = () => document.querySelector('main') || document.body;
  return { document, read: () => dom.window.eval(probe), close: () => dom.window.close() };
}
test('viewport readiness rejects blank/loading documents and waits for visible images, fonts and busy content', () => {
  const page = fixture('<main>Article<img src="hero.jpg"><div aria-busy="true">Loading</div></main>');
  try {
    const image=page.document.querySelector('img');
    Object.defineProperty(image,'complete',{configurable:true,value:false});
    assert.equal(page.read().ready,false);
    assert.equal(page.read().drawable,true,'Slow subresources do not make the existing page blank');
    Object.defineProperty(image,'complete',{configurable:true,value:true});
    assert.equal(page.read().ready,false);
    page.document.querySelector('[aria-busy]').removeAttribute('aria-busy');
    assert.equal(page.read().ready,true);
    page.document.fonts.status='loading'; assert.equal(page.read().ready,false);
    page.document.fonts.status='loaded';
    Object.defineProperty(page.document,'readyState',{value:'loading'}); assert.equal(page.read().ready,false);
  } finally { page.close(); }
  const blank=fixture(''); try { assert.equal(blank.read().ready,false); assert.equal(blank.read().drawable,false); } finally { blank.close(); }
});
test('readiness signatures track late body/layout/image changes but ignore offscreen loading images', () => {
  const page=fixture('<main>First body</main><img src="below.jpg">');
  try {
    const image=page.document.querySelector('img');
    image.getBoundingClientRect=()=>({x:0,y:2000,top:2000,left:0,right:100,bottom:2100,width:100,height:100});
    Object.defineProperty(image,'complete',{value:false});
    const first=page.read(); assert.equal(first.ready,true);
    page.document.querySelector('main').textContent='Full body after hydration';
    const next=page.read(); assert.notEqual(next.signature,first.signature);
    page.document.querySelector('main').getBoundingClientRect=()=>({x:0,y:0,width:900,height:600});
    assert.notEqual(page.read().signature,next.signature);
    assert.equal(page.document.querySelector('img').getAttribute('src'),'below.jpg','Probe must not mutate the page');
  } finally { page.close(); }
});

test('parser-blocking scripts do not hide a painted page from the bounded capture fallback', () => {
  const page = fixture('<main><h1>Benefits of Community Service</h1><p>Painted article text remains useful while a third-party script stalls.</p></main>');
  try {
    Object.defineProperty(page.document, 'readyState', { value: 'loading' });
    const scene = page.read();
    assert.equal(scene.ready, false, 'Do not claim that all resources are ready');
    assert.equal(scene.drawable, true, 'The existing article is not a blank page');
    assert.equal(typeof scene.signature, 'number');
  } finally { page.close(); }
  const blank = fixture('');
  try {
    Object.defineProperty(blank.document, 'readyState', { value: 'loading' });
    assert.equal(blank.read().drawable, false, 'Loading alone never permits a blank capture');
  } finally { blank.close(); }
});

test('Mac paint readiness distinguishes text hidden by an entrance effect from visible text', () => {
  const page = fixture('<main style="opacity:0"><h1>Article waiting for an entrance effect</h1></main>');
  try {
    const hidden = page.read();
    assert.equal(hidden.drawable, true, 'DOM text alone can be available before it paints');
    assert.equal(hidden.painted, false);
    page.document.querySelector('main').style.opacity = '1';
    const shown = page.read();
    assert.equal(shown.painted, true);
    assert.notEqual(shown.paintSignature, hidden.paintSignature);
    assert.equal(shown.signature, hidden.signature, 'The existing Windows layout signature stays unchanged');
  } finally { page.close(); }
});

test('Mac paint readiness ignores script source and tracks CSS-only changes', () => {
  const script = fixture('<script>document.write("not rendered text")</script>');
  try { assert.equal(script.read().painted, false); } finally { script.close(); }
  const page = fixture('<main>Visible article</main>');
  try {
    const before = page.read();
    page.document.querySelector('main').style.backgroundColor = 'rgb(33, 113, 191)';
    const after = page.read();
    assert.equal(after.painted, true);
    assert.notEqual(after.paintSignature, before.paintSignature);
    assert.equal(after.signature, before.signature);
  } finally { page.close(); }
});

test('Mac quality waits for the main content instead of accepting navigation alone', () => {
  const page = fixture('<nav>Navigation is already visible</nav><main style="opacity:0"><h1>Article arrives later</h1></main>');
  try {
    assert.equal(page.read().subject, false);
    page.document.querySelector('main').style.opacity = '1';
    assert.equal(page.read().subject, true);
  } finally { page.close(); }
  const small = fixture('<main>Hello</main>');
  try { assert.equal(small.read().subject, true, 'Short but complete pages remain valid'); } finally { small.close(); }
  const navigation = fixture('<nav>' + '<a>Navigation link</a>'.repeat(300) + '</nav><main>Visible documentation article</main>');
  try { assert.equal(navigation.read().subject, true, 'A large navigation must not exhaust the article sampling budget'); } finally { navigation.close(); }
  const contents = fixture('<nav>' + '<a>Navigation link</a>'.repeat(300) + '</nav><main style="display:contents"><p>The main wrapper has no box but its article is visible</p></main>');
  try {
    contents.document.querySelector('main').getBoundingClientRect = () => ({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0});
    contents.document.elementFromPoint = () => contents.document.querySelector('p');
    assert.equal(contents.read().subject, true, 'display:contents must not erase a visible main region');
  } finally { contents.close(); }
});

test('a frontmost full-screen loading layer blocks the article until the website removes it', () => {
  const page = fixture('<main><h1>Complete article</h1><p>The meaningful article behind the loading layer contains enough readable material to be a useful reference after loading completes.</p></main><div id="cover" style="position:fixed;z-index:100">Loading</div>');
  try {
    const cover = page.document.querySelector('#cover');
    cover.getBoundingClientRect = () => ({x:0,y:0,left:0,top:0,right:1024,bottom:768,width:1024,height:768});
    page.document.elementFromPoint = () => cover;
    assert.equal(page.read().blocked, true);
    assert.equal(page.read().subject, false);
    assert.ok(cover.isConnected, 'The probe must not remove or dismiss a loading layer');
    cover.remove();
    page.document.elementFromPoint = () => page.document.querySelector('main');
    assert.equal(page.read().blocked, false);
    assert.equal(page.read().subject, true);
  } finally { page.close(); }
});

test('a complete fixed main view is useful, and a small error page is not reference content', () => {
  const fixed = fixture('<main style="position:fixed;z-index:100">Complete application content</main>');
  try {
    fixed.document.querySelector('main').getBoundingClientRect = () => ({x:0,y:0,left:0,top:0,right:1024,bottom:768,width:1024,height:768});
    assert.equal(fixed.read().blocked, false);
    assert.equal(fixed.read().subject, true);
  } finally { fixed.close(); }
  const error = fixture('<main>500.\nSomething went wrong on our end.</main>');
  try { assert.equal(error.read().errorPage, true); } finally { error.close(); }
  const article = fixture('<article>500.\nSomething went wrong is an example used in this article about HTTP responses.</article>');
  try { assert.equal(article.read().errorPage, false); } finally { article.close(); }
});
