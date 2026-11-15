import { useState } from 'react';
import { useT } from '../i18n';

/** 右上角的“数据检查”：列出读入数据时发现的问题。数据完全正确时不显示。 */
export default function DataCheck({ warnings }: { warnings: string[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (warnings.length === 0) return null;
  return (
    <div className="dcheck">
      <button className="btn dcheck-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        ⚠ {t('dataCheck')} <b>{warnings.length}</b>
      </button>
      {open && (
        <div className="dcheck-pop glass" role="dialog">
          <p>{t('dataCheckHint')}</p>
          <ol>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
