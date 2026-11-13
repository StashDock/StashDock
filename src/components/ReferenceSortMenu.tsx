import { ArrowDownWideNarrow } from 'lucide-react';
import { Button } from './arc/button/button';
import { DropdownMenu } from './arc/dropdown-menu/dropdown-menu';
import { useI18n } from '../features/settings/locale';
import type { ReferenceSort } from '../lib/reference-sort.mjs';

export function ReferenceSortMenu({ value, onChange, disabled = false }: {
  value: ReferenceSort; onChange: (sort: ReferenceSort) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const options: [ReferenceSort, string][] = [['newest', 'Recently added'], ['oldest', 'Oldest first'], ['most-used', 'Most used']];
  return <DropdownMenu label={t('Sort references')} trigger={<Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={t('Sort references')}><ArrowDownWideNarrow size={16} strokeWidth={1.75} aria-hidden="true"/></Button>} items={options.map(([sort, label]) => ({ label: t(label), checked: value === sort, onSelect: () => { if (sort !== value) onChange(sort); } }))}/>;
}
