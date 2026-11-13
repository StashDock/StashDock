import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import githubMark from '../../assets/brands/github.svg?inline';
import { Button } from '../../components/arc/button/button';
import { Alert } from '../../components/arc/alert/alert';
import { useCopyFeedback } from '../../components/arc/lib/use-copy-feedback';
import copyStyles from '../../components/CopyForAI.module.css';
import { IntegrationIcon } from './IntegrationIcon';
import { applicationWebsite, githubUrl, installationUrl, integrationCatalog, integrationGuides, referencePurpose, safariSetupSteps, aiSetupSteps, type IntegrationId, type IntegrationInfo } from './integrations';
import { useI18n } from './locale';
import styles from './IntegrationSections.module.css';
import { errorText } from '../../lib/errorText';

export function IntegrationGuide({ id, kind, info, openApp, openLink }: { id: IntegrationId; kind: 'usage' | 'setup'; info: IntegrationInfo | null; openApp?: (id: IntegrationId) => Promise<unknown>; openLink: (url: string) => Promise<unknown> }) {
  const { t } = useI18n();
  const entry = integrationCatalog[id], usage = kind === 'usage' ? integrationGuides[id] : null;
  const ai = id === 'codex' || id === 'dsh' || id === 'claude';
  const repository = githubUrl(info), install = ai ? null : installationUrl(info, id), copy = useCopyFeedback();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const alive = useRef(false), flight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const bundledSafari = id === 'safari' && info?.platform === 'macos';
  const canOpen = Boolean(applicationWebsite(id) || info?.items.some(item => item.id === id && item.detected) || install || repository);
  const steps = usage?.steps ?? (bundledSafari ? safariSetupSteps : ai ? aiSetupSteps
    : id === 'chrome' ? ['Open the Chrome Web Store below.', 'Click Add to Chrome, then confirm with Add extension.', 'Pin StashDock, then open a page and click it to save.']
    : id === 'desktop' ? ['Get StashDock Desktop from the link below.', 'Open the app after installation.', 'Click Import references to add a link, file or note.']
    : ['Get the browser extension from the link below.', 'Install the extension in {name}.', 'Open a page and click StashDock to save it.']);
  async function run(task: () => Promise<unknown>) {
    if (flight.current) return;
    flight.current = true; setPending(true); setError('');
    try { await task(); } catch (reason) { if (alive.current) setError(errorText(reason)); }
    finally { flight.current = false; if (alive.current) setPending(false); }
  }
  return <div className={styles.guide}>
    <p>{usage ? t(usage.description) : t(bundledSafari ? 'The Safari extension is included with StashDock Desktop for Mac.' : ai || id === 'desktop' ? referencePurpose : 'Install the extension to save pages from {name}.', { name: entry.name })}</p>
    <ol className={styles.steps}>{steps.map(step => <li key={step}>{t(step, { name: entry.name })}</li>)}</ol>
    <Alert tone="danger" title={t('Try again.')} open={Boolean(error) || copy.state === 'error'}>{t(error || 'Clipboard access was blocked. Try again from the active window.')}</Alert>
    <div className={styles.footer}>
      {kind === 'setup' && !bundledSafari && (install ? <Button variant="secondary" disabled={pending} onClick={() => void run(() => openLink(install))}>{t(id === 'chrome' ? 'Open Chrome Web Store' : 'Open installation page')}<ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
        : <Button variant={copy.state === 'copied' ? 'primary' : 'secondary'} className={copy.state === 'copied' ? copyStyles.success : undefined} disabled={!repository || pending} aria-label={t('Copy GitHub link')} data-tooltip={!repository ? t('GitHub link coming soon.') : undefined} onClick={() => { if (repository) void copy.copy(repository); }}>{copy.state === 'copied' ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <img src={githubMark} className={styles.githubIcon} alt="" width={16} height={16} aria-hidden="true" />}{t(copy.state === 'copied' ? 'Copied' : 'Copy')}</Button>)}
      <Button variant="primary" loading={pending} disabled={!canOpen} aria-label={t('Open {name}', { name: entry.name })} data-tooltip={!canOpen ? t('Desktop download link coming soon.') : undefined} onClick={() => void run(async () => { if (openApp) await openApp(id); else { const url = applicationWebsite(id) || install || repository; if (!url) throw Error('The app could not be opened. Try again.'); await openLink(url); } })}><IntegrationIcon id={id} />{t('Open {name}', { name: entry.name })}</Button>
    </div>
    <span className={styles.srOnly} role="status">{copy.state === 'copied' ? t('Copied') : ''}</span>
  </div>;
}
