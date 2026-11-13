import { useI18n } from '../features/settings/locale';
import { Plus, Settings } from "lucide-react";
import { ReferenceSortMenu } from './ReferenceSortMenu';
import type { ReferenceSort } from '../lib/reference-sort.mjs';
import { Button } from "./arc/button/button";
import { SearchField } from "./arc/search-field/search-field";
import { ReferenceViewToggle } from './ReferenceViewToggle';
import styles from "./Toolbar.module.css";

type ToolbarProps = {
  compactBrand?: React.ReactNode;
  query: string;
  searching?: boolean;
  refreshing: boolean;
  sort: ReferenceSort;
  onSortChange: (sort: ReferenceSort) => void;
  view: "grid" | "list";
  searchRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onViewChange: (view: "grid" | "list") => void;
  onAdd: () => void;
  onSettings?: () => void;
  settingsDisabled?: boolean;
  collectionControls?: React.ReactNode;
  tagControls?: React.ReactNode;
};

export function Toolbar({ compactBrand, query, searching = false, refreshing, sort, onSortChange, view, searchRef, onQueryChange, onViewChange, onAdd, onSettings, settingsDisabled, collectionControls, tagControls }: ToolbarProps) {
  const { t } = useI18n();
  return <header data-arc-ui className={styles.toolbar}>
    <div className={styles.headingRow}>
      <div className={styles.title}>{compactBrand && <span className={styles.compactBrand}>{compactBrand}</span>}<h1 className={compactBrand ? styles.brandedTitle : undefined}>{t("Context library")}</h1></div>
      <div className={styles.actions}>
        {onSettings && <Button className={styles.compactSettings} variant="ghost" size="sm" disabled={settingsDisabled} onClick={onSettings} aria-label={t('Settings')}><Settings size={16} strokeWidth={1.75} aria-hidden="true" /></Button>}
        <Button type="button" variant="secondary" size="sm" onClick={onAdd} aria-haspopup="dialog" aria-keyshortcuts="Control+n"><Plus size={16} strokeWidth={1.75} aria-hidden="true"  />{t("Import references")}</Button>
      </div>
    </div>
    <div className={styles.searchRow} data-no-drag>
      <div className={styles.searchField}><SearchField ref={searchRef} label={t("Search references")} value={query} busy={searching} onValueChange={onQueryChange} placeholder={t("Search references")} aria-keyshortcuts="Control+k" /></div>
      {collectionControls && <div className={styles.collectionControls}>{collectionControls}</div>}
      <div className={styles.viewActions}><ReferenceViewToggle value={view} onChange={onViewChange} /></div>
      {tagControls && <div className={styles.tagControls}>{tagControls}</div>}
      <div className={styles.sortAction}><ReferenceSortMenu value={sort} onChange={onSortChange} disabled={refreshing}/></div>
    </div>
  </header>;
}
