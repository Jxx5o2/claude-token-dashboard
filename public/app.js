'use strict';

// ---------- format helpers ----------
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(c) {
  c = c || 0;
  if (c > 0 && c < 0.01) return '<$0.01';
  return '$' + c.toFixed(2);
}
function fmtPct(p) { return (p || 0).toFixed(1) + '%'; }
function famLabel(f) {
  return ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', default: '기타' })[f] || f;
}
function fmtDuration(ms) {
  if (ms == null) return '–';
  if (ms <= 0) return '곧 리셋';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}
function fmtDate(key) {
  const [y, mo, d] = key.split('-');
  return `${y}.${mo}.${d}`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function barClass(ratio) { return ratio >= 1 ? 'busy' : ratio >= 0.8 ? 'warn' : ''; }

const PROJ_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#64748b'];

let DATA = null;

// ---------- main ----------
async function load() {
  let data;
  try {
    const res = await fetch('/api/usage');
    data = await res.json();
  } catch (e) {
    document.getElementById('head-sub').textContent = '데이터를 불러오지 못했습니다: ' + e;
    return;
  }
  if (data.error) {
    document.getElementById('head-sub').textContent = '서버 오류: ' + data.error;
    return;
  }
  DATA = data;
  renderNotice(data.meta);
  renderCalibration(data.config);
  renderHead(data);
  renderFiveHour(data.fiveHour);
  renderWeekly(data.weekly);
  renderPace(data.pace);
  renderHeatmap(data.heatmap);
  renderProjects(data.projects);
  renderFoot(data);
}

function renderNotice(meta) {
  const el = document.getElementById('notice');
  if (!meta || !meta.noData) { el.hidden = true; return; }
  if (!meta.projectsDirExists) {
    el.innerHTML = `데이터 경로를 찾지 못했습니다: <code>${meta.projectsDir}</code><br>`
      + `Claude Code 사용 기록이 없거나 경로가 다를 수 있어요. `
      + `<code>--dir=경로</code> 인자 또는 <code>CLAUDE_PROJECTS_DIR</code> 환경변수로 지정하세요.`;
  } else {
    el.innerHTML = `아직 집계할 토큰 기록이 없습니다. `
      + `경로는 찾았지만(<code>${meta.projectsDir}</code>) 사용 기록(JSONL)이 비어 있어요. `
      + `Claude Code로 작업을 한 뒤 새로고침해 보세요.`;
  }
  el.hidden = false;
}

function renderCalibration(cfg) {
  const slots = [document.getElementById('calib-5h'), document.getElementById('calib-week')];
  if (cfg && cfg.calibrated) {
    let when = '';
    if (cfg.calibratedAt) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cfg.calibratedAt);
      if (m) when = `${Number(m[2])}월 ${Number(m[3])}일 `;
    }
    slots.forEach(el => { el.innerHTML = `<span class="calib-badge ok">${when}보정됨</span>`; });
  } else {
    slots.forEach(el => {
      el.innerHTML = `<button class="calib-badge warn" type="button">기본값 사용 중 · 보정 권장</button>`;
      el.querySelector('button').addEventListener('click', toggleCalibPanel);
    });
  }
}

function toggleCalibPanel() {
  const row = document.getElementById('calib-panel-row');
  row.hidden = !row.hidden;
  if (!row.hidden) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
document.getElementById('calib-close').addEventListener('click', () => {
  document.getElementById('calib-panel-row').hidden = true;
});
document.getElementById('calib-copy').addEventListener('click', async (e) => {
  const text = document.getElementById('calib-template').textContent;
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // 폴백: 선택 후 execCommand
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('calib-template'));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    try { document.execCommand('copy'); } catch (e2) {}
    sel.removeAllRanges();
  }
  btn.textContent = '복사됨 ✓';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = '복사'; btn.classList.remove('done'); }, 1800);
});

function renderHead(d) {
  const sub = document.getElementById('head-sub');
  const gen = new Date(d.generatedAt);
  sub.textContent =
    `플랜 ${d.config.plan} · 가중치(cache_read ×${d.config.cacheReadFactor}) · `
    + `요청 ${d.meta.totalRecords.toLocaleString()}건 · `
    + `갱신 ${fmtTime(d.generatedAt)}`;
}

function renderFiveHour(fh) {
  const used = document.getElementById('fh-used');
  used.innerHTML = fmtTok(fh.used) + '<span class="unit">토큰</span>';
  document.getElementById('fh-sub').textContent = fh.active
    ? '세션 블록 기준 (현재 활성)'
    : '활성 윈도우 없음 — 다음 활동 시 새 블록 시작';
  const pct = Math.min(100, fh.ratio * 100);
  const bar = document.getElementById('fh-bar');
  bar.style.width = pct + '%';
  bar.className = 'bar-fill ' + barClass(fh.ratio);
  document.getElementById('fh-ratio').textContent =
    '잔여 약 ' + Math.round(fh.remainingRatio * 100) + '%';
  document.getElementById('fh-reset').textContent =
    fh.active ? '리셋까지 ' + fmtDuration(fh.resetInMs) : '리셋 대기';
}

function renderWeekly(wk) {
  document.getElementById('wk-used').innerHTML = fmtTok(wk.used) + '<span class="unit">토큰</span>';
  const pct = Math.min(100, wk.ratio * 100);
  const bar = document.getElementById('wk-bar');
  bar.style.width = pct + '%';
  bar.className = 'bar-fill ' + barClass(wk.ratio);
  document.getElementById('wk-ratio').textContent =
    fmtTok(wk.used) + ' / ' + fmtTok(wk.limit) + ' (' + Math.round(wk.ratio * 100) + '%)';
  document.getElementById('wk-days').textContent = '리셋까지 ' + wk.daysRemaining + '일';
  document.getElementById('wk-pace').textContent =
    `주간 페이스: ${wk.pace.label} · 경과 ${Math.round(wk.pace.elapsedRatio * 100)}% 대비 소진 ${Math.round(wk.pace.usedRatio * 100)}%`;
}

