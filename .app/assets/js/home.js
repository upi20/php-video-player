// Home page: a YouTube-style grid of every video, with sort chips and live search.
import {
  $, appData, escapeHtml, fmtAgo, fmtSize, highlight, matchesSearch, searchWords, sortVideos, store,
  thumbHtml, watchUrl,
} from './util.js';

const { videos } = appData;
const grid = $('grid');
const empty = $('empty');
const count = $('count');
const search = $('search');
const chips = document.querySelectorAll('[data-sort]');

let sort = store.get('sort', 'new');

function render() {
  const words = searchWords(search.value);
  const list = sortVideos(videos, sort).filter((v) => matchesSearch(v, words));

  grid.innerHTML = list.map((v) => {
    const meta = [v.height ? `${v.height}p` : null, fmtSize(v.size), fmtAgo(v.mtime)].filter(Boolean).join(' · ');
    return `<li>
      <a class="card" href="${watchUrl(v)}" title="${escapeHtml(v.title)}">
        <div class="thumb">${thumbHtml(v)}</div>
        <div class="card-body">
          <h3 class="card-title">${highlight(v.title, words)}</h3>
          <p class="card-meta">${meta}</p>
        </div>
      </a>
    </li>`;
  }).join('');

  empty.hidden = list.length > 0;
  empty.textContent = videos.length
    ? 'Tidak ada video yang cocok dengan pencarian.'
    : 'Belum ada video. Taruh file .mp4 / .webm di folder ini, lalu muat ulang halaman.';
  count.textContent = words.length ? `${list.length} dari ${videos.length}` : `${videos.length} video`;
  for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.sort === sort));
}

for (const chip of chips) {
  chip.addEventListener('click', () => {
    sort = chip.dataset.sort;
    store.set('sort', sort);
    render();
  });
}

// Live search; the query is kept in the URL so reloading or going back keeps it.
search.addEventListener('input', () => {
  const url = new URL(location.href);
  if (search.value.trim()) url.searchParams.set('q', search.value.trim());
  else url.searchParams.delete('q');
  history.replaceState(null, '', url);
  render();
});
search.form.addEventListener('submit', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.target.closest('input, select, textarea')) return;
  e.preventDefault();
  search.focus();
});

// Coming back from a video (back button / bfcache): refresh the watched bars.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) render();
});

render();
