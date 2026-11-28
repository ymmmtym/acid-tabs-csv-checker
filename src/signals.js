/** 複数の中断条件のうち、最初に成立したものを fetch の signal として使う。 */
export function combineSignals(...signals) {
  const list = signals.filter(Boolean);
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  // AbortSignal.any は Node.js 20.3.0 以降。宣言上の対応範囲（>=20）向けの代替実装。
  // 合成が成立した時点で元の signal からリスナーを外し、実行ごとに溜まらないようにする。
  const controller = new AbortController();
  const detach = [];
  const release = () => {
    for (const off of detach) off();
    detach.length = 0;
  };

  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    detach.push(() => signal.removeEventListener('abort', onAbort));
  }

  if (controller.signal.aborted) release();
  else controller.signal.addEventListener('abort', release, { once: true });

  return controller.signal;
}
