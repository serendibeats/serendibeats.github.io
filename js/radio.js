/* 크레이트 라디오: 우상단 on air를 누르면 rekordbox 크레이트에서 뽑은
   랜덤 트랙의 30초 프리뷰(iTunes)가 니들 드랍처럼 이어진다.
   프로그레시브 인핸스먼트 — 이 스크립트가 없으면 칩 자체가 나타나지 않는다.
   previewUrl은 재생 시점에 lookup으로 해석한다 (URL 만료 대비). */
(function () {
  if (!window.fetch || !window.Promise) return;
  var corner = document.getElementById('corner');
  var chip = document.getElementById('chip');
  var tgl = document.getElementById('radio-tgl');
  var np = document.getElementById('radio-np');
  var out = document.getElementById('radio-out');
  var ann = document.getElementById('radio-ann');
  if (!corner || !chip || !tgl) return;

  chip.hidden = false;
  var divider = corner.querySelector('.div');
  if (divider) divider.hidden = false;

  var audio = null;        /* 제스처 시점에 생성·언락해 재사용 — iOS 연속 재생 조건 */
  var pool = null;
  var poolReq = null;
  var cache = {};          /* itunes id → {p: previewUrl, u: trackViewUrl} */
  var queue = [], qi = -1, on = false;
  var fadeTimer = null, fadingOut = false;
  var gen = 0;             /* 세대 토큰 — stale 비동기 콜백 차단 */
  var failedGen = -1;      /* 한 트랙의 실패 이중 계수 방지 */
  var fails = 0;           /* 연속 실패 카운터 */
  var MAXFAILS = 8;
  var canFade = true;      /* iOS는 volume 제어 불가 — 감지해서 페이드 생략 */
  var mutedMode = false;   /* 소리 자동재생 차단 시: 음소거로 먼저 방송 시작, 첫 제스처에 unmute */
  var FORCE_MUTED = /[?&]radio=muted/.test(location.search); /* 기기 테스트용 강제 경로 */

  /* 명시적으로 끈 선택은 이번 방문(세션)에서만 기억 — 새 방문엔 다시 자동 개국.
     (영구 기억은 소유자·재방문자의 "기본 켜짐" 의도와 충돌해서 세션 한정으로 변경) */
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  };

  /* 44.1kHz 모노 16bit 1샘플 무음 WAV — 첫 제스처에서 재생해 엘리먼트를 언락 */
  function silentWav() {
    var s = 'RIFF&\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0D\xac\0\0\x88X\x01\0\x02\0\x10\0data\x02\0\0\0\0\0';
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }

  function ready() {
    if (pool) return Promise.resolve(pool);
    if (!poolReq) {
      poolReq = fetch('data/radio.json')
        .then(function (r) { if (!r.ok) throw new Error('radio ' + r.status); return r.json(); })
        .then(function (d) { pool = Array.isArray(d.tracks) ? d.tracks : []; return pool; })
        .catch(function (e) { poolReq = null; throw e; }); /* 다음 클릭에서 재시도 */
    }
    return poolReq;
  }

  function resolve(d) {
    if (cache[d.id]) return Promise.resolve(cache[d.id]);
    return fetch('https://itunes.apple.com/lookup?id=' + d.id)
      .then(function (r) { if (!r.ok) throw new Error('lookup ' + r.status); return r.json(); })
      .then(function (j) {
        var res = j.results && j.results[0];
        if (!res || !res.previewUrl) throw new Error('no preview');
        cache[d.id] = { p: res.previewUrl, u: res.trackViewUrl || 'https://music.apple.com' };
        return cache[d.id];
      });
  }

  /* 가중 셔플: w<1인 트랙(오픈포맷 팝)은 사이클마다 확률 포함 + 같은 장르 연속 방지 */
  function shuffle() {
    var arr = pool.filter(function (t) { return !t.w || Math.random() < t.w; });
    if (!arr.length) arr = pool.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    for (var k = 1; k < arr.length; k++) {
      if (arr[k].g === arr[k - 1].g) {
        for (var m = k + 1; m < arr.length; m++) {
          if (arr[m].g !== arr[k - 1].g) { var s = arr[k]; arr[k] = arr[m]; arr[m] = s; break; }
        }
      }
    }
    return arr;
  }

  function fadeTo(vol, ms, done) {
    clearInterval(fadeTimer);
    if (!canFade || Math.abs(vol - audio.volume) < 0.01) {
      try { audio.volume = vol; } catch (e) { /* 무시 */ }
      if (done) done();
      return;
    }
    var step = (vol - audio.volume) / Math.max(ms / 50, 1);
    fadeTimer = setInterval(function () {
      var v = audio.volume + step;
      if ((step > 0 && v >= vol) || (step < 0 && v <= vol)) {
        try { audio.volume = vol; } catch (e) { /* 무시 */ }
        clearInterval(fadeTimer);
        if (done) done();
      } else {
        try { audio.volume = v; } catch (e) { /* 무시 */ }
      }
    }, 50);
  }

  function refreshTrunc() {
    var truncated = np.scrollWidth > np.clientWidth + 1;
    np.classList.toggle('trunc', truncated);
    var shift = np.clientWidth - np.scrollWidth;
    np.style.setProperty('--shift', shift + 'px');
    /* 이동 거리 비례 속도(~22px/s 왕복 왕환), 최소 6초 — 길수록 천천히 */
    np.style.setProperty('--mdur', Math.max(6, Math.round(Math.abs(shift) / 22 * 3)) + 's');
  }

  function caption(d) {
    np.textContent = '';
    var inSpan = document.createElement('span');
    inSpan.className = 'in';
    var b = document.createElement('b');
    b.textContent = d.a + ' — ' + d.t;
    inSpan.appendChild(b);
    inSpan.appendChild(document.createTextNode(' · ' + d.m));
    np.appendChild(inSpan);
    refreshTrunc();
  }

  function fail(g) {
    if (g === failedGen) return;
    failedGen = g;
    fails++;
    if (fails >= MAXFAILS) {
      stopRadio();
      ann.textContent = 'crate radio unavailable';
      return;
    }
    next();
  }

  function play(i) {
    qi = i;
    var d = queue[qi];
    if (!d) return;
    var g = ++gen;
    fadingOut = false;
    caption(d);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: d.t, artist: d.a }); } catch (e) { /* 무시 */ }
    }
    resolve(d).then(function (r) {
      if (g !== gen || !on) return;
      out.href = r.u;
      try { audio.volume = canFade ? 0 : 1; } catch (e) { /* 무시 */ }
      audio.muted = mutedMode;
      audio.src = r.p;
      return audio.play().then(function () {
        if (g !== gen || !on) return;
        fails = 0;
        fadeTo(1, 800);
      });
    }).catch(function (err) {
      if (g !== gen || !on) return;
      if (err && err.name === 'NotAllowedError') {
        /* 자동재생 정책 거부 — 트랙 실패가 아니므로 조용히 접고 다음 제스처를 기다린다 */
        stopRadio(false);
        armGesture();
        return;
      }
      fail(g);
    });
  }

  function next() {
    if (!queue.length) return;
    var last = queue[qi];
    qi++;
    if (qi >= queue.length) {
      queue = shuffle();
      if (!queue.length) return;
      /* 리셔플 경계에서 같은 곡 연속 방지 */
      if (last && queue[0].id === last.id && queue.length > 1) {
        var t = queue[0]; queue[0] = queue[1]; queue[1] = t;
      }
      qi = 0;
    }
    play(qi);
  }

  function start(auto) {
    disarmGesture();
    killHint();
    if (!auto) store.set('radio', 'on');
    if (!audio) {
      audio = new Audio();
      audio.src = silentWav();          /* 제스처 안의 무음 재생 = 언락 */
      audio.play().catch(function () { /* 무시 */ });
      try { audio.volume = 0.5; canFade = audio.volume < 0.9; audio.volume = 1; } catch (e) { canFade = false; }
      audio.addEventListener('ended', function () { if (on) next(); });
      audio.addEventListener('timeupdate', function () {
        if (!on || !audio.duration) return;
        if (canFade && !fadingOut && audio.duration - audio.currentTime < 2) {
          fadingOut = true;
          fadeTo(0, 1800);
        }
      });
      audio.addEventListener('error', function () { if (on && queue.length) fail(gen); });
      if ('mediaSession' in navigator) {
        try { navigator.mediaSession.setActionHandler('nexttrack', function () { if (on) next(); }); } catch (e) { /* 무시 */ }
      }
    }
    on = true;
    fails = 0;
    chip.classList.add('playing');
    corner.classList.add('live');
    tgl.setAttribute('aria-pressed', 'true');
    ready().then(function () {
      if (!on) return;
      if (!pool.length) throw new Error('empty pool');
      if (!queue.length) queue = shuffle(); /* 예열된 큐가 있으면 그대로 (첫 곡 lookup 캐시 적중) */
      qi = -1;
      next();
      if (!auto) ann.textContent = 'on air — ' + np.textContent; /* 자동 시작은 SR에 침묵 */
    }).catch(function () {
      if (!on) return;
      stopRadio(false);
      ann.textContent = 'crate radio unavailable';
    });
  }

  function unmute(userInitiated) {
    mutedMode = false;
    chip.classList.remove('muted');
    if (userInitiated) store.set('radio', 'on');
    if (audio) { try { audio.muted = false; } catch (e) { /* 무시 */ } }
  }

  function stopRadio(userInitiated) {
    if (userInitiated) store.set('radio', 'off');
    mutedMode = false;
    chip.classList.remove('muted');
    on = false;
    gen++;                              /* 진행 중이던 모든 비동기 무효화 */
    clearInterval(fadeTimer);
    if (audio) {
      if (canFade) {
        fadeTo(0, 350, function () { if (!on) audio.pause(); });
        setTimeout(function () { if (!on) audio.pause(); }, 600); /* pause 보장 백스톱 */
      } else {
        audio.pause();
      }
    }
    chip.classList.remove('playing');
    corner.classList.remove('live');
    tgl.setAttribute('aria-pressed', 'false');
  }

  tgl.addEventListener('click', function () {
    if (on && mutedMode) { unmute(true); return; } /* 음소거 방송 중 토글 = unmute */
    on ? stopRadio(true) : start(false);
  });
  document.getElementById('radio-skip').addEventListener('click', function () {
    if (!on) return;
    next();
    ann.textContent = np.textContent;   /* 사용자 조작만 announce — 자동 전환은 침묵 */
  });
  document.getElementById('radio-stop').addEventListener('click', function () { stopRadio(true); });
  window.addEventListener('resize', refreshTrunc);

  /* ── 기본 on air: 로드 시 자동재생을 시도하고, 차단되면 첫 제스처에서 시작 ──
     끈 적 있는 방문자(localStorage)와 reduced-motion 환경은 건드리지 않는다. */
  function onGesture(e) {
    /* 코너 자체(토글이 처리)와 링크(페이지 이탈 중 소리 방지)는 제외 */
    var t = e.target;
    if (t && t.closest && (t.closest('.corner') || t.closest('a[href]'))) return;
    disarmGesture();
    if (on && mutedMode) { unmute(false); return; }  /* 음소거 방송 중 첫 제스처 = 소리 on */
    if (!on && store.get('radio') !== 'off') start(true);
  }
  function disarmGesture() {
    document.removeEventListener('pointerdown', onGesture, true);
  }
  /* 1회성 사운드 힌트 — 소리가 전혀 안 나는(armed) 상태에서만, 방문자당 1회 */
  var hint = document.getElementById('radio-hint');
  var hintShown = false;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  function killHint() { if (hint) hint.hidden = true; }
  function showHint() {
    if (!hint || hintShown || lsGet('radioHinted')) return;
    hintShown = true;
    setTimeout(function () {
      if (on) return;                      /* 그 사이 (음소거) 방송이 시작됐으면 불필요 */
      hint.hidden = false;
      lsSet('radioHinted', '1');
      document.addEventListener('pointerdown', killHint, { once: true, capture: true, passive: true });
    }, 1500);
  }
  function armGesture() {
    if (store.get('radio') === 'off') return;
    /* 첫 포인터 제스처에서 시작 (키보드는 의도적 토글만 — SR 사용자 배려) */
    document.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
    showHint();
  }
  function autoArm() {
    if (store.get('radio') === 'off') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var purl = silentWav();
    var probe = new Audio(purl);
    /* revoke는 지연 — 엘리먼트가 로드 중 URL을 잃으면 콘솔에 에러가 남는다 */
    var cleanup = function () { setTimeout(function () { URL.revokeObjectURL(purl); }, 3000); };
    var p = FORCE_MUTED ? Promise.reject(new Error('forced')) : probe.play();
    if (p && p.then) {
      p.then(function () {
        probe.pause();
        cleanup();
        if (!on) start(true);            /* 자동재생 허용 브라우저 — 바로 시작 */
      }).catch(function () {
        cleanup();
        /* 소리 차단 — 음소거 방송으로 즉시 개국 (음소거 autoplay는 대부분 허용),
           첫 제스처가 unmute. 음소거조차 거부되면(iOS 오디오) play catch가
           off로 접고 제스처 시작으로 폴백한다. */
        if (!on && store.get('radio') !== 'off') {
          mutedMode = true;
          chip.classList.add('muted');
          start(true);
        }
        armGesture();
      });
    }
  }
  /* 시작 지연 최소화: 풀 프리페치 + 큐 예열 + 첫 곡 lookup 선행 (전부 소량 요청 —
     6.8MB 필름은 load 이후에나 시작되므로 경쟁 없음). 소리는 여전히 정책/제스처가 관문. */
  ready().then(function () {
    if (!queue.length && pool.length) {
      queue = shuffle();
      resolve(queue[0]).catch(function () { /* 예열 실패는 재생 시점에 재시도 */ });
    }
  }).catch(function () { /* 첫 클릭에서 재시도 */ });
  autoArm();
})();
