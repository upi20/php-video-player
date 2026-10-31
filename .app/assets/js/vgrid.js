// Virtual grid: only the cards near the screen exist in the DOM (plus a few rows above and
// below), however long the list is. The <ul> keeps its CSS grid layout (columns come from the
// stylesheet); two full-width spacers stand in for the rows that aren't rendered, so the
// scrollbar still spans the whole list. Every card must have the same height (see .vgrid).
const OVERSCAN_ROWS = 4;
const ESTIMATED_ROW = 320; // px, until a real card has been measured

/**
 * @param {HTMLElement} list  the grid <ul>
 * @param {object} opts
 * @param {(index: number) => string} opts.renderItem  inner HTML of the card at index
 * @param {(range: {start: number, end: number, first: number}) => void} [opts.onRange]
 *   called after every update: rendered items are [start, end), first is the top visible one
 * @param {() => number} [opts.inset]  px hidden under sticky bars at the top of the window
 */
export function createVirtualGrid(list, { renderItem, onRange, inset = () => 0 }) {
  const before = spacer();
  const after = spacer();
  list.replaceChildren(before, after);
  list.classList.add('vgrid');

  const els = new Map(); // index → <li>
  let count = 0;
  let cols = 1;
  let rowH = 0;
  let gap = 0;
  let start = 0;
  let end = 0;
  let anchor = null; // index to keep at the top while measurements settle
  let frame = 0;

  function spacer() {
    const li = document.createElement('li');
    li.className = 'vgrid-spacer';
    li.setAttribute('aria-hidden', 'true');
    return li;
  }

  function measureColumns() {
    const style = getComputedStyle(list);
    cols = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    gap = parseFloat(style.rowGap) || 0;
  }

  const rowHeight = () => rowH || ESTIMATED_ROW;
  // Page y of the first row: the list's top plus its own padding (the "before" spacer sits there).
  const gridTop = () => list.getBoundingClientRect().top + scrollY + (parseFloat(getComputedStyle(list).paddingTop) || 0);

  function firstVisible() {
    const row = Math.floor((scrollY + inset() - gridTop()) / rowHeight());
    return Math.min(Math.max(0, row * cols), Math.max(0, count - 1));
  }

  function update(force = false) {
    frame = 0;
    const rows = Math.ceil(count / cols);
    const top = scrollY + inset() - gridTop();
    const firstRow = Math.max(0, Math.floor(top / rowHeight()) - OVERSCAN_ROWS);
    const lastRow = Math.min(rows, Math.ceil((top + innerHeight) / rowHeight()) + OVERSCAN_ROWS);
    const nextStart = Math.min(firstRow * cols, count);
    const nextEnd = Math.min(lastRow * cols, count);

    if (force || nextStart !== start || nextEnd !== end) {
      start = nextStart;
      end = nextEnd;
      for (const [i, el] of els) {
        if (i < start || i >= end) {
          el.remove();
          els.delete(i);
        }
      }
      let prev = before;
      for (let i = start; i < end; i++) {
        let el = els.get(i);
        if (!el) {
          el = document.createElement('li');
          el.className = 'card-wrap';
          el.dataset.index = String(i);
          el.innerHTML = renderItem(i);
          els.set(i, el);
        }
        if (prev.nextSibling !== el) prev.after(el);
        prev = el;
      }
      // A spacer is a grid item too, so the row gap after it is already there: subtract one.
      setSpacer(before, Math.floor(start / cols) * rowHeight() - gap);
      setSpacer(after, (rows - Math.ceil(end / cols)) * rowHeight() - gap);
    }

    // Measure a real card; when the estimate was off, lay out again with the true height.
    const sample = els.get(start);
    if (sample) {
      const measured = sample.offsetHeight + gap;
      if (measured > 0 && Math.abs(measured - rowH) > 0.5) {
        rowH = measured;
        if (anchor !== null) scrollToIndex(anchor);
        update(true);
        return;
      }
      anchor = null;
    }
    onRange?.({ start, end, first: firstVisible() });
  }

  function setSpacer(el, px) {
    el.hidden = px <= 0;
    el.style.height = `${Math.max(0, px)}px`;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => update());
  }

  /** Scrolls so that the item at index is at the top, below the sticky bars. */
  function scrollToIndex(index) {
    anchor = index;
    const y = gridTop() + Math.floor(index / cols) * rowHeight() - inset();
    scrollTo({ top: Math.max(0, y), behavior: 'instant' });
    update(true);
  }

  addEventListener('scroll', schedule, { passive: true });
  // Column count and card size follow the list's width (its height changes all the time, with
  // the spacers, and is ignored): re-measure and keep the same video at the top.
  let width = 0;
  new ResizeObserver(([entry]) => {
    if (Math.abs(entry.contentRect.width - width) < 1) return;
    width = entry.contentRect.width;
    const keep = count ? firstVisible() : null;
    measureColumns();
    rowH = 0;
    if (keep !== null) scrollToIndex(keep);
  }).observe(list);
  measureColumns();

  return {
    /** Changes the number of items (the cards already shown are kept). */
    setCount(n) {
      count = n;
      update(true);
    },
    /** Re-renders the items in [from, to), e.g. after their data arrived. */
    refresh(from, to) {
      for (let i = from; i < to; i++) {
        const el = els.get(i);
        if (el) el.innerHTML = renderItem(i);
      }
    },
    /** Removes every card (e.g. when switching to another list). */
    clear() {
      for (const el of els.values()) el.remove();
      els.clear();
      count = 0;
      start = end = 0;
      update(true);
    },
    scrollToIndex,
    firstVisible,
  };
}
