import { useI18n } from '../settings/locale';
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import type { StashItem } from '../../types';
import { BrandIcon } from '../../components/BrandIcon';
import { WindowControls } from '../../components/WindowControls';
import { ReferenceEditor } from '../../components/ReferenceEditor';
import { prepareReferenceCover } from '../../lib/referenceCover';
import { ContentEditor } from '../../components/ContentEditor';
import { TagEditor, type TagOperation } from '../../components/TagEditor';
import { libraryStore } from './useLibrary';
import { getItems } from '../../lib/storage';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { handleTitlebarDrag, handleTitlebarDoubleClick } from '../../lib/desktopWindows';
import { Alert } from "../../components/arc/alert/alert";
import { ScrollArea } from "../../components/arc/scroll-area/scroll-area";
import { Button } from "../../components/arc/button/button";
import { ReferenceDeleteDialog } from "../../components/ReferenceDeleteDialog";
import { LoadingReferences } from "../../components/LoadingReferences";
import { ContextBar } from "../../components/ContextBar";
import { EmptyState } from "../../components/EmptyState";
import { Sidebar } from "../../components/Sidebar";
import { ShelfTagFilter } from "../../components/ShelfTagFilter";
import { shelfFilters } from "../../components/ReferenceShelf";
import SegmentedControl from "../../components/arc/segmented-control/segmented-control";
import { StashCard } from "../../components/StashCard";
import { Toolbar } from "../../components/Toolbar";
import { hideStashDock } from "../../lib/desktopWindows";
import { useLibraryController } from "./useLibraryController";
import { usePinnedTags } from './usePinnedTags';
import { VirtualShelf } from './VirtualShelf';
import styles from "./LibraryView.module.css";
import listStyles from '../../components/ReferenceList.module.css';
import { ReferenceImportDialog } from '../../components/ReferenceImportDialog';

const SettingsView = lazy(() => import('../settings/SettingsView'));

