import { useEffect, useMemo, useRef, useState } from 'react';
import { App } from '@modelcontextprotocol/ext-apps';
import plugin from '../../../plugins/stashdock/.codex-plugin/plugin.json';
import { Check, Plus, Settings } from 'lucide-react';
import { ReferenceSortMenu } from '../../components/ReferenceSortMenu';
import { normalizeReferenceSort, type ReferenceSort } from '../../lib/reference-sort.mjs';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { motionTokens } from '../../components/arc/lib/motion-tokens';
import { Button } from '../../components/arc/button/button';
import { SearchField } from '../../components/arc/search-field/search-field';
import SegmentedControl from '../../components/arc/segmented-control/segmented-control';
import { ScrollArea } from '../../components/arc/scroll-area/scroll-area';
import { Alert } from '../../components/arc/alert/alert';
import { EmptyState, type EmptyScope } from '../../components/EmptyState';
import { LoadingReferences } from '../../components/LoadingReferences';
import { BrandIcon } from '../../components/BrandIcon';
import { shelfFilters } from '../../components/ReferenceShelf';
import { ReferenceCardView } from '../../components/StashCard';
import { ReferenceImportDialog, type ReferenceImportHandle } from '../../components/ReferenceImportDialog';
import { mcpLinkImport } from './import';
import { ReferenceDeleteDialog, type ReferenceDeletion } from '../../components/ReferenceDeleteDialog';
import { SelectionManagementActions } from '../../components/SelectionManagementActions';
import { ReferenceEditor } from '../../components/ReferenceEditor';
import { ContentEditor } from '../../components/ContentEditor';
import { referenceOpenTarget } from '../../lib/referenceOpen';
import { attachKeyboardNavigation } from '../../lib/keyboardNavigation';
import { TagFilter, type ShelfTag } from './TagFilter';
import { TagEditor, type TagOperation } from '../../components/TagEditor';
import { CardActionLabel } from '../../components/CardActionLabel';
import { SelectAllReferences } from '../../components/SelectAllReferences';
import { ReferenceViewToggle } from '../../components/ReferenceViewToggle';
import type { StashItem } from '../../types';
import { addAttachmentToDraft, parseAttachment, supportsDraft, supportsNativeFiles, DRAFT_REOPEN_HINT, DRAFT_UNAVAILABLE } from './draft';
import card from '../../components/StashCard.module.css';
import listStyles from '../../components/ReferenceList.module.css';
import type { ChosenFile, ChosenFileDraft, FileReferencePayload } from '../../lib/fileReference';
import header from '../../components/DockHeader.module.css';
import context from '../../components/ContextBar.module.css';
import action from '../../components/CopyForAI.module.css';
import styles from './McpShelf.module.css';
import { reconcileReferences } from '../../lib/reconcileReferences';
import { readPreviewPages } from './readPreviewPages';
import { useMcpSettings } from './settings';
import McpSettingsView from './McpSettingsView';
import { useI18n } from '../settings/locale';
import { COMPOSER_UNAVAILABLE, errorText } from '../../lib/errorText';

const kinds = ['web', 'repo', 'pdf', 'image', 'note', 'file'];
const message = (error: unknown) => errorText(error);

function readRows(raw: unknown): StashItem[] {
  if (!Array.isArray(raw) || raw.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' ||
    typeof item.title !== 'string' || !kinds.includes(item.kind) || typeof item.source !== 'string' || !Array.isArray(item.tags) || item.tags.some((tag: unknown) => typeof tag !== 'string'))) {
    throw new Error('The library data is invalid. Refresh and retry.');
  }
  return raw;
}

