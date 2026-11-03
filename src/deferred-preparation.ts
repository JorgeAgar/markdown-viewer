import type { DocumentWork } from './work-scheduler';

/** Small DOM batches, using the existing document scope for pause/cancellation. */
export function deferredPreparation(
  root: HTMLElement, work: DocumentWork, valid: () => boolean,
  steps: () => Generator<void>, pause: () => Promise<void>,
): () => void {
  let started = false;
  return () => {
    if (started || !valid()) return;
    started = true;
    void (async () => {
      // Create the iterator only once this document can start work.
      let iterator: Generator<void> | undefined;
      let done: boolean | undefined;
      do {
        done = await work.run('render', root, valid, () => {
          const measured = root.dataset.measurePreparation === 'true';
          const start = measured ? performance.now() : 0;
          iterator ??= steps();
          let result: IteratorResult<void>;
          // Bound mutation work independently of renderer limits. Selector lookup
          // itself is native and remains one operation, after the text opportunity.
          for (let count = 0; count < 32; count++) {
            result = iterator.next();
            if (result.done) break;
          }
          if (measured) root.dataset.deferredPreparationMs =
            (Number(root.dataset.deferredPreparationMs || 0) + performance.now() - start).toFixed(2);
          return result!.done ?? false;
        });
        if (done === undefined || !valid()) return;
        if (!done) await pause();
      } while (!done);
    })();
  };
}
