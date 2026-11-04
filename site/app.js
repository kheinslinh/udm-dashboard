// UDM time & delivery dashboard. Reads data/*.json (written by udm_report.export) and draws five tabs.
(() => {
  const BENCH_PER_DAY = 8;
  const RUNAWAY_HOURS = 12;
  const AUTO_TITLE = /^(\[[A-Z0-9-]+\]\s*)?(.*?)(\s·\s\d{1,2} \w{3}, \d{2}:\d{2})?$/;

  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const h = (x) => (x >= 100 ? Math.round(x).toLocaleString() : x.toFixed(1)) + 'h';
  const pct = (x) => (Number.isFinite(x) ? Math.round(x * 100) + '%' : '—');
  const sum = (rows, f = (r) => r.hours) => rows.reduce((a, r) => a + f(r), 0);
  const groupSum = (rows, key) => {
    const m = new Map();
    for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + r.hours);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const isUntitled = (r) => {
    const t = (r.log_name || '').trim();
    if (!t) return true;
    const m = AUTO_TITLE.exec(t);
    return m && m[2].trim().toLowerCase() === (r.task || '').trim().toLowerCase();
  };
  const workdays = (from, to) => {
    let n = 0;
    for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  };

  let DATA = { sessions: [], projects: [], people: [], meta: {} };
  const state = { tab: 'dashboard', grain: 'day' };
  const F = ['from', 'to', 'client', 'service', 'team', 'person'];

  async function load(name) {
    const r = await fetch(`data/${name}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  }

  function filters() {
    const f = {};
    for (const k of F) f[k] = $('#f-' + k).value;
    f.runaway = $('#f-runaway').checked;
    return f;
  }

  function sessionRows(f, opts = {}) {
    return DATA.sessions.filter((r) =>
      (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to) &&
      (!f.client || r.service_group === f.client) && (!f.service || r.service === f.service) &&
      (opts.ignoreTeam || !f.team || r.team === f.team) && (opts.ignorePerson || !f.person || r.person === f.person) &&
      (opts.keepRunaway || f.runaway || !r.runaway));
  }

  function fillSelect(id, values, all) {
    const s = $(id), cur = s.value;
    s.replaceChildren(el('option', { value: '' }, all), ...values.map((v) => el('option', { value: v }, v)));
    if (values.includes(cur)) s.value = cur;
  }

  function refreshOptions() {
    const f = filters();
    const uniq = (rows, k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))].sort();
    fillSelect('#f-client', uniq(DATA.sessions, 'service_group'), 'All clients');
    fillSelect('#f-service', uniq(DATA.sessions.filter((r) => !f.client || r.service_group === f.client), 'service'), 'All services');
    fillSelect('#f-team', uniq(DATA.people, 'team'), 'All teams');
    fillSelect('#f-person', DATA.people.filter((p) => !f.team || p.team === f.team).map((p) => p.person).sort(), 'All people');
  }

  // ---------- small renderers ----------
  function tiles(target, items) {
    $(target).replaceChildren(...items.map(([lbl, val, sub]) => {
      const t = el('div', { class: 'tile' });
      t.append(el('div', { class: 'lbl' }, lbl), el('div', { class: 'val' }, val), el('div', { class: 'sub' }, sub || ''));
      return t;
    }));
  }

  function bars(target, pairs, { limit = 12, onPick, fmt = h, color } = {}) {
    const box = $(target);
    if (!pairs.length) { box.replaceChildren(el('div', { class: 'empty' }, 'No data in this selection.')); return; }
    const max = pairs[0][1] || 1;
    box.replaceChildren(...pairs.slice(0, limit).map(([name, v]) => {
      const row = el('div', { class: 'bar-row', title: name });
      const track = el('div', { class: 'track' });
      track.append(el('div', { class: 'fill', style: `width:${Math.max(1, (v / max) * 100)}%;${color ? 'background:' + color(name) : ''}` }));
      row.append(el('span', { class: 'name' }, name), track, el('span', { class: 'v' }, fmt(v)));
      if (onPick) row.addEventListener('click', () => onPick(name));
      return row;
    }));
  }

  function table(target, rows) {
    $(target + ' tbody').replaceChildren(...rows.map((cells) => {
      const tr = el('tr');
      for (const c of cells) {
        const [text, cls] = Array.isArray(c) ? c : [c, ''];
        tr.append(el('td', cls ? { class: cls } : {}, String(text)));
      }
      return tr;
    }));
    if (!rows.length) $(target + ' tbody').replaceChildren(el('tr', {}, ''));
  }

  const tip = $('#tip');
  function showTip(ev, text) { tip.hidden = false; tip.textContent = text; tip.style.left = Math.min(ev.clientX + 12, innerWidth - 180) + 'px'; tip.style.top = ev.clientY + 12 + 'px'; }

  function timeChart(rows) {
    const box = $('#chart-time');
    box.replaceChildren();
    const key = state.grain === 'day' ? (r) => r.date : state.grain === 'week' ? (r) => r.week : (r) => r.month;
    const label = state.grain === 'day' ? (k) => k.slice(5) : state.grain === 'week' ? (k, r) => (r && r.week_label) || k : (k, r) => (r && r.month_label) || k;
    const map = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, { k, v: 0, l: label(k, r) });
      map.get(k).v += r.hours;
    }
    const data = [...map.values()].sort((a, b) => (a.k < b.k ? -1 : 1));
    if (!data.length) { box.append(el('div', { class: 'empty' }, 'No hours in this selection.')); return; }
    const W = Math.max(box.clientWidth, 300), H = 220, m = { t: 10, r: 8, b: 28, l: 36 };
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleBand().domain(data.map((d) => d.k)).range([m.l, W - m.r]).padding(0.25);
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) || 1]).nice().range([H - m.b, m.t]);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => v + 'h')).call((g) => g.select('.domain').remove()).selectAll('text').attr('fill', 'currentColor');
    const step = Math.ceil(data.length / Math.max(1, Math.floor(W / 70)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(data.filter((_, i) => i % step === 0).map((d) => d.k)).tickFormat((k) => data.find((d) => d.k === k).l)).selectAll('text').attr('fill', 'currentColor');
    svg.append('g').selectAll('rect').data(data).join('rect')
      .attr('x', (d) => x(d.k)).attr('width', x.bandwidth()).attr('y', (d) => y(d.v)).attr('height', (d) => y(0) - y(d.v))
      .attr('rx', 2).attr('fill', 'var(--brand)')
      .on('mousemove', (ev, d) => showTip(ev, `${d.l}: ${h(d.v)}`)).on('mouseleave', () => { tip.hidden = true; });
    svg.selectAll('.tick line').attr('stroke', 'var(--line)');
  }

  function donut(parts) {
    const box = $('#donut');
    box.replaceChildren();
    const total = d3.sum(parts, (p) => p.v);
    if (!total) { box.append(el('div', { class: 'empty' }, 'No tasks in this selection.')); return; }
    const S = 220, R = S / 2;
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${S + 180} ${S}`);
    const g = svg.append('g').attr('transform', `translate(${R},${R})`);
    const arcs = d3.pie().sort(null).value((p) => p.v)(parts);
    g.selectAll('path').data(arcs).join('path').attr('d', d3.arc().innerRadius(R * 0.58).outerRadius(R - 4)).attr('fill', (a) => a.data.c)
      .on('mousemove', (ev, a) => showTip(ev, `${a.data.n}: ${a.data.v}`)).on('mouseleave', () => { tip.hidden = true; });
    g.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em').attr('fill', 'currentColor').style('font-size', '22px').text(total);
    const lg = svg.append('g').attr('transform', `translate(${S + 16},${R - parts.length * 12})`);
    parts.forEach((p, i) => {
      const row = lg.append('g').attr('transform', `translate(0,${i * 24})`);
      row.append('rect').attr('width', 12).attr('height', 12).attr('rx', 2).attr('fill', p.c);
      row.append('text').attr('x', 18).attr('y', 10).attr('fill', 'currentColor').style('font-size', '13px').text(`${p.n} · ${p.v}`);
    });
  }

  // ---------- tabs ----------
  function drawDashboard(f) {
    const rows = sessionRows(f);
    const people = new Set(rows.map((r) => r.person));
    const scopePeople = DATA.people.filter((p) => (!f.team || p.team === f.team) && (!f.person || p.person === f.person));
    const days = workdays(f.from, f.to);
    const bench = days * BENCH_PER_DAY;
    const total = sum(rows);
    tiles('#dash-tiles', [
      ['Hours logged', h(total), `${f.from} → ${f.to}`],
      ['People logging time', `${[...people].filter((p) => scopePeople.some((s) => s.person === p)).length} of ${scopePeople.length}`, `${scopePeople.length - people.size > 0 ? scopePeople.length - people.size + ' with no hours' : 'everyone logged'}`],
      ['Hours per person', h(scopePeople.length ? total / scopePeople.length : 0), `benchmark ${h(bench)} (${days} working days × ${BENCH_PER_DAY}h)`],
      ['Tasks worked on', new Set(rows.map((r) => r.item_id || r.task)).size.toLocaleString(), `${new Set(rows.map((r) => r.project_id)).size} projects`],
    ]);
    timeChart(rows);
    bars('#bars-project', groupSum(rows, (r) => `${r.project} (${r.service_group})`));
    bars('#bars-person', groupSum(rows, (r) => r.person), { limit: 40, onPick: (p) => { $('#f-person').value = p; draw(); } });

    const card = $('#person-card');
    card.hidden = !f.person;
    if (f.person) {
      $('#person-title').textContent = `${f.person} — tasks worked on`;
      const m = new Map();
      for (const r of rows) {
        const k = r.item_id || r.task;
        if (!m.has(k)) m.set(k, { task: r.task, client: r.service_group, project: r.project, hours: 0, last: r.date });
        const t = m.get(k);
        t.hours += r.hours;
        if (r.date > t.last) t.last = r.date;
      }
      table('#person-tasks', [...m.values()].sort((a, b) => b.hours - a.hours).map((t) => [t.task, t.client, t.project, [h(t.hours), 'num'], t.last]));
    }
  }

  function drawTeam(f) {
    const rows = sessionRows(f, { ignorePerson: true });
    const teams = [...new Set(DATA.people.map((p) => p.team))].filter((t) => !f.team || t === f.team).sort();
    const box = $('#team-tables');
    box.replaceChildren();
    for (const team of teams) {
      const members = DATA.people.filter((p) => p.team === team);
      const trows = rows.filter((r) => r.team === team);
      const teamHours = sum(trows);
      const teamTasks = new Set(trows.map((r) => r.item_id || r.task)).size;
      const stats = members.map((p) => {
        const pr = trows.filter((r) => r.person === p.person);
        return { name: p.person, hours: sum(pr), tasks: new Set(pr.map((r) => r.item_id || r.task)).size };
      }).sort((a, b) => b.hours - a.hours);
      const maxH = Math.max(...stats.map((s) => s.hours), 0.0001);
      const block = el('div', { class: 'team-block' });
      block.append(el('h3', {}, `${team} · ${h(teamHours)} · ${teamTasks} tasks · ${members.length} people`));
      const t = el('table', { class: 'tbl' });
      const head = el('tr');
      for (const [txt, cls] of [['Person', ''], ['Hours', 'num'], ['% of team hours', 'num'], ['Tasks', 'num'], ['% of team tasks', 'num']]) head.append(el('th', cls ? { class: cls } : {}, txt));
      t.append(el('thead'), el('tbody'));
      t.tHead.append(head);
      for (const s of stats) {
        const tr = el('tr');
        const share = teamHours ? s.hours / teamHours : 0;
        const heat = el('span', { class: 'heat', style: `background:${d3.interpolateRgb(getComputedStyle(document.documentElement).getPropertyValue('--heat0').trim(), getComputedStyle(document.documentElement).getPropertyValue('--heat1').trim())(s.hours / maxH)};color:${s.hours / maxH > 0.55 ? '#fff' : 'inherit'}` }, h(s.hours));
        const hc = el('td', { class: 'num' }); hc.append(heat);
        tr.append(el('td', {}, s.name), hc, el('td', { class: 'num' }, pct(share)), el('td', { class: 'num' }, String(s.tasks)), el('td', { class: 'num' }, pct(teamTasks ? s.tasks / teamTasks : NaN)));
        t.tBodies[0].append(tr);
      }
      block.append(t);
      box.append(block);
    }
  }

  function drawDelivery(f) {
    const projs = DATA.projects.filter((p) => (!f.client || p.service_group === f.client) && (!f.service || p.service === f.service));
    const done = d3.sum(projs, (p) => p.done), total = d3.sum(projs, (p) => p.total), overdue = d3.sum(projs, (p) => p.overdue);
    const open = Math.max(0, total - done - overdue);
    tiles('#deliv-tiles', [
      ['Tasks done', `${done} / ${total}`, pct(total ? done / total : NaN) + ' complete'],
      ['Overdue', String(overdue), `${projs.filter((p) => p.overdue > 0).length} projects at risk`],
      ['Open (not overdue)', String(open), `${projs.length} projects`],
    ]);
    donut([{ n: 'Done', v: done, c: 'var(--brand)' }, { n: 'Open', v: open, c: '#c9a6ff' }, { n: 'Overdue', v: overdue, c: 'var(--orange)' }]);
    const byClient = new Map();
    for (const p of projs) {
      const c = byClient.get(p.service_group) || { done: 0, total: 0, overdue: 0 };
      c.done += p.done; c.total += p.total; c.overdue += p.overdue;
      byClient.set(p.service_group, c);
    }
    bars('#bars-overdue', [...byClient.entries()].map(([k, v]) => [k, v.overdue]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]), { fmt: String, color: () => 'var(--orange)', onPick: (c) => { $('#f-client').value = c; refreshOptions(); draw(); } });
    const hoursByClient = new Map(groupSum(sessionRows(f), (r) => r.service_group));
    table('#deliv-table', [...byClient.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, v]) => [
      k, [v.done, 'num'], [v.total, 'num'], [pct(v.total ? v.done / v.total : NaN), 'num'], [v.overdue, v.overdue ? 'num bad' : 'num'], [h(hoursByClient.get(k) || 0), 'num']]));
    $('#proj-updated').textContent = (DATA.projects[0] && DATA.projects[0].updated) || '—';
  }

  function drawManagement(f) {
    const rows = sessionRows(f);
    const internal = rows.filter((r) => r.clockin || /internal|admin|unravel/i.test(r.service_group));
    const rev = rows.filter((r) => r.revision);
    tiles('#mgmt-tiles', [
      ['Client hours', h(sum(rows) - sum(internal)), `${new Set(rows.map((r) => r.service_group)).size} clients`],
      ['Revision time', h(sum(rev)), `${rev.length} logs on ${new Set(rev.map((r) => r.item_id || r.task)).size} tasks`],
      ['Internal & clock-in', h(sum(internal)), `${pct(sum(rows) ? sum(internal) / sum(rows) : NaN)} of hours`],
    ]);
    const m = new Map();
    for (const r of rows) {
      const k = r.service_group + '\u0000' + r.service;
      if (!m.has(k)) m.set(k, { c: r.service_group, s: r.service, h: 0, t: new Set(), p: new Set() });
      const x = m.get(k); x.h += r.hours; x.t.add(r.item_id || r.task); x.p.add(r.person);
    }
    table('#scope-table', [...m.values()].sort((a, b) => (a.c === b.c ? b.h - a.h : a.c < b.c ? -1 : 1)).map((x) => [x.c, x.s, [h(x.h), 'num'], [x.t.size, 'num'], [x.p.size, 'num']]));
    const revTasks = new Map();
    for (const r of rev) { const k = `${r.task} (${r.service_group})`; revTasks.set(k, (revTasks.get(k) || 0) + 1); }
    bars('#rev-list', [...revTasks.entries()].sort((a, b) => b[1] - a[1]), { fmt: (v) => v + (v === 1 ? ' log' : ' logs') });
    bars('#internal-list', groupSum(internal, (r) => r.person));
  }

  function drawQuality(f) {
    const all = sessionRows(f, { keepRunaway: true });
    const run = all.filter((r) => r.runaway || r.hours > RUNAWAY_HOURS);
    const untitled = all.filter((r) => !r.runaway && isUntitled(r));
    tiles('#dq-tiles', [
      ['Timers >12h', String(run.length), `${h(sum(run))} left out`],
      ['Logs without a title', `${untitled.length} of ${all.length}`, pct(all.length ? untitled.length / all.length : NaN)],
    ]);
    table('#runaway-table', run.sort((a, b) => b.hours - a.hours).map((r) => [r.person, r.date, r.task, [h(r.hours), 'num']]));
    const by = new Map();
    for (const r of untitled) by.set(r.person, (by.get(r.person) || 0) + 1);
    bars('#untitled-list', [...by.entries()].sort((a, b) => b[1] - a[1]), { fmt: String, limit: 40 });
  }

  function draw() {
    const f = filters();
    ({ dashboard: drawDashboard, team: drawTeam, delivery: drawDelivery, management: drawManagement, quality: drawQuality })[state.tab](f);
  }

  // ---------- wiring ----------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + state.tab; });
    history.replaceState(null, '', '#' + state.tab);
    draw();
  }));
  document.querySelectorAll('#grain button').forEach((b) => b.addEventListener('click', () => {
    state.grain = b.dataset.g;
    document.querySelectorAll('#grain button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  }));
  for (const k of [...F, 'runaway']) $('#f-' + k).addEventListener('change', () => { if (k === 'client' || k === 'team') refreshOptions(); draw(); });
  $('#f-reset').addEventListener('click', () => { resetFilters(); refreshOptions(); draw(); });
  let width = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - width) > 8) { width = innerWidth; draw(); } });

  function resetFilters() {
    $('#f-from').value = DATA.meta.window_start || '';
    $('#f-to').value = DATA.meta.window_end || '';
    for (const k of ['client', 'service', 'team', 'person']) $('#f-' + k).value = '';
    $('#f-runaway').checked = false;
  }

  (async () => {
    try {
      const [sessions, projects, people, meta] = await Promise.all(['sessions', 'projects', 'people', 'meta'].map(load));
      DATA = { sessions: sessions.map((r) => ({ ...r, hours: Number(r.hours) || 0, runaway: r.runaway === true || r.runaway === 'true' })), projects, people, meta };
      $('#snapshot-note').textContent = meta.label || `Data ${meta.window_start} → ${meta.window_end}`;
      $('#f-from').min = $('#f-to').min = meta.window_start || '';
      $('#f-from').max = $('#f-to').max = meta.window_end || '';
      resetFilters();
      refreshOptions();
      const t = location.hash.slice(1);
      const btn = document.querySelector(`.tabs button[data-tab="${t}"]`);
      if (btn) btn.click(); else draw();
    } catch (e) {
      $('#snapshot-note').textContent = 'Could not load data: ' + e.message;
    }
  })();

  // ---- Sync with Rework: the button starts a refresh; opening the page starts one when the
  // data is more than 30 minutes old (the server decides). When the run finishes and Vercel has
  // redeployed the new data, the page reloads itself.
  const syncBtn = $('#sync');
  const syncNote = $('#sync-note');
  const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let stamp = null;
  let waitingSince = 0;
  let pollTimer = null;

  async function dataStamp() {
    try {
      const r = await fetch('data/sync.json', { cache: 'no-cache' });
      return r.ok ? (await r.json()).updated_at || null : null;
    } catch { return null; }
  }

  async function syncApi(method, body) {
    const r = await fetch('/api/sync', {
      method, cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return out;
  }

  function idle(text, bad = false) {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync';
    syncNote.textContent = text;
    syncNote.classList.toggle('bad', bad);
  }

  function busy(text) {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    syncNote.textContent = text;
    syncNote.classList.remove('bad');
  }

  const syncedText = () => (stamp ? `Synced ${fmtTime(stamp)}` : 'Not synced yet');

  function show(res) {
    if (!res || res.configured === false) { syncBtn.hidden = true; idle(syncedText()); return false; }
    if (res.error) { idle(`${syncedText()} · sync unavailable (${res.error})`, true); return false; }
    const run = res.run;
    const ours = run && Date.parse(run.started_at) >= waitingSince - 60000;
    if (run && run.status !== 'completed') { busy(`Syncing since ${fmtTime(run.started_at)}…`); return true; }
    if (waitingSince && !ours) { busy('Starting sync…'); return true; }
    if (waitingSince && run.conclusion !== 'success') {
      waitingSince = 0;
      idle(`${syncedText()} · last sync failed`, true);
      if (run.url) syncNote.innerHTML += ` (<a href="${run.url}" target="_blank" rel="noopener">details</a>)`;
      return false;
    }
    if (waitingSince) { busy('Publishing new data…'); return 'deploy'; }
    idle(syncedText());
    return false;
  }

  async function poll() {
    clearTimeout(pollTimer);
    const state = show(await syncApi('GET'));
    if (state === 'deploy') {
      const now = await dataStamp();
      if (now && now !== stamp) { location.reload(); return; }
      if (Date.now() - waitingSince > 90 * 60000) { waitingSince = 0; idle(syncedText()); return; }
    }
    if (state) pollTimer = setTimeout(poll, 20000);
  }

  async function startSync(auto) {
    const res = await syncApi('POST', { auto });
    if (res.started || (res.run && res.run.status !== 'completed')) waitingSince = res.started ? Date.now() : Date.parse(res.run.started_at);
    if (show(res)) pollTimer = setTimeout(poll, 20000);
  }

  syncBtn.addEventListener('click', () => { busy('Starting sync…'); startSync(false); });
  (async () => {
    stamp = await dataStamp();
    idle(syncedText());
    startSync(true);
  })();
})();