export function McpShelf() {
  const { t } = useI18n();
  const { setClient, setHost } = useMcpSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const searchRef = useRef<HTMLInputElement>(null);
  const appRef = useRef<App | null>(null);
  const refreshCurrent = useRef<() => void>(() => {});
  const importServices = useMemo(() => mcpLinkImport(() => appRef.current), []);
  const sequence = useRef(0);
  const readFlights = useRef(0);
  // Icons still missing after one 90 s wait are not waited for again: many
  // sites have none, and a new search must not restart the polling for them.
  const faviconPolling = useRef({ key: '', until: 0, given: new Set<string>() });
  const flight = useRef(false);
  const alive = useRef(true);
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [draftSupported, setDraftSupported] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [readError, setReadError] = useState('');
  const [addError, setAddError] = useState('');
  const [query, setQuery] = useState('');
  // The query the shown cards answer; the field spins while a newer one is read.
  const [answeredQuery, setAnsweredQuery] = useState('');
  // What the shown cards answer, so an empty state never names a collection
  // whose results have not arrived yet.
  const [answeredScope, setAnsweredScope] = useState<EmptyScope>('all');
  const [destination, setDestination] = useState({ filter: 'all', activeTag: '' });
  const { filter, activeTag } = destination;
  const setFilter = (filter: string) => setDestination(previous => previous.filter === filter && !previous.activeTag ? previous : { filter, activeTag: '' });
  const setActiveTag = (activeTag: string) => setDestination(previous => {
    const filter = activeTag ? 'all' : previous.filter;
    return previous.filter === filter && previous.activeTag === activeTag ? previous : { filter, activeTag };
  });
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<ReferenceSort>('newest');
  const [sortRevision, setSortRevision] = useState(0);
  const sortRef = useRef<ReferenceSort>('newest');
  const [tags, setTags] = useState<ShelfTag[]>([]);
  const importDialog = useRef<ReferenceImportHandle>(null);
  const [tagOperation, setTagOperation] = useState<TagOperation | null>(null);
  const tagFocus = useRef<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState<ReferenceDeletion | null>(null);
  // Short confirmations, as on desktop (Reference deleted., open failures).
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [editing, setEditing] = useState<StashItem | null>(null);
  const [contentEditing, setContentEditing] = useState<StashItem | null>(null);
  const editorSequence = useRef(0);
  const editorFocus = useRef<HTMLElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [mutationBusy, setMutationBusy] = useState(false);
  const [favoritePending, setFavoritePending] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [managementError, setManagementError] = useState('');
  const [items, setItems] = useState<StashItem[]>([]);
  const loadedCount = useRef(0);
  loadedCount.current = items.length;
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectedAll, setSelectedAll] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);

  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const pendingIds = useMemo(() => new Set(pending), [pending]);
  const acknowledgedIds = useMemo(() => new Set(acknowledged), [acknowledged]);
  useEffect(() => {
    if (!acknowledged.length || pending.length) return;
    // Temporary success feedback, not a claim about the host's current draft.
    const timer = window.setTimeout(() => setAcknowledged([]), 1800);
    return () => window.clearTimeout(timer);
  }, [acknowledged, pending.length]);

  async function load(app: App, text: string, collection: string, offset = 0, preservePages = false) {
    const request = ++sequence.current;
    ++readFlights.current;
    setRefreshing(true);
    setLoadingMore(offset > 0);
    try {
      let result = await app.callServerTool({ name: 'list_stashdock_shelf', arguments: { query: text, collection, tag: activeTag, limit: 30, offset, ...(offset ? { sort: sortRef.current } : {}) } }, { timeout: 10_000 });
      if (!alive.current || request !== sequence.current) return;
      if (result.isError) throw new Error(result.content.find(block => block.type === 'text')?.text || 'References could not be refreshed. Retry the connection.');
      const rows = readRows(result._meta?.items);
      const order = normalizeReferenceSort(result._meta?.sort);
      const tagRows = result._meta?.tags;
      if (preservePages && offset === 0 && loadedCount.current > 30) {
        const current = () => alive.current && appRef.current === app && request === sequence.current;
        const extra = await readPreviewPages(loadedCount.current - 30, async page => {
          result = await app.callServerTool({ name: 'list_stashdock_shelf', arguments: { query: text, collection, tag: activeTag, limit: 30, offset: page + 30, sort: order } }, { timeout: 10_000 });
          if (result.isError) throw new Error('References could not be refreshed. Retry.');
          return readRows(result._meta?.items);
        }, current);
        if (!extra || !current()) return;
        rows.push(...extra);
      }
      if (Array.isArray(tagRows)) setTags(tagRows.filter((tag): tag is ShelfTag => Boolean(tag && typeof tag === 'object' && typeof (tag as ShelfTag).name === 'string' && typeof (tag as ShelfTag).count === 'number')));
      setItems(previous => reconcileReferences(previous, rows, offset ? 'append' : 'replace'));
      sortRef.current = order; setSort(order);
      setHasMore(result.structuredContent?.hasMore === true);
      setReadError('');
      setReady(true);
      if (!offset) { setAnsweredQuery(text); setAnsweredScope(activeTag ? 'tag' : collection as EmptyScope); }
    } catch (error) {
      if (alive.current && request === sequence.current) { setReadError(message(error)); setReady(true); setAnsweredQuery(text); }
    } finally {
      --readFlights.current;
      if (alive.current && request === sequence.current) { setRefreshing(false); setLoadingMore(false); }
    }
  }

  useEffect(() => {
    alive.current = true;
    // Panel height belongs to the host. Inline autoResize would feed viewport
    // height back to it instead of filling the available side-panel space.
    const app = new App({ name: 'StashDock', version: plugin.version }, { availableDisplayModes: ['fullscreen'] }, { autoResize: false, strict: true });
    appRef.current = app;
    let disposed = false;
    setConnected(false); setConnectionError('');
    const syncHost = () => {
      if (disposed) return;
      const context = app.getHostContext();
      if (context) setHost({ theme: context.theme, locale: context.locale });
      setDraftSupported(supportsDraft(app));
    };
    app.onhostcontextchanged = syncHost;
    void app.connect(undefined, { timeout: 10_000 }).then(async () => {
      if (disposed) return;
      const host = app.getHostContext();
      if (host?.displayMode === 'inline' && host.availableDisplayModes?.includes('fullscreen')) {
        await app.requestDisplayMode({ mode: 'fullscreen' });
        if (disposed) return;
      }
      syncHost(); setClient(app); setConnected(true);
    }).catch(error => { if (!disposed) setConnectionError(message(error)); });
    return () => {
      disposed = true; alive.current = false; ++sequence.current; ++editorSequence.current;
      appRef.current = null; setClient(null); void app.close();
    };
  }, [attempt]);
  useEffect(() => attachKeyboardNavigation(document), []);

  useEffect(() => {
    if (!connected || !appRef.current) return;
    // Debounce queries and invalidate older responses immediately, not only once
    // the next request starts. Late responses must not replace a newer search.
    ++sequence.current;
    setSelectedAll(false);
    setHasMore(false);
    const app = appRef.current;
    const timer = setTimeout(() => { void load(app, query, filter); }, 140);
    return () => { clearTimeout(timer); ++sequence.current; };
  }, [connected, query, filter, activeTag, sortRevision]);
  useEffect(() => {
    if (!connected || settingsOpen || mutationBusy || deleting || editing || contentEditing || tagOperation || !items.some(item => item.contentStatus === 'queued' || item.contentStatus === 'working' || item.previewStatus === 'queued' || item.previewStatus === 'working' || (['web', 'repo'].includes(item.kind) && !item.origin?.faviconUrl?.startsWith('data:image/') && !faviconPolling.current.given.has(item.id)))) return;
    let disposed = false, running = false;
    const polling = faviconPolling.current;
    const missing = items.filter(item => ['web', 'repo'].includes(item.kind) && !item.origin?.faviconUrl?.startsWith('data:image/') && !polling.given.has(item.id)).map(item => item.id).join('|');
    if (polling.key !== missing) { polling.key = missing; polling.until = Date.now() + 90_000; }
    const timer = setInterval(async () => {
      if (Date.now() > polling.until) for (const id of missing.split('|')) if (id) polling.given.add(id);
      if (Date.now() > polling.until && !items.some(item => item.contentStatus === 'queued' || item.contentStatus === 'working' || item.previewStatus === 'queued' || item.previewStatus === 'working')) { clearInterval(timer); return; }
      const app = appRef.current, request = sequence.current;
      if (disposed || running || readFlights.current || document.hidden || importDialog.current?.isOpen() || !app) return;
      running = true;
      try {
        // Refresh every loaded page without collapsing pagination or changing selection.
        const current = () => !disposed && !importDialog.current?.isOpen() && alive.current && appRef.current === app && request === sequence.current;
        const rows = await readPreviewPages(items.length, async offset => {
          const result = await app.callServerTool({ name: 'list_stashdock_shelf', arguments: { query, collection: filter, tag: activeTag, limit: 30, offset, sort: sortRef.current } }, { timeout: 10_000 });
          if (result.isError) throw new Error('Preview refresh failed');
          return readRows(result._meta?.items);
        }, current);
        if (rows && current()) setItems(previous => reconcileReferences(previous, rows, 'update'));
      } catch { /* Keep existing cards. Foreground refresh retains its retry UI. */ }
      finally { running = false; }
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [connected, items, query, filter, activeTag, settingsOpen, mutationBusy, deleting, editing, contentEditing, tagOperation]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (settingsOpen || importDialog.current?.isOpen() || tagOperation || deleting || editing || contentEditing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.defaultPrevented) {
        event.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [settingsOpen, tagOperation, deleting, editing, contentEditing]);

  const refresh = () => { if (appRef.current && connected) void load(appRef.current, query, filter, 0, true); };
  refreshCurrent.current = refresh;
  useEffect(() => {
    if (!connected) return;
    // Entering the iframe can focus the window on the same press as Load more.
    // A passive refresh must not supersede that intentional foreground read.
    const sync = () => { if (!document.hidden && !importDialog.current?.isOpen() && appRef.current && !readFlights.current) void load(appRef.current, query, filter, 0, true); };
    window.addEventListener('focus', sync); document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [connected, query, filter, activeTag]);
  const mutationFlight = useRef(false);
  async function mutate(name: string, args: Record<string, unknown>) {
    const app = appRef.current;
    if (!app || !connected) throw new Error('StashDock is not connected. Retry the connection.');
    if (mutationFlight.current) throw new Error('Wait for the current library change to finish.');
    mutationFlight.current = true; setMutationBusy(true); setMutationError('');
    try {
      const result = await app.callServerTool({ name, arguments: args }, { timeout: 30_000 });
      if (result.isError) throw new Error(result.content.find(block => block.type === 'text')?.text || 'The change could not be saved. Retry.');
      return result;
    } finally { mutationFlight.current = false; if (alive.current) setMutationBusy(false); }
  }
  async function favorite(item: StashItem) {
    if (mutationFlight.current) return;
    setFavoritePending(item.id);
    try {
      await mutate('set_stashdock_favorite', { id: item.id, favorite: !item.favorite });
      setItems(rows => rows.map(row => row.id === item.id ? { ...row, favorite: !item.favorite } : row)); refresh();
    } catch (error) { setManagementError(message(error)); }
    finally { if (alive.current) setFavoritePending(null); }
  }
  async function changeSort(sort: ReferenceSort) {
    ++sequence.current;
    try {
      await mutate('set_stashdock_sort', { sort });
      if (alive.current) setSortRevision(value => value + 1);
    } catch (error) { if (alive.current) { setManagementError(message(error)); setRefreshing(false); } }
  }
  async function openContent(item: StashItem) {
    const app = appRef.current;
    if (!app || mutationBusy) return;
    const request = ++editorSequence.current;
    editorFocus.current = cards.current.get(item.id)?.querySelector<HTMLElement>('[data-card-menu]') ?? null;
    try {
      const result = await app.callServerTool({ name: 'get_stashdock_context', arguments: { id: item.id } }, { timeout: 10_000 });
      if (!alive.current || appRef.current !== app || request !== editorSequence.current) return;
      if (result.isError) throw new Error(result.content.find(block => block.type === 'text')?.text || 'Context could not be opened. Retry.');
      const fullItem = readRows([result._meta?.item])[0];
      if (fullItem.id !== item.id || typeof result._meta?.context !== 'string') throw new Error('The context data is invalid. Refresh and retry.');
      setContentEditing({ ...fullItem, contextOverride: result._meta.context });
    } catch (error) { if (alive.current && request === editorSequence.current) setManagementError(message(error)); }
  }
  function openEditor(item: StashItem) { ++editorSequence.current; editorFocus.current = cards.current.get(item.id)?.querySelector<HTMLElement>('[data-card-menu]') ?? null; setEditing(item); }
  async function importFiles(files: FileReferencePayload[], tags: string[]) {
    const result = await mutate('import_stashdock_files', { files, tags });
    return readRows(result.structuredContent?.items);
  }
  // The system dialog runs on this computer; the App only receives tokens.
  async function chooseFiles(): Promise<ChosenFile[]> {
    const app = appRef.current;
    if (!app || !connected) throw new Error('StashDock is not connected. Retry the connection.');
    const result = await app.callServerTool({ name: 'choose_stashdock_files', arguments: {} }, { timeout: 300_000 });
    if (result.isError) throw new Error(result.content.find(block => block.type === 'text')?.text || 'The files could not be read. Choose them again.');
    const files = result._meta?.files;
    if (!Array.isArray(files) || files.some(file => !file || typeof file.token !== 'string' || typeof file.name !== 'string' || typeof file.content !== 'string' || !Number.isFinite(file.size))) throw new Error('The chosen files are invalid. Choose them again.');
    return files.map(file => ({ token: file.token, name: file.name, size: file.size, mimeType: typeof file.mimeType === 'string' ? file.mimeType : '', content: file.content }));
  }
  async function importChosenFiles(files: ChosenFileDraft[], tags: string[]) {
    const result = await mutate('import_stashdock_chosen_files', { files, tags });
    return readRows(result.structuredContent?.items);
  }
  const toggle = (id: string) => {
    setSelectedAll(false);
    setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  };
  async function selectAll() {
    const app = appRef.current, request = sequence.current;
    if (!app || selectingAll || pending.length) return;
    setSelectingAll(true);
    try {
      const result = await app.callServerTool({ name: 'select_stashdock_shelf', arguments: { query, collection: filter, tag: activeTag } }, { timeout: 10_000 });
      if (result.isError) throw new Error('References could not be selected. Refresh and retry.');
      const ids = result._meta?.ids;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('The selection data is invalid. Refresh and retry.');
      if (alive.current && request === sequence.current) { setSelected([...new Set(ids)]); setSelectedAll(true); }
    } catch (error) { if (alive.current && request === sequence.current) setManagementError(message(error)); }
    finally { if (alive.current) setSelectingAll(false); }
  }
  const add = async (ids: string[]) => {
    const app = appRef.current;
    if (!app || !draftSupported || flight.current) return;
    const remaining = [...new Set(ids)];
    if (!remaining.length) return;
    flight.current = true; setPending(remaining); setAcknowledged([]); setAddError('');
    const successful: string[] = [];
    const operationId = crypto.randomUUID();
    try {
      // Keep snapshots bounded without limiting how many displayed cards can be selected.
      for (let offset = 0; offset < remaining.length; offset += 30) {
      const batch = remaining.slice(offset, offset + 30);
      const result = await app.callServerTool({ name: 'prepare_stashdock_attachment', arguments: { ids: batch,
        ...(supportsNativeFiles(app) && { fileDelivery: 'native' }) } }, { timeout: 10_000 });
      if (result.isError) throw new Error(result.content.find(block => block.type === 'text')?.text || 'The reference could not be prepared. Refresh and retry.');
      if (!alive.current || appRef.current !== app) return;
      const attachment = parseAttachment(result._meta?.attachment);
      if (attachment.ids.length !== batch.length || attachment.ids.some(id => !batch.includes(id))) throw new Error('The prepared selection does not match. Refresh and retry.');
      await addAttachmentToDraft(app, attachment);
      successful.push(...batch);
      if (!alive.current || appRef.current !== app) return;
      setAcknowledged([...successful]);
      }
    } catch (error) {
      if (alive.current && appRef.current === app) setAddError(message(error));
    } finally {
      flight.current = false;
      if (alive.current && appRef.current === app) setPending([]);
      if (successful.length) {
        // One acknowledgment per user action, including any successful batches
        // before a later failure. Bookkeeping never retries draft delivery.
        void app.callServerTool({ name: 'record_stashdock_use', arguments: { ids: successful, operationId } }, { timeout: 10_000 }).then(result => {
          if (result.isError) throw new Error('Reference usage could not be recorded.');
          if (alive.current && appRef.current === app && sortRef.current === 'most-used') refreshCurrent.current();
        }).catch(console.warn);
      }
    }
  };

  return <main data-arc-ui className={styles.root}>
    {settingsOpen && <McpSettingsView dsh={appRef.current?.getHostVersion()?.name === 'DeepSeek Harness'} onLibraryMoved={refresh} onClose={() => { setSettingsOpen(false); refresh(); requestAnimationFrame(() => settingsTrigger.current?.focus()); }} onOpenLink={async url => { await appRef.current?.openLink({ url }); }} />}
    <h1 className={styles.srOnly} hidden={settingsOpen}>{t('StashDock references')}</h1>
    <header className={header.header} hidden={settingsOpen}>
      <div className={header.top}><BrandIcon className={styles.brand} /><Button ref={settingsTrigger} variant="ghost" size="sm" aria-label={t('Settings')} disabled={!connected || mutationBusy || pending.length > 0} onClick={() => { ++editorSequence.current; setSettingsOpen(true); }}><Settings size={16} strokeWidth={1.75} aria-hidden="true" /></Button><Button variant="secondary" size="sm" aria-haspopup="dialog" disabled={!connected || mutationBusy} onClick={() => importDialog.current?.open()}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />{t('Import references')}</Button></div>
      <div className={`${header.search} ${styles.searchRow}`}><SearchField ref={searchRef} label={t('Search references')} placeholder={t('Search references')} value={query} busy={connected && ready && query !== answeredQuery} onValueChange={setQuery} aria-keyshortcuts="Control+k" /><div className={styles.viewToolbar}><ReferenceViewToggle value={view} onChange={setView} /></div></div>
      <div className={`${header.filters} ${styles.filters}`}>
        <div className={header.filterOptions}><SegmentedControl label={t('Collection')} options={shelfFilters.map(option => ({ ...option, label: t(option.label) }))} value={filter} onValueChange={value => { setFilter(value); setActiveTag(''); }} /></div>
      <div className={styles.tagToolbar}><TagFilter tags={tags} activeTag={activeTag} disabled={!connected} busy={mutationBusy} triggerRef={tagFocus} onFilter={setActiveTag} onEdit={setTagOperation} /></div>
        <ReferenceSortMenu value={sort} onChange={value => void changeSort(value)} disabled={!connected || mutationBusy || refreshing}/>
      </div>
    </header>
    <ScrollArea hidden={settingsOpen} label={t('References')} className={styles.scroller} viewportClassName={`${styles.content} ${selected.length ? styles.contentWithSelection : ''}`} fade={0} aria-busy={!ready || refreshing}>
      <h2 className={styles.srOnly}>{t('Saved references')}</h2>
      {connectionError ? <Alert tone="danger" title={t('StashDock could not connect')}><span className={styles.retry}><span>{t(connectionError)}</span><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>{t('Retry connection')}</Button></span></Alert>
        : !connected ? <LoadingReferences className={styles.list} /> : <>
          {!draftSupported && <Alert tone="warning" className={styles.notice} title={t('Adding to chat is unavailable')}>{t(DRAFT_REOPEN_HINT)}</Alert>}
          {readError && <Alert tone="danger" className={styles.notice} title={t('References could not be refreshed')}><span className={styles.retry}><span>{t(readError)}</span><Button variant="secondary" onClick={refresh} loading={refreshing}>{t('Retry connection')}</Button></span></Alert>}
          {addError && <Alert tone="danger" className={styles.notice} title={t('Could not confirm the reference was added')} onDismiss={() => setAddError('')}>{t(addError)}{addError !== COMPOSER_UNAVAILABLE && addError !== DRAFT_UNAVAILABLE && <> {t('Check the input box before trying again.')}</>}</Alert>}
          {managementError && <Alert tone="danger" className={styles.notice} title={t('The library change could not be saved')} onDismiss={() => setManagementError('')}>{t(managementError)}</Alert>}
          <Alert tone="info" className={styles.notice} title={t(notice)} open={Boolean(notice)} onDismiss={() => setNotice('')} />
          {!ready ? <LoadingReferences compact={view === 'list'} className={view === 'grid' ? styles.list : undefined} /> : items.length ? <div className={view === 'grid' ? styles.list : listStyles.list} aria-busy={refreshing}>
            {items.map(item => <ReferenceCardView key={item.id} item={item} view={view} className={styles.card}
              cardRef={node => { if (node) cards.current.set(item.id, node); else cards.current.delete(item.id); }}
              selected={selectedIds.has(item.id)} selectionDisabled={pending.length > 0 || selectingAll}
              busy={mutationBusy} favoriteLoading={favoritePending === item.id}
              onToggle={toggle} onFavorite={() => void favorite(item)}
              onDelete={reference => { setDeleting({ ids: [reference.id], title: reference.title }); setMutationError(''); }}
              onEdit={openEditor} onEditContent={reference => void openContent(reference)}
              onOpen={reference => {
                void (async () => {
                  if (referenceOpenTarget(reference) === 'link') {
                    const result = await appRef.current?.openLink({ url: reference.url! });
                    if (!result || result.isError) setNotice('This page could not be opened in your default browser.');
                  } else await mutate('open_stashdock_file', { id: reference.id });
                })().catch(() => setNotice(referenceOpenTarget(reference) === 'link' ? 'This page could not be opened in your default browser.' : 'This file could not be opened. Check that its app is installed and the file still exists.'));
              }}
              action={<Button variant="primary" size="sm" className={`${action.button} ${card.copyAction} ${acknowledgedIds.has(item.id) && !pendingIds.has(item.id) ? action.success : ''}`} loading={pendingIds.has(item.id)} disabled={!draftSupported} aria-disabled={pending.length > 0 || undefined} data-add-state={pendingIds.has(item.id) ? 'pending' : acknowledgedIds.has(item.id) ? 'success' : 'ready'} onClick={() => void add([item.id])} aria-label={t('Add {title} to chat', { title: item.title })} aria-description={acknowledgedIds.has(item.id) ? t('Added') : undefined}>
                {acknowledgedIds.has(item.id) ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Plus size={16} strokeWidth={1.75} aria-hidden="true" />}<CardActionLabel compact={t(acknowledgedIds.has(item.id) ? 'Added' : 'Add')}>{t(acknowledgedIds.has(item.id) ? 'Added' : 'Add to chat')}</CardActionLabel>
              </Button>} />)}
            {hasMore && <Button variant="secondary" loading={loadingMore} onClick={() => { if (appRef.current) void load(appRef.current, query, filter, items.length); }}>{t('Load more references')}</Button>}
          </div> : !readError && <EmptyState query={answeredQuery} scope={answeredScope} onAdd={() => importDialog.current?.open()} onClearSearch={() => setQuery('')} onShowAll={() => { setFilter('all'); setActiveTag(''); }} />}
        </>}
    </ScrollArea>
    <span className={styles.srOnly} role="status">{pending.length ? t('Adding to chat') : acknowledged.length ? t('Added to chat') : t('{count} selected', { count: selected.length })}</span>
    <AnimatePresence initial={false}>{selected.length > 0 && <motion.footer hidden={settingsOpen} className={`${context.position} ${context.compact}`}
      initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : 8 }}
      transition={reduce ? { duration: 0 } : { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] }}>
      <div className={`${context.bar} ${styles.footer}`}>
        <div className={context.selectionInfo}><div className={context.summaryHeading}>
          <p className={styles.selectionCount}>{t('{count} selected', { count: selected.length })}</p>
          <SelectAllReferences disabled={!connected || pending.length > 0} loading={selectingAll} allSelected={selectedAll || (!hasMore && items.every(item => selectedIds.has(item.id)))} onSelectAll={() => void selectAll()} />
        </div></div>
        <div className={context.actions}>
        <SelectionManagementActions disabled={pending.length > 0 || selectingAll || mutationBusy} onDelete={() => { setMutationError(''); setDeleting({ ids: [...selected] }); }} onClear={() => { setSelectedAll(false); setSelected([]); }} />
        <Button type="button" variant="primary" size="sm" className={`${action.button} ${!pending.length && selected.every(id => acknowledgedIds.has(id)) ? action.success : ''}`} disabled={!connected || !draftSupported || selectingAll} loading={pending.length > 0} onClick={() => void add(selected)}>
          {selected.every(id => acknowledgedIds.has(id)) ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Plus size={16} strokeWidth={1.75} aria-hidden="true" />}
          {t(selected.every(id => acknowledgedIds.has(id)) ? 'Added' : 'Add to chat')}
        </Button>
        </div>
      </div>
    </motion.footer>}</AnimatePresence>
    <ReferenceEditor item={editing} prepareCover={importServices.prepareCover} availableTags={tags.map(tag => tag.name)} returnFocus={editorFocus} onClose={() => setEditing(null)} onSave={async (id, title, values, cover) => { await mutate('edit_stashdock_reference', { id, title, tags: values, ...(cover ? { cover } : {}) }); refresh(); }} />
    <ContentEditor item={contentEditing} returnFocus={editorFocus} onClose={() => setContentEditing(null)} onSave={async (id, context) => { await mutate('edit_stashdock_context', { id, context }); refresh(); }} />
    <ReferenceImportDialog ref={importDialog} services={importServices} availableTags={tags.map(tag => tag.name)} existingItems={items} onImportFiles={importFiles} onChooseFiles={chooseFiles} onImportChosenFiles={importChosenFiles} onAdd={async (items, persisted) => {
      if (!persisted) {
        // Browser collections can exceed one tool request. Keep batches bounded.
        for (let offset = 0; offset < items.length; offset += 200) await mutate('import_stashdock_references', { items: items.slice(offset, offset + 200) });
      }
      // As on desktop, new references are shown in All: a filtered view could hide them.
      if (filter !== 'all' || activeTag) { setFilter('all'); setActiveTag(''); } else refresh();
    }} onReplace={async item => {
      await mutate('replace_stashdock_link', { item });
      if (filter !== 'all' || activeTag) { setFilter('all'); setActiveTag(''); } else refresh();
    }} />
    <TagEditor operation={tagOperation} returnFocus={tagFocus} onClose={() => setTagOperation(null)} onSave={async (name, replacement) => {
      if (replacement === null) { await mutate('delete_stashdock_tag', { name }); if (activeTag === name) setActiveTag(''); }
      else { await mutate('rename_stashdock_tag', { name, replacement }); if (activeTag === name) setActiveTag(replacement); }
      refresh();
    }} />
    <ReferenceDeleteDialog target={deleting} busy={mutationBusy} error={mutationError} returnFocus={searchRef} onClose={() => setDeleting(null)} onConfirm={async () => {
      if (!deleting || mutationFlight.current) return;
      try {
        await mutate('delete_stashdock_references', { ids: deleting.ids });
        const removed = new Set(deleting.ids);
        setSelected(previous => previous.filter(id => !removed.has(id))); setSelectedAll(false);
        setItems(previous => previous.filter(item => !removed.has(item.id)));
        setNotice(deleting.title === undefined ? 'References deleted.' : 'Reference deleted.');
        setDeleting(null); refresh();
      } catch { setMutationError('References could not be deleted. Try again.'); }
    }} />
  </main>;
}
