/* 히어로 스크롤-스크럽: 스크롤 위치가 15초 필름의 재생 시점을 결정한다.
   프로그레시브 인핸스먼트 — 이 스크립트가 실행되지 않으면(구형 브라우저,
   reduced-motion, JS 꺼짐) 히어로는 정적 포스터로 그대로 동작한다. */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hero = document.querySelector('.hero');
  var stage = document.querySelector('.hero-stage');
  if (!hero || !stage || reduce || !window.requestAnimationFrame || !window.fetch) return;

  var coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  var small = window.matchMedia('(max-width: 860px)');
  var isMobile = coarse || small.matches;
  var src = isMobile ? 'assets/media/hero-scrub-mobile.mp4' : 'assets/media/hero-scrub.mp4';
  var eps = isMobile ? 0.02 : 0.008;

  var video = null;
  var ready = false;
  var current = 0;
  var target = 0;
  var rootTop = 0;
  var total = 1;
  var primed = false;
  var lastW = window.innerWidth;

  /* 챕터: 시작 지점은 각 .chapter의 data-at(필름 비트)에서 읽는다 —
     타이밍이 마크업과 함께 살아서 챕터 추가·필름 재편집 시 어긋나지 않음 */
  var chapters = stage.querySelectorAll('.chapter');
  var bounds = [];
  chapters.forEach(function (ch, i) {
    var at = parseFloat(ch.dataset.at);
    bounds.push(isNaN(at) ? (i / Math.max(chapters.length, 1)) : at);
  });
  var activeCh = 0;
  var routeBtns = stage.querySelectorAll('.route button');
  var stopped = false;

  /* 마지막 챕터(Say hi)의 링크는 첫 챕터 nav를 복제 — 원본 한 벌만 관리 */
  var lastCh = chapters[chapters.length - 1];
  var firstNav = stage.querySelector('.chapter .links');
  if (lastCh && firstNav && !lastCh.querySelector('.links')) {
    lastCh.appendChild(firstNav.cloneNode(true));
  }

  function setChapter(i) {
    if (i === activeCh || !chapters[i]) return;
    if (chapters[activeCh]) chapters[activeCh].classList.remove('on');
    chapters[i].classList.add('on');
    if (routeBtns[activeCh]) routeBtns[activeCh].removeAttribute('aria-current');
    if (routeBtns[i]) routeBtns[i].setAttribute('aria-current', 'step');
    activeCh = i;
  }

  routeBtns.forEach(function (btn, i) {
    btn.addEventListener('click', function () {
      /* 챕터 시작점보다 살짝 안쪽으로 점프 */
      var p = Math.min(bounds[i] + 0.04, 0.999);
      window.scrollTo({ top: rootTop + p * total, behavior: 'smooth' });
    });
  });
  if (routeBtns[0]) routeBtns[0].setAttribute('aria-current', 'step');

  function layout() {
    var pageY = window.scrollY || window.pageYOffset;
    rootTop = hero.getBoundingClientRect().top + pageY;
    total = Math.max(hero.offsetHeight - window.innerHeight, 1);
  }

  /* iOS는 사용자 제스처로 play()를 한 번 통과시켜야 seek 프레임을 그린다 */
  function prime() {
    if (!video || !isMobile) return;
    var p = video.play();
    if (p && p.then) p.then(function () { video.pause(); }).catch(function () {});
  }

  function load() {
    /* Blob으로 통째로 받아야 시킹이 범위 요청 없이 즉각 반응한다 */
    fetch(src).then(function (r) {
      if (!r.ok) throw new Error('clip ' + r.status);
      return r.blob();
    }).then(function (blob) {
      video = document.createElement('video');
      video.className = 'scrub-video';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.src = URL.createObjectURL(blob);
      video.addEventListener('loadedmetadata', function () { ready = true; });
      video.addEventListener('seeked', function onSeek() {
        stage.setAttribute('data-video-painted', 'true');
        video.removeEventListener('seeked', onSeek);
      });
      video.addEventListener('error', function () {
        stage.removeAttribute('data-video-painted');
        video.remove();
        video = null;
        bail();
      });
      stage.insertBefore(video, stage.querySelector('.inner'));
      if (primed) prime();
    }).catch(bail);
  }

  /* 필름을 못 받으면 스크럽을 접고 일반(정적) 히어로로 복귀 —
     포스터 위를 380vh 스크롤하게 두지 않는다 */
  function bail() {
    stopped = true;
    document.documentElement.classList.remove('scrub-on');
    hero.style.removeProperty('--scrub-progress');
    ready = false;
    setChapter(0);
    layout();
  }

  function tick() {
    if (stopped) return; /* bail 이후 루프 종료 — 스타일 재설정 없음 */
    var y = (window.scrollY || window.pageYOffset) - rootTop;
    target = Math.min(1, Math.max(0, y / total));
    /* 히어로를 한 화면 이상 지나면 시킹·챕터 연산을 쉰다 */
    if (y > total + window.innerHeight) {
      window.requestAnimationFrame(tick);
      return;
    }
    if (video && ready && !video.seeking) {
      current += (target - current) * 0.2;
      var t = Math.min(0.999, Math.max(0, current)) * (video.duration || 1);
      if (Math.abs(video.currentTime - t) > eps) {
        try { video.currentTime = t; } catch (e) { /* 다음 프레임에 재시도 */ }
      }
    }
    /* 챕터는 필름이 실제 따라가는 완화값(current)에 동기화 —
       빠른 점프에서 카피가 필름을 앞서가지 않고, 필름 로드 전에는 전환하지 않는다 */
    if (chapters.length > 1 && video && ready) {
      var ch = 0;
      for (var k = 1; k < bounds.length && k < chapters.length; k++) {
        if (current >= bounds[k]) ch = k;
      }
      setChapter(ch);
    }
    hero.style.setProperty('--scrub-progress', target.toFixed(4));
    window.requestAnimationFrame(tick);
  }

  function onFirstGesture() {
    primed = true;
    prime();
  }

  document.documentElement.classList.add('scrub-on');
  layout();

  window.addEventListener('resize', function () {
    /* iOS 주소창 수축으로 인한 높이만 변한 resize는 무시 */
    if (coarse && window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    layout();
  });
  window.addEventListener('orientationchange', layout);
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  /* LCP(포스터)와 경쟁하지 않도록 로드 완료 후 필름을 받는다 */
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load);

  window.requestAnimationFrame(tick);
})();
