import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { Check, RefreshCw } from 'lucide-react';
import { Input } from '../../components/arc/input/input';
import { Textarea } from '../../components/arc/textarea/textarea';
import { Button } from '../../components/arc/button/button';
import { Alert } from '../../components/arc/alert/alert';
import { Skeleton } from '../../components/arc/skeleton/skeleton';
import { ReferenceTagsField } from '../../components/ReferenceTagsField';
import { FluidDialog } from '../../components/FluidDialog';
import type { StashItem } from '../../types';
import styles from './Popup.module.css';
import '../../styles/product-tokens.css';

export type PageDraft = StashItem;
export type CaptureConflict = { id: string; title: string; revision: string };
export type CaptureResult = { saved?: boolean; duplicate?: CaptureConflict };
export type PopupServices = {
  capture: (options?: { force?: boolean }) => Promise<PageDraft>;
  tags: () => Promise<string[]>;
  save: (item: PageDraft, replace?: CaptureConflict) => Promise<CaptureResult | void>;
  close: () => void;
  providerStatus?: () => Promise<{ connected: boolean; error?: string }>;
  subscribe?: (refresh: (force?: boolean) => void, invalidate: () => void, update: (page: PageDraft) => void) => () => void;
};
function Popup({ services }: { services: PopupServices }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [checking, setChecking] = useState(false);
  const mounted = useRef(false);
  const checkingConnection = useRef(false);
  async function checkConnection() {
    if (!services.providerStatus || checkingConnection.current || !mounted.current) return;
    checkingConnection.current = true;
    setChecking(true);
    try {
      const next = await services.providerStatus();
      if (mounted.current) { setConnected(next.connected); setConnectionError(next.connected ? '' : next.error || ''); }
    } catch {
      // A broken sidebar channel says nothing about the installed save component.
      if (mounted.current) { setConnected(null); setConnectionError(''); }
    } finally {
      checkingConnection.current = false;
      if (mounted.current) setChecking(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const check = () => { if (!document.hidden) void checkConnection(); };
    check();
    const timer = setInterval(check, 15000);
    document.addEventListener('visibilitychange', check);
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [services]);
  const [page, setPage] = useState<PageDraft | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [errorTitle, setErrorTitle] = useState('Page could not be read');
  const field = useRef<HTMLDivElement>(null);
  const current = useRef(0);
  const pending = useRef(false);
  const displayed = useRef<PageDraft | null>(null);
  const dirty = useRef({title:false,content:false});
  const [replacement, setReplacement] = useState<{ item: PageDraft; duplicate: CaptureConflict } | null>(null);
  const confirming = useRef(false);
  function dismissReplacement() { confirming.current=false;setReplacement(null); }
  function apply(next: PageDraft) {
    if(!mounted.current || pending.current || confirming.current)return;
    const previous=displayed.current;
    const same=Boolean(previous&&previous.url===next.url);
    if(!same){dirty.current={title:false,content:false};setTags([]);setSaved(false);}
    displayed.current=next;setPage(next);
    if(!dirty.current.title)setTitle(next.title);
    if(!dirty.current.content)setContent(next.content||'');
    setError('');setLoading(false);
  }
  async function capture(force = false, replace = force) {
    if (!mounted.current) return;
    const generation = ++current.current;
    setLoading(true); setError(''); if(replace)setPage(null); setSaved(false);
    try {
      const next = await services.capture({ force });
      if (generation !== current.current) return;
      apply(next);
      services.tags().then(values=>{if(generation===current.current)setAvailableTags(values);}).catch(()=>{});
    } catch (reason) {
      if (generation === current.current) {
        setErrorTitle('Page could not be read');
        setError(reason instanceof Error ? reason.message : 'This page could not be read. Retry.');
      }
    }
    finally { if (generation === current.current) setLoading(false); }
  }
  useEffect(() => {
    void capture();
    const unsubscribe=services.subscribe?.(force=>{if(!confirming.current&&!pending.current)void capture(force??false,false);},()=>{dismissReplacement();void capture(true);},apply);
    return () => { current.current++; unsubscribe?.(); };
  }, [services]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!page || loading || pending.current || !title.trim() || Boolean(services.providerStatus && !connected)) return;
    // Commit a draft tag just as the other reference forms do.
    const draft = field.current?.querySelector<HTMLInputElement>('input')?.value.trim();
    const values = [...tags];
    if (draft && !values.some(value => value.toLowerCase() === draft.toLowerCase())) values.push(draft);
    if (values.length > 12 || values.some(value => value.length > 48)) { setErrorTitle('Page could not be saved'); setError('Use at most 12 tags, each up to 48 characters.'); return; }
    await commit({ ...page, title: title.trim(), content: content.trim(), excerpt: Array.from(content.trim().replace(/\s+/g, ' ')).slice(0, 180).join(''), tags: values });
  }
  async function commit(item: PageDraft, replace?: CaptureConflict) {
    if (pending.current) return;
    const generation = current.current;
    pending.current = true; setSaving(true); setError('');
    try {
      const result = await services.save(item, replace);
      if (mounted.current && generation === current.current) {
        if (result?.duplicate) { confirming.current=true;setReplacement({item,duplicate:result.duplicate}); }
        else { dismissReplacement();setSaved(true); }
      }
    } catch (reason) {
      if (generation === current.current) {
        setErrorTitle('Page could not be saved');
        setError(reason instanceof Error ? reason.message : 'The page could not be saved. Retry.');
      }
    }
    finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
      // Navigation during a commit must not attach its Saved state to the next
      // page, or leave a newly captured draft ignored by apply's pending guard.
      if (mounted.current && generation !== current.current) void capture(false, false);
    }
  }
  return <MotionConfig reducedMotion="user"><main className={styles.popup} data-arc-ui aria-label="Save current page" aria-busy={loading || saving} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && !saving && !confirming.current) services.close(); }}>
    <header className={styles.header}><h1>Save current page</h1><Button variant="ghost" size="sm" type="button" aria-label="Refresh page" data-tooltip="Refresh page" loading={loading} onClick={() => void capture(true, false)} disabled={saving}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /></Button></header>
    <form className={styles.form} onSubmit={save}>
      <div className={styles.body}>
        {connected === false && <Alert tone="warning" title="Connect StashDock"><span>{connectionError || 'Open StashDock Desktop or a StashDock AI plugin, then check again.'}</span><br /><Button type="button" variant="secondary" size="sm" loading={checking} onClick={() => void checkConnection()}>Check again</Button></Alert>}
        {loading && !page ? <div className={styles.loading} role="status" aria-label="Reading current page"><Skeleton lines={2} /><Skeleton lines={2} /><Skeleton lines={5} /><Skeleton lines={2} /></div> : page && <>
          <Input label="Link" value={page.url || ''} readOnly />
          <Input label="Title" value={title} onChange={event => {dirty.current.title=true;setSaved(false);setTitle(event.target.value);}} maxLength={500} disabled={saving} autoFocus />
          <div className={styles.contentField}><Textarea label="Content" value={content} onChange={event => {dirty.current.content=true;setSaved(false);setContent(event.target.value);}} rows={3} maxLength={20000} disabled={saving} /></div>
          <ReferenceTagsField value={tags} onValueChange={values=>{setSaved(false);setTags(values);}} availableTags={availableTags} fieldRef={field} busy={saving} />
          {page.origin?.truncated && <p className={styles.note}>Only the visible text was captured. Expand the post and retry for more.</p>}
        </>}
        <Alert tone="danger" title={errorTitle} open={Boolean(error)}>{error}</Alert>
        {!loading && !page && <Button type="button" variant="secondary" onClick={() => void capture(true)}><RefreshCw size={16} strokeWidth={1.75} />Retry reading page</Button>}
      </div>
      <footer className={styles.footer}><Button variant="primary" type="submit" loading={saving} disabled={loading || !page || !title.trim() || saved || Boolean(services.providerStatus && !connected)}>{saved ? <><Check size={16} strokeWidth={1.75} />Saved</> : 'Save page'}</Button></footer>
    </form>
    <FluidDialog open={Boolean(replacement)} onClose={dismissReplacement} title="Replace saved page?" description={replacement ? `“${replacement.duplicate.title}” is already in your library.` : undefined} busy={saving}>
      <p className={styles.replaceCopy}>This will replace the saved reference with the current page.</p>
      <Alert tone="danger" title="Page could not be saved" open={Boolean(error)}>{error}</Alert>
      <div className={styles.replaceActions}>
        <Button type="button" variant="secondary" disabled={saving} onClick={dismissReplacement}>Keep existing</Button>
        <Button type="button" variant="primary" loading={saving} onClick={() => { if(replacement)void commit(replacement.item,replacement.duplicate); }}>Replace page</Button>
      </div>
    </FluidDialog>
  </main></MotionConfig>;
}
export function renderPopup(host: HTMLElement, services: PopupServices) {
  const root = createRoot(host); root.render(<Popup services={services} />); return () => root.unmount();
}
