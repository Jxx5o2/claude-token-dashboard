#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// 데이터 경로: CLI 인자(--dir=...) > 환경변수(CLAUDE_PROJECTS_DIR) > 기본값(각자 홈)
function resolveProjectsDir() {
  const arg = process.argv.find(a => a.startsWith('--dir='));
  if (arg) return arg.slice('--dir='.length);
  if (process.env.CLAUDE_PROJECTS_DIR) return process.env.CLAUDE_PROJECTS_DIR;
  return path.join(os.homedir(), '.claude', 'projects');
}
const PROJECTS_DIR = resolveProjectsDir();
const START_PORT = parseInt(process.env.PORT, 10) || 5050;
const NO_OPEN = process.argv.includes('--no-open');

const HOUR = 3600 * 1000;
const FIVE_HOURS = 5 * HOUR;

// ---------- config ----------
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.CACHE_READ_FACTOR = cfg.CACHE_READ_FACTOR == null ? 0.1 : cfg.CACHE_READ_FACTOR;
  return cfg;
}

// ---------- helpers ----------
function walkJsonl(dir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkJsonl(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function modelFamily(model) {
  if (!model) return 'default';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return 'default';
}
function familyLabel(fam) {
  return { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', default: '기타' }[fam] || fam;
}

function lastFolder(cwd) {
  if (!cwd) return '(알 수 없음)';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

// 홈 루트 / Desktop / Downloads / Documents 처럼 특정 프로젝트로 보기 어려운 위치
function normPath(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
const HOME_NORM = normPath(os.homedir());
const UNCLASSIFIED_DIRS = new Set([
  HOME_NORM,
  `${HOME_NORM}/desktop`,
  `${HOME_NORM}/downloads`,
  `${HOME_NORM}/documents`,
]);
function projectName(cwd) {
  const name = lastFolder(cwd);
  return UNCLASSIFIED_DIRS.has(normPath(cwd)) ? `${name} (미분류)` : name;
}

// local YYYY-MM-DD
function localDateKey(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
function floorToHour(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}
// Monday 00:00 local of the week containing ms
function weekStartMonday(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d.getTime();
}
function monthStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// ---------- parse + normalize ----------
function loadRecords(cfg) {
  const files = walkJsonl(PROJECTS_DIR);
  const seen = new Set();
  const records = [];

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch (e) { continue; }
      if (d.type !== 'assistant' || !d.message || !d.message.usage) continue;
      const model = d.message.model;
      if (model === '<synthetic>') continue;

      // dedup by requestId (identical usage repeated across rows)
      const rid = d.requestId;
      if (rid) {
        if (seen.has(rid)) continue;
        seen.add(rid);
      }

      const u = d.message.usage;
      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      const cc = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const fam = modelFamily(model);
      const weighted = input + output + cc + cr * cfg.CACHE_READ_FACTOR;

      const price = cfg.PRICING_PER_MTOK[fam] || cfg.PRICING_PER_MTOK.default;
      const cost =
        (input / 1e6) * price.input +
        (output / 1e6) * price.output +
        (cc / 1e6) * price.cache_write +
        (cr / 1e6) * price.cache_read;

      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (ts == null || isNaN(ts)) continue;

      records.push({
        ts,
        date: localDateKey(new Date(ts)),
        model, fam,
        project: projectName(d.cwd),
        sessionId: d.sessionId || rid || 'unknown',
        input, output, cc, cr,
        weighted,
        cost,
      });
    }
  }
  records.sort((a, b) => a.ts - b.ts);
  return records;
}

// ---------- session blocks (ccusage style) ----------
// A block starts at floored-hour of the first activity after the previous block
// ended (start + 5h) OR after a >=5h gap since last activity.
function buildBlocks(records) {
  const blocks = [];
  let cur = null;
  let lastTs = null;
  for (const r of records) {
    const startNew =
      !cur ||
      (r.ts - cur.start) >= FIVE_HOURS ||
      (lastTs != null && (r.ts - lastTs) >= FIVE_HOURS);
    if (startNew) {
      cur = { start: floorToHour(r.ts), end: 0, lastTs: r.ts, weighted: 0, count: 0 };
      cur.endLimit = cur.start + FIVE_HOURS;
      blocks.push(cur);
    }
    cur.weighted += r.weighted;
    cur.count += 1;
    cur.lastTs = r.ts;
    lastTs = r.ts;
  }
  return blocks;
}

// ---------- aggregation ----------
function aggregate(cfg, now) {
  const records = loadRecords(cfg);
  const blocks = buildBlocks(records);

  // ----- 5-hour window (current session block) -----
  let fiveHour;
  const lastBlock = blocks[blocks.length - 1];
  const active = lastBlock &&
    (now - lastBlock.start) < FIVE_HOURS &&
    (now - lastBlock.lastTs) < FIVE_HOURS;
  if (active) {
    const used = lastBlock.weighted;
    const resetAt = lastBlock.start + FIVE_HOURS;
    fiveHour = {
      active: true,
      used,
      limit: cfg.FIVE_HOUR_LIMIT,
      ratio: cfg.FIVE_HOUR_LIMIT ? used / cfg.FIVE_HOUR_LIMIT : 0,
      remainingRatio: cfg.FIVE_HOUR_LIMIT ? Math.max(0, 1 - used / cfg.FIVE_HOUR_LIMIT) : 0,
      blockStart: lastBlock.start,
      resetAt,
      resetInMs: resetAt - now,
      elapsedRatio: Math.min(1, (now - lastBlock.start) / FIVE_HOURS),
    };
  } else {
    fiveHour = {
      active: false,
      used: 0,
      limit: cfg.FIVE_HOUR_LIMIT,
      ratio: 0,
      remainingRatio: 1,
      blockStart: null,
      resetAt: null,
      resetInMs: null,
      elapsedRatio: 0,
    };
  }

  // ----- pace (based on current 5h window) -----
  let pace;
  if (fiveHour.active && fiveHour.elapsedRatio > 0.02) {
    const e = fiveHour.elapsedRatio;
    const usedR = fiveHour.ratio;
    const speed = usedR / e; // >1 = faster than even pace
    let label, desc;
    if (speed < 0.8) { label = '여유'; desc = '균등 소진 페이스보다 느리게 쓰고 있어요. 한도에 여유가 있습니다.'; }
    else if (speed <= 1.2) { label = '적정'; desc = '균등 소진 페이스와 비슷한 속도예요. 지금 흐름이면 무난합니다.'; }
    else { label = '빠름'; desc = '균등 소진 페이스보다 빠릅니다. 이 속도면 윈도우 리셋 전에 한도에 닿을 수 있어요.'; }
    pace = { available: true, label, desc, elapsedRatio: e, usedRatio: usedR, speed };
  } else {
    pace = {
      available: false,
      label: '대기',
      desc: fiveHour.active ? '윈도우가 막 시작됐어요. 잠시 후 페이스가 계산됩니다.' : '활성 윈도우가 없어요. 다음 활동부터 측정합니다.',
      elapsedRatio: fiveHour.elapsedRatio, usedRatio: fiveHour.ratio, speed: 0,
    };
  }

  // ----- weekly (Monday start) -----
  const wkStart = weekStartMonday(now);
  const wkEnd = wkStart + 7 * 24 * HOUR;
  let weekUsed = 0;
  for (const r of records) if (r.ts >= wkStart && r.ts < wkEnd) weekUsed += r.weighted;
  const weekElapsedRatio = Math.min(1, (now - wkStart) / (7 * 24 * HOUR));
  const weekUsedRatio = cfg.WEEKLY_LIMIT ? weekUsed / cfg.WEEKLY_LIMIT : 0;
  const weekSpeed = weekElapsedRatio > 0 ? weekUsedRatio / weekElapsedRatio : 0;
  let weekPaceLabel;
  if (weekSpeed < 0.8) weekPaceLabel = '여유';
  else if (weekSpeed <= 1.2) weekPaceLabel = '적정';
  else weekPaceLabel = '빠름';
  const daysRemaining = Math.ceil((wkEnd - now) / (24 * HOUR));
  const weekly = {
    used: weekUsed,
    limit: cfg.WEEKLY_LIMIT,
    ratio: weekUsedRatio,
    weekStart: wkStart,
    weekEnd: wkEnd,
    daysRemaining,
    pace: { label: weekPaceLabel, elapsedRatio: weekElapsedRatio, usedRatio: weekUsedRatio },
  };

  // ----- heatmap (last 183 days, local) -----
  const DAYS = 183;
  const dayMap = {}; // date -> {total, models:{fam:weighted}, cost}
  for (const r of records) {
    let d = dayMap[r.date];
    if (!d) d = dayMap[r.date] = { total: 0, models: {}, cost: 0 };
    d.total += r.weighted;
    d.models[r.fam] = (d.models[r.fam] || 0) + r.weighted;
    d.cost += r.cost;
  }
  const todayMid = new Date(now); todayMid.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const dd = new Date(todayMid.getTime() - i * 24 * HOUR);
    const key = localDateKey(dd);
    const info = dayMap[key] || { total: 0, models: {}, cost: 0 };
    days.push({
      date: key,
      dow: dd.getDay(),
      total: info.total,
      models: info.models,
      cost: info.cost,
    });
  }
  // levels: 0 -> 0, nonzero -> quartiles
  const nonzero = days.filter(d => d.total > 0).map(d => d.total).sort((a, b) => a - b);
  function quantile(arr, q) {
    if (!arr.length) return 0;
    const pos = (arr.length - 1) * q;
    const base = Math.floor(pos), rest = pos - base;
    return arr[base + 1] !== undefined ? arr[base] + rest * (arr[base + 1] - arr[base]) : arr[base];
  }
  const t1 = quantile(nonzero, 0.25), t2 = quantile(nonzero, 0.5), t3 = quantile(nonzero, 0.75);
  for (const d of days) {
    if (d.total <= 0) d.level = 0;
    else if (d.total <= t1) d.level = 1;
    else if (d.total <= t2) d.level = 2;
    else if (d.total <= t3) d.level = 3;
    else d.level = 4;
  }
  // streaks (a used day = total>0), evaluated over the 183-day window ending today
  let longest = 0, run = 0;
  for (const d of days) { if (d.total > 0) { run++; longest = Math.max(longest, run); } else run = 0; }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) { if (days[i].total > 0) current++; else break; }
  let maxDay = { date: null, total: 0 };
  for (const d of days) if (d.total > maxDay.total) maxDay = { date: d.date, total: d.total };
  const heatmap = {
    days,
    stats: { currentStreak: current, longestStreak: longest, maxDay },
    thresholds: [t1, t2, t3],
  };

  // ----- sessions by date (for click panel) -----
  const sessByDate = {}; // date -> { sessionId -> {project, tokens, firstTs} }
  for (const r of records) {
    let day = sessByDate[r.date];
    if (!day) day = sessByDate[r.date] = {};
    let s = day[r.sessionId];
    if (!s) s = day[r.sessionId] = { project: r.project, tokens: 0, firstTs: r.ts };
    s.tokens += r.weighted;
    if (r.ts < s.firstTs) s.firstTs = r.ts;
  }
  const sessionsByDate = {};
  for (const date in sessByDate) {
    sessionsByDate[date] = Object.values(sessByDate[date])
      .map(s => ({ time: s.firstTs, project: s.project, tokens: s.tokens }))
      .sort((a, b) => a.time - b.time);
  }

  // ----- projects (this month) -----
  const moStart = monthStart(now);
  const projMap = {};
  let projTotal = 0;
  for (const r of records) {
    if (r.ts < moStart) continue;
    projMap[r.project] = (projMap[r.project] || 0) + r.weighted;
    projTotal += r.weighted;
  }
  let projArr = Object.entries(projMap).map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const top = projArr.slice(0, 5);
  const rest = projArr.slice(5);
  if (rest.length) {
    const restSum = rest.reduce((s, p) => s + p.tokens, 0);
    top.push({ name: '기타', tokens: restSum, isOther: true });
  }
  for (const p of top) p.pct = projTotal ? (p.tokens / projTotal) * 100 : 0;
  const projects = { monthStart: moStart, total: projTotal, items: top };

  return {
    generatedAt: now,
    config: {
      plan: cfg.plan,
      cacheReadFactor: cfg.CACHE_READ_FACTOR,
      fiveHourLimit: cfg.FIVE_HOUR_LIMIT,
      weeklyLimit: cfg.WEEKLY_LIMIT,
      calibrated: cfg.calibrated === true,
      calibratedAt: cfg.calibratedAt || null,
    },
    meta: {
      totalRecords: records.length,
      totalBlocks: blocks.length,
      noData: records.length === 0,
      projectsDir: PROJECTS_DIR,
      projectsDirExists: fs.existsSync(PROJECTS_DIR),
    },
    fiveHour, pace, weekly, heatmap, sessionsByDate, projects,
  };
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/usage') {
    try {
      const cfg = loadConfig();
      const data = aggregate(cfg, Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e && e.stack || e) }));
    }
    return;
  }

  // static
  let rel = url === '/' ? 'index.html' : decodeURIComponent(url.replace(/^\/+/, ''));
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// 시작 시 매칭 실패(default 단가 적용) 모델 경고
function warnUnregisteredModels() {
  let records;
  try { records = loadRecords(loadConfig()); }
  catch (e) { return; }
  const unknown = new Set();
  for (const r of records) if (r.fam === 'default') unknown.add(r.model || '(이름 없음)');
  for (const m of unknown) {
    console.log(`  ⚠ 미등록 모델: ${m} (default 단가 적용)`);
  }
}

function openBrowser(url) {
  if (NO_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* 브라우저 자동 열기 실패는 무시 */ });
}

// 포트가 사용 중이면 다음 포트로 자동 회피 (최대 20회)
function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`포트 ${port} 사용 중 → ${port + 1} 시도`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('서버 시작 실패:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Claude Code 토큰 대시보드`);
    console.log(`  ▶ ${url}`);
    console.log(`  데이터 소스: ${PROJECTS_DIR}`);
    if (!fs.existsSync(PROJECTS_DIR)) {
      console.log(`  ⚠ 경로를 찾을 수 없습니다. Claude Code 사용 기록이 없거나 경로가 다를 수 있어요.`);
      console.log(`     --dir=경로 또는 CLAUDE_PROJECTS_DIR 환경변수로 지정하세요.`);
    }
    warnUnregisteredModels();
    console.log(`  (종료: Ctrl+C)\n`);
    openBrowser(url);
  });
}

listen(START_PORT, 20);
