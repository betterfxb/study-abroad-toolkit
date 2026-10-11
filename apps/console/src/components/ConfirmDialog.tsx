/**
 * 通用二次确认弹窗 —— 删除等不可逆操作前拦一道。
 *
 * 之前「删除订阅」是点一下直接删掉且无任何拦截，误触即丢数据；
 * 这里统一成受控组件，样式复用既有 .modal* 类，不引入新依赖。
 */

import { useEffect, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  /** 正文说明，建议写清后果 */
  text: string;
  /** 确认按钮文案，默认「确认」 */
  okText?: string;
  /** 危险操作（红按钮） */
  danger?: boolean;
}

interface Props extends ConfirmOptions {
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  title, text, okText = '确认', danger = false, onCancel, onConfirm,
}: Props) {
  const [busy, setBusy] = useState(false);

  // Esc 关闭，与既有弹窗习惯一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          {title}
          <button className="x" onClick={onCancel} disabled={busy}>×</button>
        </div>
        <div className="modal-b">
          <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.7 }}>{text}</div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => void go()} disabled={busy}>
            {busy ? '处理中…' : okText}
          </button>
        </div>
      </div>
    </div>
  );
}
