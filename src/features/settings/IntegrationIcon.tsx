import chrome from '../../assets/brands/chrome.svg?inline';
import edge from '../../assets/brands/edge.svg?inline';
import firefox from '../../assets/brands/firefox.svg?inline';
import safari from '../../assets/brands/safari.svg?inline';
import codex from '../../assets/brands/chatgpt.svg?inline';
import claude from '../../assets/brands/claude.svg?inline';
import dsh from '../../assets/brands/deepseek.svg?inline';
import desktop from '../../../assets/brand/icon.svg?inline';
import type { IntegrationId } from './integrations';
import styles from './IntegrationSections.module.css';
const marks = { chrome, edge, firefox, safari, codex, dsh, claude, desktop };
export function IntegrationIcon({ id }: { id: IntegrationId }) {
  return <img src={marks[id]} className={styles.icon} data-integration-icon={id} alt="" width={24} height={24} aria-hidden="true" />;
}
