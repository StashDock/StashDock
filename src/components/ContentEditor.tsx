import { useI18n } from '../features/settings/locale';
import { useEffect, useState } from 'react';
import type { StashItem } from '../types';
import { editorContext, hasContextFile } from '../lib/context-format.mjs';
import { FluidDialog } from './FluidDialog';
import { Textarea } from './arc/textarea/textarea';
import { Button } from './arc/button/button';
import { Alert } from './arc/alert/alert';
import { ScrollArea } from './arc/scroll-area/scroll-area';
import SegmentedControl from './arc/segmented-control/segmented-control';
import { MarkdownPreview } from './MarkdownPreview';
import styles from './ReferenceEditor.module.css';

export function ContentEditor({ item, onClose, onSave, returnFocus }: { item: StashItem | null; onClose: () => void; onSave: (id: string, content: string) => Promise<void>; returnFocus?: React.RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (item) { setContent(editorContext(item)); setError(''); setSaved(false); setPreview(false); } }, [item?.id]);
  return <FluidDialog open={Boolean(item)} onClose={onClose} busy={busy} returnFocus={returnFocus} title={t("Edit content")} description={item?.title} size="wide">
    <form className={styles.form} onSubmit={event => {
      event.preventDefault(); if (!item || busy) return;
      setBusy(true); setError('');
      void onSave(item.id, content).then(() => { setSaved(true); onClose(); }).catch(error => setError(error instanceof Error ? error.message : 'Content could not be saved. Retry.')).finally(() => setBusy(false));
    }}>
      <div className={styles.contentField}>
        <Textarea label={t(item && hasContextFile(item) ? 'Supplemental context (optional)' : 'Context content')} labelAction={<div inert={busy}><SegmentedControl label={t('Content view')} size="sm" value={preview ? 'preview' : 'content'} onValueChange={value => { if (!busy) setPreview(value === 'preview'); }} options={[
          { value: 'content', label: t('Content') },
          { value: 'preview', label: t('Preview') },
        ]} /></div>} aria-hidden={preview || undefined} inert={preview} tabIndex={preview ? -1 : undefined} className={`${styles.contentArea} ${preview ? styles.obscuredContent : ''}`} value={content} onChange={event => setContent(event.target.value)} rows={14} disabled={busy} maxLength={200_000} spellCheck={false}
          controlOverlay={preview ? <ScrollArea className={styles.contentPreview} viewportClassName={styles.previewViewport} fade={0} label={t('Markdown preview')}><MarkdownPreview content={content} /></ScrollArea> : undefined} />
      </div>
      <Alert tone="danger" title={t("Content could not be saved")} open={Boolean(error)}>{t(error)}</Alert>
      <div className={styles.actions}><Button variant="secondary" type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" type="submit" loading={busy} disabled={saved}>{saved ? t("Saved") : t("Save changes")}</Button></div>
      <span className="sr-only" role="status">{saved ? t("Content saved") : ''}</span>
    </form>
  </FluidDialog>;
}
