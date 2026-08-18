const CATS = {
  dev:     { en: 'Dev',     ko: '개발' },
  music:   { en: 'Music',   ko: '음악' },
  content: { en: 'Content', ko: '콘텐츠' }
};

// localStorage는 차단된 환경에서 접근만으로 throw할 수 있음
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }
};

let lang = store.get('lang') ||
           (navigator.language && navigator.language.startsWith('ko') ? 'ko' : 'en');
let projects = [];
let activeCat = 'all';
let loadFailed = false;

const t = v => (v && typeof v === 'object') ? (v[lang] ?? v.en) : (v ?? '');

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-ko]').forEach(el => {
    if (!el.dataset.en) el.dataset.en = el.innerHTML; // 마크업의 영어 원문 보존
    el.innerHTML = lang === 'ko' ? el.dataset.ko : el.dataset.en;
  });
  const sw = document.getElementById('langsw');
  sw.innerHTML = lang === 'en'
    ? '<span class="cur">en</span><span class="alt">ko</span>'
    : '<span class="alt">en</span><span class="cur">ko</span>';
  renderWork();
}

function renderWork() {
  renderFilters();
  renderProjects();
}

function renderFilters() {
  const wrap = document.getElementById('filters');
  const cats = [...new Set(projects.map(p => p.category))];
  wrap.hidden = cats.length < 2; // CSS의 .filters[hidden] 규칙과 한 쌍
  wrap.innerHTML = '';
  if (wrap.hidden) return;
  const known = Object.keys(CATS).filter(c => cats.includes(c));
  const unknown = cats.filter(c => !CATS[c]); // 미등록 카테고리도 버튼 생성
  ['all', ...known, ...unknown].forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c === 'all' ? (lang === 'ko' ? '전체' : 'All') : (CATS[c] ? CATS[c][lang] : c);
    if (c === activeCat) b.className = 'on';
    b.addEventListener('click', () => { activeCat = c; renderWork(); });
    wrap.appendChild(b);
  });
}

function renderProjects() {
  const grid = document.getElementById('grid');
  grid.textContent = '';
  if (loadFailed) {
    const p = document.createElement('p');
    p.className = 'load-error';
    p.textContent = lang === 'ko'
      ? '프로젝트 목록을 불러오지 못했습니다.'
      : 'Could not load the project list.';
    grid.appendChild(p);
    return;
  }
  projects
    .filter(p => activeCat === 'all' || p.category === activeCat)
    .forEach(p => {
      const links = p.links || {};
      const href = links.site || links.github || links.youtube || links.telegram;
      const external = href && /^https?:/.test(href);

      const card = document.createElement('article');
      card.className = 'proj';

      const thumb = document.createElement('div');
      thumb.className = 'thumb' + (p.image ? '' : ' ph');
      if (p.image) {
        const img = document.createElement('img');
        img.src = p.image;
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'body';

      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = p.status || '';

      const h3 = document.createElement('h3');
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        if (external) { a.target = '_blank'; a.rel = 'noopener'; } // 내부 글은 같은 탭

        a.textContent = t(p.title) + ' ';
        const ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = external ? '↗' : '→'; // 내부 글은 이동 화살표
        a.appendChild(ext);
        h3.appendChild(a);
      } else {
        h3.textContent = t(p.title);
      }

      const desc = document.createElement('p');
      desc.textContent = t(p.desc);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = (p.tags || []).join(' · ');

      body.append(status, h3, desc, meta);
      card.append(thumb, body);
      grid.appendChild(card);
    });
}

document.getElementById('langsw').addEventListener('click', () => {
  lang = lang === 'en' ? 'ko' : 'en';
  store.set('lang', lang);
  applyLang();
});

applyLang(); // 정적 문구는 네트워크와 무관하게 즉시 적용

fetch('data/portfolio.json')
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(d => { projects = Array.isArray(d.projects) ? d.projects : []; renderWork(); })
  .catch(() => { loadFailed = true; renderWork(); });
