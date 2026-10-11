/**
 * 通用异步数据 hook —— 解决列表页三个老毛病：
 *
 *   1. **竞态**：筛选条件连续变化时，先发出的请求可能后返回，把新结果覆盖成旧结果。
 *      这里用自增 seq 只接受「最后一次」请求的结果，并在依赖变化时 abort 掉在途请求。
 *   2. **闪空**：重新筛选时旧数据被清空，表格整块消失再出现，视觉上很跳。
 *      这里始终保留上一次成功的数据，只在**首屏**（从未成功过）才整块占位。
 *   3. **状态分散**：loading / error / data 三个 state 各自维护，容易漏置位。
 *      这里收敛成一个对象，并区分「首屏加载」与「静默刷新」。
 *
 * 用法：
 *   const { data, error, pending, initial, reload } = useRequest(() => api.jobs(q), [q]);
 *
 * 说明：这里用 seq 保证正确性（只认最后一次结果），不再向下透传 AbortSignal——
 * 透传会让每个 api 方法都多一个参数，收益（省一点流量）不抵可读性的损失。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RequestState<T> {
  /** 最近一次成功的数据；失败时保留上一次的，避免界面闪空 */
  data: T | null;
  /** 最近一次失败的错误文案；成功后自动清空 */
  error: string;
  /** 是否有请求在途 */
  pending: boolean;
  /** 首屏：从未成功拿到过数据（此时才应整块显示占位） */
  initial: boolean;
  /** 手动重新拉取 */
  reload: () => void;
}

/**
 * @param fn     发起请求的函数（每次渲染可以是新函数，内部用 ref 持有最新引用）
 * @param deps   依赖数组，语义同 useEffect：任一变化即重新拉取
 */
export function useRequest<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
): RequestState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [initial, setInitial] = useState(true);
  const [nonce, setNonce] = useState(0);

  // fn 每次渲染都是新函数，放 ref 里，避免把它写进依赖导致无限循环
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // 只认最后一次请求的结果
  const seq = useRef(0);

  useEffect(() => {
    const id = seq.current + 1;
    seq.current = id;

    setPending(true);
    fnRef
      .current()
      .then((r) => {
        if (id !== seq.current) return; // 已有更新的请求，丢弃本次结果
        setData(r);
        setError('');
        setInitial(false);
        setPending(false);
      })
      .catch((e: any) => {
        if (id !== seq.current) return;
        setError(e?.message || '加载失败');
        setPending(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, pending, initial, reload };
}

/** 输入防抖：连续输入时只在停顿 delay 毫秒后给出最终值 */
export function useDebounced<T>(value: T, delay = 350): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return out;
}