function renderPace(p) {
  const label = document.getElementById('pace-label');
  const cls = { '여유': 'ok', '적정': 'warn', '빠름': 'busy', '대기': 'idle' }[p.label] || 'idle';
  label.textContent = p.label;
  label.className = 'pace-label ' + cls;
  // 문장 단위(". ")로 줄바꿈해 가독성 향상
  document.getElementById('pace-desc').innerHTML =
    String(p.desc || '').split('. ').join('.<br>');
  document.getElementById('pace-used').style.width = Math.min(100, p.usedRatio * 100) + '%';
  document.getElementById('pace-elapsed').style.left = Math.min(100, p.elapsedRatio * 100) + '%';
  document.getElementById('pace-e').textContent = '경과 ' + Math.round(p.elapsedRatio * 100) + '%';
  document.getElementById('pace-u').textContent = '소진 ' + Math.round(p.usedRatio * 100) + '%';
}

// ---------- heatmap ----------
function renderHeatmap(h) {
  document.getElementById('hs-cur').textContent = h.stats.currentStreak + '일';
  document.getElementById('hs-long').textContent = h.stats.longestStreak + '일';
  document.getElementById('hs-max').textContent =
    h.stats.maxDay.date ? fmtTok(h.stats.maxDay.total) : '–';

  const grid = document.getElementById('heat-grid');
  grid.innerHTML = '';
  const days = h.days;
  // leading empty cells so first column aligns to Sunday row
  const lead = days.length ? days[0].dow : 0;
  for (let i = 0; i < lead; i++) {
    const e = document.createElement('div');
    e.className = 'cell empty';
    grid.appendChild(e);
  }
  for (const d of days) {
    const c = document.createElement('div');
    c.className = 'cell lv' + d.level;
    c.dataset.date = d.date;
    c.addEventListener('mouseenter', (ev) => showTip(ev, d));
    c.addEventListener('mousemove', moveTip);
    c.addEventListener('mouseleave', hideTip);
    c.addEventListener('click', () => selectDay(d.date, c));
    grid.appendChild(c);
  }
}

function tipModels(models) {
  const entries = Object.entries(models || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '사용 없음';
  return entries.map(([f, v]) => `${famLabel(f)} ${fmtTok(v)}`).join(' · ');
}

const tooltip = document.getElementById('tooltip');
function showTip(ev, d) {
  tooltip.innerHTML =
    `<div class="tt-date">${fmtDate(d.date)}</div>`
    + `<div class="tt-row">총 ${fmtTok(d.total)} 토큰</div>`
    + `<div class="tt-row">${tipModels(d.models)}</div>`
    + `<div class="tt-cost">추정 비용 ${fmtCost(d.cost)}</div>`;
  tooltip.hidden = false;
  moveTip(ev);
}
function moveTip(ev) {
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tooltip.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}
function hideTip() { tooltip.hidden = true; }

function selectDay(date, cell) {
  document.querySelectorAll('.cell.sel').forEach(c => c.classList.remove('sel'));
  cell.classList.add('sel');
  const panel = document.getElementById('day-panel');
  const list = document.getElementById('dp-list');
  document.getElementById('dp-date').textContent = fmtDate(date) + ' 세션';
  const sessions = (DATA.sessionsByDate || {})[date] || [];
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<div class="dp-empty">이 날의 세션 기록이 없습니다.</div>';
  } else {
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'dp-row';
      row.innerHTML =
        `<span class="t">${fmtTime(s.time)}</span>`
        + `<span class="p" title="${s.project}">${s.project}</span>`
        + `<span class="n">${fmtTok(s.tokens)}</span>`;
      list.appendChild(row);
    }
  }
  panel.hidden = false;
}
document.getElementById('dp-close').addEventListener('click', () => {
  document.getElementById('day-panel').hidden = true;
  document.querySelectorAll('.cell.sel').forEach(c => c.classList.remove('sel'));
});

// ---------- projects ----------
function renderProjects(pr) {
  const stack = document.getElementById('proj-stack');
  const legend = document.getElementById('proj-legend');
  stack.innerHTML = '';
  legend.innerHTML = '';
  if (!pr.items.length || pr.total <= 0) {
    stack.innerHTML = '';
    legend.innerHTML = '<div class="dp-empty">이번 달 사용 기록이 없습니다.</div>';
    return;
  }
  pr.items.forEach((p, i) => {
    const color = p.isOther ? PROJ_COLORS[5] : PROJ_COLORS[i % 5];
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.width = p.pct + '%';
    seg.style.background = color;
    seg.title = `${p.name} ${fmtPct(p.pct)}`;
    stack.appendChild(seg);

    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML =
      `<span class="sw" style="background:${color}"></span>`
      + `<span class="nm" title="${p.name}">${p.name}</span>`
      + `<span class="tk">${fmtTok(p.tokens)}</span>`
      + `<span class="pc">${fmtPct(p.pct)}</span>`;
    legend.appendChild(row);
  });
}

function renderFoot(d) {
  document.getElementById('foot').innerHTML =
    `한도값은 <code>/usage</code> 기준 추정 보정값입니다 — <code>config.json</code>에서 조정할 수 있어요.<br>`
    + `5시간 윈도우 = ccusage식 세션 블록.<br>`
    + `토큰은 가중 합산(input + output + cache_creation + cache_read×0.1) 기준.`;
}

load();
