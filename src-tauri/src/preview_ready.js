// Public-preview viewport probe. Bounded sampling, no DOM mutation, no page text
// crosses the renderer boundary. Native code owns polling, stability and timeout.
(() => {
  const body = document.body;
  if (!body) return { ready: false };
  const width = innerWidth, height = innerHeight;
  const visible = node => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < height && r.left < width;
  };
  const images = Array.from(document.images).slice(0, 256).filter(visible);
  const pending = images.some(image => !image.complete);
  const busy = Array.from(document.querySelectorAll('[aria-busy="true"]')).slice(0, 64).some(visible);
  const text = (body.innerText || '').trim().slice(0, 16000);
  const media = images.some(image => image.complete && image.naturalWidth > 0)
    || Array.from(document.querySelectorAll('canvas,svg,video')).slice(0, 64).some(visible);
  let signature = 2166136261;
  const hash = value => { for (let i = 0; i < value.length; i++) signature = Math.imul(signature ^ value.charCodeAt(i), 16777619); };
  hash(text);
  // Viewport hit-testing catches late layout/hero changes without walking the
  // entire DOM, and ignores offscreen carousels/analytics/long-lived requests.
  for (let y = 80; y < height; y += 160) for (let x = 80; x < width; x += 240) {
    const node = document.elementFromPoint(x, y);
    if (!node) continue;
    const r = node.getBoundingClientRect();
    hash(`${node.tagName}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`);
  }
  for (const image of images) hash(`${image.currentSrc}:${image.complete}:${image.naturalWidth}`);
  const drawable = Boolean(text || media);
  // A DOM load can finish while CSS or a loading layer still hides the article.
  // Extra Mac quality fields leave the existing Windows readiness contract intact.
  const painted = node => {
    if (!visible(node)) return false;
    for (let parent = node, depth = 0; parent && depth < 16; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      if (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none') return false;
    }
    const r = node.getBoundingClientRect();
    const x = (Math.max(0, r.left) + Math.min(width, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(height, r.bottom)) / 2;
    const top = document.elementFromPoint(x, y);
    return Boolean(top && (top === node || top.contains(node) || node.contains(top)));
  };
  const mains = Array.from(document.querySelectorAll('main,article,[role="main"]')).slice(0,16)
    .filter(node => visible(node) || getComputedStyle(node).display === 'contents');
  const inSubject = node => mains.length ? mains.some(main => main.contains(node)) : !node.closest('header,nav,footer,aside,[role="navigation"]');
  // A large frontmost layer with substantial content behind it is typically a
  // loading/consent surface. Waiting never clicks or removes that layer.
  let overlay = null;
  for (let node = document.elementFromPoint(width/2, height/2), depth = 0; node && node !== body && depth < 16; node = node.parentElement, depth++) {
    const s = getComputedStyle(node), r = node.getBoundingClientRect();
    const area = Math.max(0, Math.min(width,r.right)-Math.max(0,r.left)) * Math.max(0, Math.min(height,r.bottom)-Math.max(0,r.top));
    if (['fixed','absolute'].includes(s.position) && Number(s.zIndex) >= 10 && area >= width*height*0.8 && painted(node)) { overlay = node; break; }
  }
  // Sample the main region first: a long navigation tree must not consume the
  // entire bounded text walk before the visible article is reached.
  const nodes = document.createTreeWalker(mains[0] || body, NodeFilter.SHOW_TEXT);
  let paintedText = false, subjectText = false, behind = 0;
  for (let node = nodes.nextNode(), count = 0; node && count < 256; node = nodes.nextNode(), count++) {
    const value = node.textContent.trim(), parent = node.parentElement;
    if (!value || !parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
    if (overlay && !overlay.contains(parent)) behind += Math.min(value.length,1000);
    if (!painted(parent)) continue;
    paintedText = true;
    if (inSubject(parent)) subjectText = true;
  }
  const blocked = Boolean(overlay && behind >= 80);
  const visualMedia = [...images.filter(image => image.complete && image.naturalWidth > 0), ...Array.from(document.querySelectorAll('canvas,svg,video')).slice(0,64)];
  const subjectMedia = visualMedia.some(node => {
    const r = node.getBoundingClientRect();
    return r.width*r.height >= width*height*0.02 && inSubject(node) && painted(node) && (node.tagName !== 'VIDEO' || node.readyState >= 2);
  });
  const originalSignature = signature >>> 0;
  for (let y = 80; y < height; y += 160) for (let x = 80; x < width; x += 240) {
    const node = document.elementFromPoint(x, y);
    if (node) { const s = getComputedStyle(node); hash(`${s.opacity}:${s.visibility}:${s.color}:${s.backgroundColor}:${s.transform}`); }
  }
  // A blocked external script can leave readyState at "loading" after useful
  // content has already painted. Keep drawability separate from full readiness
  // so the bounded native fallback can capture that page, never an empty one.
  return { drawable, ready: Boolean(document.readyState !== 'loading' && drawable && !pending && !busy && document.fonts?.status !== 'loading'), signature: originalSignature,
    painted: paintedText || visualMedia.some(painted), subject: !blocked && (subjectText || subjectMedia), blocked, pendingImages: pending,
    errorPage: !document.querySelector('article') && text.length < 1200 && /(?:^|\n)\s*(?:403|404|500|502|503|504)[. :]*(?:\n|$)/.test(text) && /not found|something went wrong|forbidden|server error|unavailable/i.test(text),
    busy, paintSignature: signature >>> 0 };
})()