export default function LibraryView({ onCollapse, active = true, maximized = false, floatingWindow = true, nativeChrome = false }: { onCollapse?: () => void; active?: boolean; maximized?: boolean; floatingWindow?: boolean; nativeChrome?: boolean }) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false), [settingsBusy, setSettingsBusy] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(() => { settingsTrigger.current = document.activeElement as HTMLElement; setSettingsOpen(true); }, []);
  const closeSettings = useCallback(() => { setSettingsOpen(false); requestAnimationFrame(() => settingsTrigger.current?.focus()); }, []);
  useEffect(() => {
    if (!nativeChrome) return;
    let disposed = false; let stop: (() => void) | undefined;
    void listen('desktop-open-settings', () => openSettings()).then(cleanup => {
      if (disposed) cleanup(); else stop = cleanup;
    }).catch(error => console.warn("Could not listen for native Settings", error));
    return () => { disposed = true; stop?.(); };
  }, [nativeChrome, openSettings]);
  const [editing, setEditing] = useState<StashItem | null>(null);
  const [contentEditing, setContentEditing] = useState<StashItem | null>(null);
  const [tagOperation, setTagOperation] = useState<TagOperation | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const tagFocus = useRef<HTMLElement | null>(null);
  const editReference = useCallback((item: StashItem) => {
    returnFocus.current = document.querySelector<HTMLElement>(`article[data-reference-id="${CSS.escape(item.id)}"] button[aria-haspopup="menu"]`);
    setEditing(item);
  }, []);
  const editTag = useCallback((name: string, action: TagOperation['action']) => {
    returnFocus.current = tagFocus.current?.getClientRects().length ? tagFocus.current : document.querySelector<HTMLElement>('aside button[aria-expanded]');
    setTagOperation({ name, action });
  }, []);
  useEffect(() => { if (!active) { setEditing(null); setContentEditing(null); setTagOperation(null); } }, [active]);
  const { sort, setSort, storageReady, error, refresh, refreshing, searching, shownKey, shownQuery, shownFilter, shownTag, filter, setFilter, activeTag, setActiveTag, query, setQuery, selectedItems, selectedSet, setSelectedIds, view, setView, importDialog, copied, copiedItemId, notice, setNotice, searchRef, counts, tags, visibleItems, toggleSelection, toggleFavorite, handleDelete, handleDeleteSelected, pendingDelete, setPendingDelete, deleting, deleteError, confirmDelete, handleOpenItem, addItems, replaceLink, handleCopy, handleCopyItem } = useLibraryController(active, true, Boolean(editing || contentEditing || tagOperation || settingsOpen));
  // The folder search opens the library on the same search.
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false, cleanup: (() => void) | undefined;
    void listen<string>('library-search', event => {
      if (stopped || typeof event.payload !== 'string') return;
      setSettingsOpen(false); setFilter('all'); setActiveTag(null); setQuery(event.payload.slice(0, 500));
    }).then(stop => { if (stopped) stop(); else cleanup = stop; });
    return () => { stopped = true; cleanup?.(); };
  }, [setFilter, setActiveTag, setQuery]);
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false, cleanup: (() => void) | undefined;
    void listen('desktop-focus-search', () => { if (!stopped) { setSettingsOpen(false); searchRef.current?.focus(); } })
      .then(stop => { if (stopped) stop(); else cleanup = stop; });
    return () => { stopped = true; cleanup?.(); };
  }, [searchRef]);
  const editContent = useCallback((item: StashItem) => {
    returnFocus.current = document.querySelector<HTMLElement>(`article[data-reference-id="${CSS.escape(item.id)}"] button[aria-haspopup="menu"]`);
    // Desktop shelf rows carry no bodies: read this reference in full first.
    if (!isTauri()) { setContentEditing(item); return; }
    void getItems([item.id], true).then(([full]) => {
      if (full) setContentEditing(full); else setNotice(t('This reference no longer exists.'), 5000);
    }).catch(error => setNotice(t(error instanceof Error ? error.message : String(error)), 5000));
  }, [setNotice, t]);
  const pinnedError = useCallback((message: string) => setNotice(message, 5000), [setNotice]);
  const { pinnedTags, pinTag, reconcileTag } = usePinnedTags(pinnedError);
  // Stable handlers let the memoized navigation and tag menus skip the
  // re-render that every search keystroke causes here.
  const selectFilter = useCallback((next: typeof filter) => { if (!settingsBusy) { setSettingsOpen(false); setFilter(next); } }, [settingsBusy, setFilter]);
  const selectTag = useCallback((tag: string | null) => { if (!settingsBusy) { setSettingsOpen(false); setActiveTag(tag); } }, [settingsBusy, setActiveTag]);
  const renameTag = useCallback((name: string) => editTag(name, 'rename'), [editTag]);
  const removeTag = useCallback((name: string) => editTag(name, 'remove'), [editTag]);
  const togglePin = useCallback((name: string, pinned: boolean) => { void pinTag(name, pinned).catch(() => pinnedError('Pinned tags could not be saved. Try again.')); }, [pinTag, pinnedError]);
  const filterTag = useCallback((name: string) => setActiveTag(name || null), [setActiveTag]);
  const editTagOperation = useCallback((operation: TagOperation) => editTag(operation.name, operation.action), [editTag]);
  return (
    <div data-arc-ui className={`fluid-ui ${styles.root} ${onCollapse ? styles.native : styles.browser}`}>
      <main
        className={`app-shell ${styles.shell}`}
      >
        {!nativeChrome && <header className={`${styles.windowBar} ${onCollapse ? 'window-titlebar' : ''}`} onPointerDown={event => handleTitlebarDrag(event, Boolean(onCollapse) && !nativeChrome)} onDoubleClick={event => handleTitlebarDoubleClick(event, Boolean(onCollapse) && !nativeChrome)}>
          <BrandIcon className={styles.brand} />
          <div className={styles.windowActions}>{onCollapse && <WindowControls maximized={maximized} floatingWindow={floatingWindow} nativeResize disabled={!active || settingsBusy} onCollapse={onCollapse} onClose={() => void hideStashDock()} />}</div>
        </header>}
        <div className={styles.workspace} data-window-content data-shell-workspace>
        <div className={styles.desktopNavigation} data-shell-navigation onPointerDown={event => handleTitlebarDrag(event, Boolean(onCollapse) && !nativeChrome)} onDoubleClick={event => handleTitlebarDoubleClick(event, Boolean(onCollapse) && !nativeChrome)}>
        <Sidebar active={filter} counts={counts} tags={tags} activeTag={activeTag} onSelect={selectFilter} onSelectTag={selectTag} showBrand={nativeChrome} onRenameTag={renameTag} onRemoveTag={removeTag} pinnedTags={pinnedTags} onPinTag={togglePin} onSettings={openSettings} settingsOpen={settingsOpen} settingsDisabled={settingsBusy} />
        </div>
        <section className={styles.main} hidden={settingsOpen}>
          <Toolbar
            compactBrand={nativeChrome ? <BrandIcon className={styles.compactBrand} /> : undefined}
            query={query}
            searching={searching}
            sort={sort}
            onSortChange={setSort}
            refreshing={refreshing}
            view={view}
            searchRef={searchRef}
            onQueryChange={setQuery}
            onViewChange={setView}
            onAdd={() => importDialog.current?.open()}
            onSettings={openSettings}
            settingsDisabled={settingsBusy}
            collectionControls={<SegmentedControl label={t("Collection")} options={[...shelfFilters.map(option => ({ ...option, label: t(option.label) })), ...pinnedTags.filter(name => tags.some(tag => tag.name === name)).map(name => ({ value: `tag:${name}`, label: name }))]} value={activeTag ? `tag:${activeTag}` : filter} onValueChange={value => { if (value.startsWith('tag:')) setActiveTag(value.slice(4)); else { setFilter(value as typeof filter); setActiveTag(null); } }} />}
            tagControls={<ShelfTagFilter tags={tags} activeTag={activeTag || ''} disabled={!storageReady} busy={false} triggerRef={tagFocus} onFilter={filterTag} onEdit={editTagOperation} pinnedTags={pinnedTags} onPin={togglePin} />}
          />

          <ScrollArea className={styles.scroller} viewportClassName={styles.content} viewportRef={setScroller} label={t("References")} fade={0} aria-busy={!storageReady || refreshing} data-shell-scroller>
            <h2 className="sr-only">{t("References")}</h2>
            <div className={styles.feedback}>
              <Alert tone="danger" title={t("Library could not be refreshed")} open={Boolean(error)}>{t(error || '')}<div className={styles.retry}><Button variant="secondary" onClick={() => void refresh()}>{t("Retry connection")}</Button></div></Alert>
              <Alert tone="info" title={t(notice || "")} open={Boolean(notice)} onDismiss={() => setNotice(null)} />
            </div>
            {!storageReady ? (
              <LoadingReferences compact={view === "list"} className={view === 'grid' ? styles.grid : undefined} />
            ) : visibleItems.length ? (
                <VirtualShelf items={visibleItems} view={view} scroller={scroller} gridClassName={styles.grid} listClassName={listStyles.list} resetKey={shownKey}>
                  {item => (
                    <StashCard
                      key={item.id}
                      item={item}
                      selected={selectedSet.has(item.id)}
                      copied={copiedItemId === item.id}
                      dragItems={selectedItems}
                      view={view}
                      onToggle={toggleSelection}
                      onFavorite={toggleFavorite}
                      onDelete={handleDelete}
                      onOpen={handleOpenItem}
                      onCopy={handleCopyItem}
                      onEdit={editReference}
                      onEditContent={editContent}
                    />
                  )}
                </VirtualShelf>
            ) : (
              <EmptyState query={shownQuery} scope={shownTag ? "tag" : shownFilter} onAdd={() => importDialog.current?.open()} onClearSearch={() => setQuery("")} onShowAll={() => { setActiveTag(null); setFilter("all"); }} />
            )}
          </ScrollArea>

          <ContextBar items={selectedItems} copied={copied} onCopy={handleCopy} onClear={() => setSelectedIds([])} onDelete={handleDeleteSelected} busy={deleting}
            onSelectAll={() => setSelectedIds(Array.from(visibleItems, item => item.id))} allSelected={visibleItems.every(item => selectedSet.has(item.id))} />
        </section>
        {settingsOpen && <div className={styles.main}><Suspense fallback={<LoadingReferences />}><SettingsView onClose={closeSettings} onBusyChange={setSettingsBusy} /></Suspense></div>}
        </div>
      </main>

      <ReferenceImportDialog ref={importDialog} active={active} onAdd={addItems} onReplace={replaceLink} availableTags={tags.map(tag => tag.name)} existingItems={libraryStore.getSnapshot().items} />
      <ReferenceEditor item={editing} prepareCover={prepareReferenceCover} availableTags={tags.map(tag => tag.name)} returnFocus={returnFocus} onClose={() => setEditing(null)} onSave={(id, title, tags, cover) => libraryStore.edit(id, title, tags, cover)} />
      <ContentEditor item={contentEditing} returnFocus={returnFocus} onClose={() => setContentEditing(null)} onSave={(id, content) => libraryStore.editContent(id, content)} />
      <TagEditor operation={tagOperation} returnFocus={returnFocus} onClose={() => setTagOperation(null)} onSave={async (name, replacement) => {
        await libraryStore.changeTag(name, replacement);
        if (activeTag?.toLowerCase() === name.toLowerCase()) setActiveTag(replacement);
        await reconcileTag(name, replacement);
      }} />
      <ReferenceDeleteDialog target={pendingDelete} busy={deleting} error={deleteError} onClose={() => setPendingDelete(null)} onConfirm={confirmDelete} returnFocus={searchRef} />
    </div>
  );
}
