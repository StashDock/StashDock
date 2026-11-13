import { useCallback, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '../../components/arc/button/button';
import { Alert } from '../../components/arc/alert/alert';
import { Skeleton } from '../../components/arc/skeleton/skeleton';
import { AppearanceFields, SettingsFrame, SettingsRow } from '../settings/SettingsParts';
import { StorageSection, type StorageInfo, type StorageServices, type StorageDestination } from '../settings/StorageSection';
import { IntegrationIcon } from '../settings/IntegrationIcon';
import { useI18n } from '../settings/locale';
import { useMcpSettings } from './settings';
import { errorText } from '../../lib/errorText';
import styles from '../settings/SettingsView.module.css';
import { IntegrationSections } from '../settings/IntegrationSections';
import { GitHubMark } from '../settings/GitHubMark';
import { UpdateDialog, versionLabel, type UpdateInfo } from '../settings/UpdateDialog';
import type { IntegrationInfo } from '../settings/integrations';

export default function McpSettingsView({ onClose, onOpenLink, onLibraryMoved, dsh }: { onClose: () => void; onOpenLink: (url: string) => Promise<unknown>; onLibraryMoved: () => void; dsh: boolean }) {
  const { info, loading, pending, error, reload, save, call } = useMcpSettings();
  const product = dsh ? 'StashDock for DeepSeek Harness' : 'StashDock for ChatGPT';
  const loadIntegrations = useCallback(async () => (await call('get_stashdock_integrations')).integrations as IntegrationInfo, [call]);
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [operationError, setOperationError] = useState(''), [checkingUpdates, setCheckingUpdates] = useState(false);
  const checkUpdates = useCallback(async () => (await call('check_stashdock_plugin_updates', {}, 20_000)).update as UpdateInfo, [call]);
  const storageServices = useMemo<StorageServices>(() => ({
    read: async () => (await call('get_stashdock_storage_info')).storage as StorageInfo,
    open: () => call('open_stashdock_storage_folder'),
    choose: async () => ((await call('choose_stashdock_storage_location', { title: t('Choose an empty folder') }, 300_000)).destination ?? null) as StorageDestination | null,
    move: destination => call('move_stashdock_storage', { token: destination.token }, 660_000),
  }), [call, t]);
  return <SettingsFrame onClose={onClose} loading={loading} busy={busy}>
    {loading ? <Skeleton label={t('Settings')} lines={4} /> : !info ? <Alert tone="danger" title={t('Settings could not be loaded')}><span>{t(error)}</span><Button variant="secondary" onClick={() => void reload()}>{t('Retry')}</Button></Alert> : <>
      <section className={styles.section} aria-labelledby="settings-general"><h2 id="settings-general">{t('General')}</h2><div className={styles.group}><AppearanceFields preferences={info.preferences} disabled={pending || busy} host onSave={save} /></div><Alert tone="danger" title={t('Settings could not be saved')} open={Boolean(error)}>{t(error)}</Alert></section>
      <StorageSection services={storageServices} onBusyChange={setBusy} onMoved={onLibraryMoved} />
      <IntegrationSections host="codex" load={loadIntegrations} openLink={onOpenLink} openApp={id => call('open_stashdock_integration', { id }, 45_000)} disabled={busy} />
      <section className={styles.section} aria-labelledby="settings-about"><h2 id="settings-about">{t('About')}</h2><div className={styles.group}>
        <SettingsRow title={product} meta={versionLabel(info.version)} icon={<IntegrationIcon id={dsh ? 'desktop' : 'codex'} />}><Button variant="secondary" size="sm" disabled={busy} onClick={() => setCheckingUpdates(true)}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />{t('Check for updates')}</Button></SettingsRow>
        {info.githubUrl && <SettingsRow title="GitHub" icon={<GitHubMark />}><Button variant="ghost" size="sm" onClick={() => { setOperationError(''); void onOpenLink(info.githubUrl!).catch(reason => setOperationError(errorText(reason))); }}>{t('Open')}<ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" /></Button></SettingsRow>}
      </div><Alert tone="danger" title={t('Try again.')} open={Boolean(operationError)}>{t(operationError)}</Alert></section>
      <UpdateDialog open={checkingUpdates} product={product} version={info.version} check={checkUpdates} onClose={() => setCheckingUpdates(false)} openLink={onOpenLink} />
    </>}
  </SettingsFrame>;
}
