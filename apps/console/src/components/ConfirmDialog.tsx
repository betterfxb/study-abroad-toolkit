/**
 * 通用二次确认弹窗 —— 删除等不可逆操作前拦一道。
 * antd Modal 实现，对外 API 不变（title/text/okText/danger/onCancel/onConfirm）。
 */

import { useEffect, useState } from 'react';
import { Modal } from 'antd';

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

  // Esc 关闭（antd Modal 自带，busy 时拦截）
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
    <Modal
      open
      title={title}
      onCancel={() => { if (!busy) onCancel(); }}
      mask={{ closable: !busy }}
      keyboard={!busy}
      footer={[
        <button key="cancel" className="btn" onClick={onCancel} disabled={busy}>取消</button>,
        <button
          key="ok"
          className={`btn ${danger ? 'danger' : 'primary'}`}
          onClick={() => void go()}
          disabled={busy}
        >
          {busy ? '处理中…' : okText}
        </button>,
      ]}
    >
      <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.7 }}>{text}</div>
    </Modal>
  );
}
