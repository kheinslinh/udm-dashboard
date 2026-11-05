// UnRavel project delivery dashboard. Reads data/*.json (written by udm_report.export):
//   tasks.json, projects.json  - live from the Rework API (one row per task / project)
//   sessions.json, meta.json   - timer sessions; a demo snapshot until Rework has a sessions endpoint
//   people.json, sync.json     - staff and teams; when the data was last pulled
(() => {
  const BENCH_PER_DAY = 8;
  const RUNAWAY_HOURS = 12;
  const TARGET = 0.9;
  const AUTO_TITLE = /^(\[[A-Z0-9-]+\]\s*)?(.*?)(\s·\s\d{1,2} \w{3}, \d{2}:\d{2})?$/;
  const DONE_STAGE = /\b(done|complete|completed|approved|posted|published|delivered|closed|live)\b/i;
  const HEALTH = [
    { k: 'On track', c: 'var(--brand)', pill: 'brand' },
    { k: 'At risk', c: 'var(--warn)', pill: 'warn' },
    { k: 'Delayed', c: 'var(--bad)', pill: 'bad' },
    { k: 'On hold', c: 'var(--hold)', pill: 'hold' },
  ];
  const HEALTH_COLOR = Object.fromEntries(HEALTH.map((x) => [x.k, x.c]));
  const HEALTH_PILL = Object.fromEntries(HEALTH.map((x) => [x.k, x.pill]));
  const PAGES = {
    dashboard: ['Executive dashboard', 'Project Delivery Overview', 'Performance, delivery and project health across UnRavel.'],
    delivery: ['Delivery command center', 'Delivery', 'Project timelines, deadlines and risks across all clients.'],
    team: ['Resource & capacity', 'Team Capacity & Productivity', 'People, time and workload across UnRavel teams.'],
    management: ['Management', 'Client Scope & Revisions', 'Hours per client and service, revisions and internal time.'],
    quality: ['Data quality', 'Data Quality', 'What needs fixing in Rework so the numbers can be trusted.'],
  };
  const ICONS = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  };

  // ---------- helpers ----------
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
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const monday = (s) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
  const fmtDay = (s) => (s ? new Date(s + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
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
  const TODAY = (() => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); })();

  let DATA = { sessions: [], projects: [], tasks: [], people: [], meta: {}, sync: null };
  let HOURS_DEMO = true;
  const state = { tab: 'dashboard', grain: 'day' };
  const F = ['from', 'to', 'client', 'service', 'team', 'person'];

  async function load(name, fallback) {
    const r = await fetch(`data/${name}.json`, { cache: 'no-cache' });
    if (!r.ok) { if (fallback !== undefined) return fallback; throw new Error(`${name}: HTTP ${r.status}`); }
    return r.json();
  }

  function filters() {
    const f = {};
    for (const k of F) f[k] = $('#f-' + k).value;
    f.runaway = $('#f-runaway').checked;
    return f;
  }

  // ---------- data views ----------
  // Tasks: live state is recomputed against today, so an old sync still shows what is overdue now.
  function taskState(t) {
    if (t.state === 'done' || t.state === 'cancelled') return t.state;
    if (t.deadline && t.deadline < TODAY) return 'overdue';
    if (t.start && t.start > TODAY) return 'scheduled';
    return 'open';
  }
  const isOpen = (t) => t.st === 'open' || t.st === 'scheduled' || t.st === 'overdue';

  function scopeTasks(f, opts = {}) {
    return DATA.tasks.filter((t) => t.st !== 'cancelled' &&
      (!f.client || t.client === f.client) && (!f.service || t.service === f.service) &&
      (opts.ignoreTeam || !f.team || t.team === f.team) && (opts.ignorePerson || !f.person || t.assignee === f.person));
  }
  // A task belongs to the date range if it was due or finished in it, or is still open.
  const inRange = (t, f) => (t.deadline && t.deadline >= f.from && t.deadline <= f.to) || (t.finished && t.finished >= f.from && t.finished <= f.to) || (isOpen(t) && !t.deadline);

  function onTime(tasks, from, to) {
    const fin = tasks.filter((t) => t.st === 'done' && t.finished && t.deadline && t.finished >= from && t.finished <= to);
    const ok = fin.filter((t) => t.finished <= t.deadline).length;
    return { ok, n: fin.length, rate: fin.length ? ok / fin.length : NaN };
  }

  function projectRows(f) {
    const tasksBy = d3.group(DATA.tasks.filter((t) => t.st !== 'cancelled'), (t) => t.project_id);
    return DATA.projects.filter((p) => (!f.client || p.service_group === f.client) && (!f.service || p.service === f.service)).map((p) => {
      const ts = tasksBy.get(p.project_id) || [];
      const total = ts.length || p.total || 0;
      const done = ts.length ? ts.filter((t) => t.st === 'done').length : p.done || 0;
      const overdue = ts.length ? ts.filter((t) => t.st === 'overdue').length : p.overdue || 0;
      const share = total ? done / total : 0;
      const complete = p.status_code === 10 || (total > 0 && done >= total);
      let health, issue = '';
      const dueIn = p.deadline ? daysBetween(TODAY, p.deadline) : null;
      if (complete) health = 'Completed';
      else if (p.status_code != null && p.status_code < 0) { health = 'On hold'; issue = 'Paused or stopped in Rework'; }
      else if (dueIn !== null && dueIn < 0) { health = 'Delayed'; issue = `Deadline passed ${fmtDay(p.deadline)}${overdue ? ` · ${overdue} overdue` : ''}`; }
      else if (overdue >= 3 || (total && overdue / total >= 0.25)) { health = 'Delayed'; issue = `${overdue} overdue task${overdue === 1 ? '' : 's'}`; }
      else if (overdue > 0) { health = 'At risk'; issue = `${overdue} overdue task${overdue === 1 ? '' : 's'}`; }
      else if (dueIn !== null && dueIn <= 7 && share < 0.7) { health = 'At risk'; issue = `Due in ${dueIn} day${dueIn === 1 ? '' : 's'} · ${pct(share)} done`; }
      else health = 'On track';
      return { ...p, total, done, overdue, share, health, issue, dueIn, tasks: ts };
    }).filter((p) => p.total > 0 || p.deadline);
  }

  function sessionRows(f, opts = {}) {
    // Demo hours cover their own snapshot window, so the date filter does not apply to them.
    const from = HOURS_DEMO ? DATA.meta.window_start : f.from, to = HOURS_DEMO ? DATA.meta.window_end : f.to;
    return DATA.sessions.filter((r) =>
      (!from || r.date >= from) && (!to || r.date <= to) &&
      (!f.client || r.service_group === f.client) && (!f.service || r.service === f.service) &&
      (opts.ignoreTeam || !f.team || r.team === f.team) && (opts.ignorePerson || !f.person || r.person === f.person) &&
      (opts.keepRunaway || f.runaway || !r.runaway));
  }
  const hoursWindow = (f) => (HOURS_DEMO ? [DATA.meta.window_start, DATA.meta.window_end] : [f.from, f.to]);

  // ---------- filters ----------
  function fillSelect(id, values, all) {
    const s = $(id), cur = s.value;
    s.replaceChildren(el('option', { value: '' }, all), ...values.map((v) => el('option', { value: v }, v)));
    if (values.includes(cur)) s.value = cur;
  }

  function refreshOptions() {
    const f = filters();
    const uniq = (...lists) => [...new Set(lists.flat().filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fillSelect('#f-client', uniq(DATA.tasks.map((t) => t.client), DATA.projects.map((p) => p.service_group), DATA.sessions.map((r) => r.service_group)), 'All clients');
    const byClient = (c) => !f.client || c === f.client;
    fillSelect('#f-service', uniq(DATA.tasks.filter((t) => byClient(t.client)).map((t) => t.service), DATA.sessions.filter((r) => byClient(r.service_group)).map((r) => r.service)), 'All services');
    fillSelect('#f-team', uniq(DATA.people.map((p) => p.team)), 'All teams');
    fillSelect('#f-person', uniq(DATA.people.filter((p) => !f.team || p.team === f.team).map((p) => p.person)), 'All people');
  }

  function resetFilters() {
    const start = addDays(TODAY.slice(0, 8) + '01', -1).slice(0, 8) + '01';  // first day of last month
    $('#f-from').value = start;
    $('#f-to').value = TODAY;
    for (const k of ['client', 'service', 'team', 'person']) $('#f-' + k).value = '';
    $('#f-runaway').checked = false;
  }

  // ---------- renderers ----------
  const tip = $('#tip');
  function showTip(ev, text) { tip.hidden = false; tip.textContent = text; tip.style.left = Math.min(ev.clientX + 12, innerWidth - 290) + 'px'; tip.style.top = ev.clientY + 14 + 'px'; }
  const hideTip = () => { tip.hidden = true; };

  function kpis(target, items) {
    $(target).replaceChildren(...items.map(({ icon, val, lbl, sub, trend, demo }) => {
      const k = el('div', { class: 'kpi' });
      const ic = el('div', { class: 'ic' });
      ic.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon] || ICONS.list}</svg>`;
      const body = el('div');
      const v = el('div', { class: 'val' }, val);
      if (demo && HOURS_DEMO) v.append(el('span', { class: 'badge demo' }, 'Demo'));
      body.append(v, el('div', { class: 'lbl' }, lbl), el('div', { class: 'sub' + (trend ? ' ' + trend : '') }, sub || ''));
      k.append(ic, body);
      return k;
    }));
  }

  function bars(target, pairs, { limit = 12, onPick, fmt = h, color } = {}) {
    const box = $(target);
    if (!pairs.length) { box.replaceChildren(el('div', { class: 'empty' }, 'No data in this selection.')); return; }
    const max = Math.max(...pairs.map((p) => p[1])) || 1;
    const total = d3.sum(pairs, (p) => p[1]);
    box.replaceChildren(...pairs.slice(0, limit).map(([name, v]) => {
      const row = el('div', { class: 'bar-row' + (onPick ? ' click' : ''), title: name });
      const track = el('div', { class: 'track' });
      track.append(el('div', { class: 'fill', style: `width:${Math.max(1, (v / max) * 100)}%;${color ? 'background:' + color(name) : ''}` }));
      const val = el('span', { class: 'v' });
      val.append(el('b', {}, fmt(v)), document.createTextNode(fmt === h && total ? ` ${pct(v / total)}` : ''));
      row.append(el('span', { class: 'name' }, name), track, val);
      if (onPick) row.addEventListener('click', () => onPick(name));
      return row;
    }));
  }

  function table(target, rows, empty = 'Nothing here.') {
    const body = $(target + ' tbody');
    if (!rows.length) {
      const cols = $(target + ' thead tr').children.length;
      body.replaceChildren(el('tr', {}, ''));
      body.firstChild.append(el('td', { colspan: cols, class: 'empty' }, empty));
      return;
    }
    body.replaceChildren(...rows.map((cells) => {
      const tr = el('tr');
      for (const c of cells) {
        const td = el('td');
        if (c instanceof Node) td.append(c);
        else if (Array.isArray(c)) { td.className = c[1]; if (c[0] instanceof Node) td.append(c[0]); else td.textContent = String(c[0]); }
        else td.textContent = String(c);
        tr.append(td);
      }
      return tr;
    }));
  }

  const pill = (text, kind) => el('span', { class: 'pill ' + kind }, text);
  const linkOrText = (text, url, sub) => {
    const wrap = el('span');
    const a = url ? el('a', { href: url, target: '_blank', rel: 'noopener' }, text) : el('span', {}, text);
    wrap.append(a);
    if (sub) wrap.append(el('small', {}, sub));
    return wrap;
  };

  function donut(target, parts, centreLabel) {
    const box = $(target);
    box.replaceChildren();
    const total = d3.sum(parts, (p) => p.v);
    if (!total) { box.append(el('div', { class: 'empty' }, 'Nothing in this selection.')); return; }
    const S = 200, R = S / 2;
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${S + 200} ${S}`).attr('role', 'img');
    const g = svg.append('g').attr('transform', `translate(${R},${R})`);
    const arcs = d3.pie().sort(null).value((p) => p.v).padAngle(0.012)(parts.filter((p) => p.v));
    g.selectAll('path').data(arcs).join('path').attr('d', d3.arc().innerRadius(R * 0.66).outerRadius(R - 2).cornerRadius(3)).attr('fill', (a) => a.data.c)
      .on('mousemove', (ev, a) => showTip(ev, `${a.data.n}: ${a.data.v} (${pct(a.data.v / total)})`)).on('mouseleave', hideTip);
    g.append('text').attr('text-anchor', 'middle').attr('dy', '-0.1em').style('font-size', '30px').style('font-weight', 800).style('fill', 'var(--fg)').text(total);
    g.append('text').attr('text-anchor', 'middle').attr('dy', '1.5em').style('font-size', '12px').text(centreLabel);
    const lg = svg.append('g').attr('transform', `translate(${S + 22},${R - (parts.length * 26) / 2 + 6})`);
    parts.forEach((p, i) => {
      const row = lg.append('g').attr('transform', `translate(0,${i * 26})`);
      row.append('circle').attr('r', 5).attr('cx', 5).attr('cy', 0).attr('fill', p.c);
      row.append('text').attr('x', 18).attr('dy', '0.35em').style('font-size', '13px').style('fill', 'var(--fg)').text(p.n);
      row.append('text').attr('x', 170).attr('dy', '0.35em').attr('text-anchor', 'end').style('font-size', '13px').text(`${p.v} (${pct(p.v / total)})`);
    });
  }

  function trendChart(target, tasks, f) {
    const box = $(target);
    box.replaceChildren();
    const end = f.to > TODAY ? TODAY : f.to;
    const from = f.from < addDays(end, -55) ? f.from : addDays(end, -55);  // at least 8 weeks
    const weeks = [];
    for (let w = monday(from); w <= end; w = addDays(w, 7)) {
      const s = onTime(tasks, w, addDays(w, 6));
      weeks.push({ w, ...s });
    }
    const pts = weeks.filter((d) => d.n > 0);
    if (!pts.length) { box.append(el('div', { class: 'empty' }, 'No finished tasks with a deadline in this range.')); return; }
    const W = Math.max(box.clientWidth, 280), H = 200, m = { t: 18, r: 14, b: 26, l: 38 };
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scalePoint().domain(weeks.map((d) => d.w)).range([m.l, W - m.r]).padding(0.3);
    const lo = Math.min(0.5, Math.floor((d3.min(pts, (d) => d.rate) - 0.05) * 10) / 10);
    const y = d3.scaleLinear().domain([Math.max(0, lo), 1]).range([H - m.b, m.t]);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('.0%')).tickSize(-(W - m.l - m.r))).call((g) => g.select('.domain').remove());
    const step = Math.ceil(weeks.length / Math.max(1, Math.floor(W / 64)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(weeks.filter((_, i) => i % step === 0).map((d) => d.w)).tickFormat(fmtDay).tickSize(0).tickPadding(8)).call((g) => g.select('.domain').remove());
    svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(TARGET)).attr('y2', y(TARGET)).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '4 4').attr('stroke-width', 1.5);
    svg.append('path').datum(pts).attr('fill', 'var(--brand-soft)').attr('opacity', 0.6)
      .attr('d', d3.area().x((d) => x(d.w)).y0(H - m.b).y1((d) => y(d.rate)).curve(d3.curveMonotoneX));
    svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--brand)').attr('stroke-width', 2)
      .attr('d', d3.line().x((d) => x(d.w)).y((d) => y(d.rate)).curve(d3.curveMonotoneX));
    svg.append('g').selectAll('circle').data(pts).join('circle').attr('cx', (d) => x(d.w)).attr('cy', (d) => y(d.rate)).attr('r', 4)
      .attr('fill', 'var(--brand)').attr('stroke', 'var(--panel)').attr('stroke-width', 2);
    const last = pts[pts.length - 1];
    svg.append('text').attr('x', x(last.w) - 6).attr('y', Math.max(m.t + 10, y(last.rate) - 10)).attr('text-anchor', 'end').style('font-weight', 700).style('fill', 'var(--brand)').text(pct(last.rate));
    // hover: one wide hit target per week
    const bw = (W - m.l - m.r) / weeks.length;
    svg.append('g').selectAll('rect').data(weeks).join('rect').attr('x', (d) => x(d.w) - bw / 2).attr('width', bw).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => showTip(ev, d.n ? `Week of ${fmtDay(d.w)}: ${d.ok} of ${d.n} on time (${pct(d.rate)})` : `Week of ${fmtDay(d.w)}: no finished tasks with a deadline`)).on('mouseleave', hideTip);
  }

  function timeChart(rows) {
    const box = $('#chart-time');
    box.replaceChildren();
    const key = state.grain === 'day' ? (r) => r.date : state.grain === 'week' ? (r) => r.week : (r) => r.month;
    const label = state.grain === 'day' ? (k) => fmtDay(k) : state.grain === 'week' ? (k, r) => (r && r.week_label) || k : (k, r) => (r && r.month_label) || k;
    const map = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, { k, v: 0, l: label(k, r) });
      map.get(k).v += r.hours;
    }
    const data = [...map.values()].sort((a, b) => (a.k < b.k ? -1 : 1));
    if (!data.length) { box.append(el('div', { class: 'empty' }, 'No hours in this selection.')); return; }
    const W = Math.max(box.clientWidth, 280), H = 210, m = { t: 10, r: 8, b: 26, l: 38 };
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleBand().domain(data.map((d) => d.k)).range([m.l, W - m.r]).padding(0.3);
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) || 1]).nice().range([H - m.b, m.t]);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => v + 'h').tickSize(-(W - m.l - m.r))).call((g) => g.select('.domain').remove());
    const step = Math.ceil(data.length / Math.max(1, Math.floor(W / 70)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(data.filter((_, i) => i % step === 0).map((d) => d.k)).tickFormat((k) => data.find((d) => d.k === k).l).tickSize(0).tickPadding(8)).call((g) => g.select('.domain').remove());
    svg.append('g').selectAll('path').data(data).join('path').attr('fill', 'var(--brand)')
      .attr('d', (d) => { const x0 = x(d.k), w = x.bandwidth(), y0 = y(0), y1 = y(d.v), r = Math.min(4, w / 2, y0 - y1); return `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + w - r}Q${x0 + w},${y1} ${x0 + w},${y1 + r}V${y0}Z`; })
      .on('mousemove', (ev, d) => showTip(ev, `${d.l}: ${h(d.v)}`)).on('mouseleave', hideTip);
  }

  function gantt(projects) {
    const box = $('#gantt');
    box.replaceChildren();
    const w0 = addDays(TODAY, -7), w1 = addDays(TODAY, 28);
    const rows = projects.filter((p) => p.health !== 'Completed' && p.deadline && p.deadline >= w0 && p.deadline <= w1)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)).slice(0, 14);
    $('#gantt-legend').innerHTML = HEALTH.map((x) => `<i class="sw" style="background:${x.c}"></i>${x.k}`).join(' ');
    if (!rows.length) { box.append(el('div', { class: 'empty' }, 'No open projects due in the next 4 weeks.')); return; }
    const W = Math.max(box.clientWidth, 320), RH = 26, labelW = Math.min(220, W * 0.36), m = { t: 22, r: 10, b: 6 };
    const H = m.t + rows.length * RH + m.b;
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleUtc().domain([new Date(w0 + 'T00:00:00Z'), new Date(addDays(w1, 1) + 'T00:00:00Z')]).range([labelW, W - m.r]);
    const ticks = d3.utcMonday.range(x.domain()[0], x.domain()[1]);
    svg.append('g').selectAll('line').data(ticks).join('line').attr('x1', x).attr('x2', x).attr('y1', m.t - 4).attr('y2', H).attr('stroke', 'var(--line)');
    const todayX = x(new Date(TODAY + 'T12:00:00Z'));
    svg.append('g').selectAll('text').data(ticks.filter((d) => Math.abs(x(d) - todayX) > 34)).join('text').attr('x', x).attr('y', 12).attr('text-anchor', 'middle').text((d) => fmtDay(iso(d)));
    const tx = x(new Date(TODAY + 'T12:00:00Z'));
    svg.append('line').attr('x1', tx).attr('x2', tx).attr('y1', m.t - 4).attr('y2', H).attr('stroke', 'var(--brand)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', tx).attr('y', m.t - 8).attr('text-anchor', 'middle').style('fill', 'var(--brand)').style('font-weight', 700).text('Today');
    rows.forEach((p, i) => {
      const yy = m.t + i * RH;
      const name = `${p.project} · ${p.service_group}`;
      svg.append('text').attr('x', 0).attr('y', yy + RH / 2).attr('dy', '0.35em').style('fill', 'var(--fg)').style('font-size', '12px')
        .text(name.length > (labelW - 14) / 6.8 ? name.slice(0, Math.floor((labelW - 14) / 6.8) - 1) + '…' : name).append('title').text(name);
      const s = p.start && p.start > w0 ? p.start : w0;
      const x0 = x(new Date(s + 'T00:00:00Z')), x1 = Math.max(x0 + 6, x(new Date(addDays(p.deadline, 1) + 'T00:00:00Z')));
      svg.append('rect').attr('x', x0).attr('y', yy + 6).attr('width', x1 - x0).attr('height', RH - 12).attr('rx', 4)
        .attr('fill', HEALTH_COLOR[p.health] || 'var(--brand)').attr('opacity', 0.9)
        .on('mousemove', (ev) => showTip(ev, `${p.project} (${p.service_group}) · ${p.health} · due ${fmtDay(p.deadline)} · ${p.done}/${p.total} tasks done${p.issue ? ' · ' + p.issue : ''}`))
        .on('mouseleave', hideTip);
    });
  }

  function estChart(projects) {
    const box = $('#est-chart');
    box.replaceChildren();
    const by = d3.rollups(projects, (v) => ({ est: d3.sum(v, (p) => p.est_hours || 0), log: d3.sum(v, (p) => p.logged_hours || 0) }), (p) => p.service)
      .filter(([, v]) => v.est || v.log).sort((a, b) => b[1].est + b[1].log - (a[1].est + a[1].log)).slice(0, 8);
    if (!by.length) { box.append(el('div', { class: 'empty' }, 'No estimated or logged effort on these projects in Rework yet.')); return; }
    const W = Math.max(box.clientWidth, 300), H = 220, m = { t: 14, r: 8, b: 30, l: 44 };
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
    const x0 = d3.scaleBand().domain(by.map((d) => d[0])).range([m.l, W - m.r]).padding(0.25);
    const x1 = d3.scaleBand().domain(['log', 'est']).range([0, x0.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear().domain([0, d3.max(by, (d) => Math.max(d[1].est, d[1].log)) || 1]).nice().range([H - m.b, m.t]);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => v + 'h').tickSize(-(W - m.l - m.r))).call((g) => g.select('.domain').remove());
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x0).tickSize(0).tickPadding(8).tickFormat((s) => { const n = Math.max(4, Math.floor(x0.bandwidth() / 6.5)); return s.length > n ? s.slice(0, n - 1) + '…' : s; })).call((g) => g.select('.domain').remove());
    const g = svg.append('g').selectAll('g').data(by).join('g').attr('transform', (d) => `translate(${x0(d[0])},0)`);
    g.selectAll('rect').data((d) => [['log', d[1].log, d[0], d[1]], ['est', d[1].est, d[0], d[1]]]).join('rect')
      .attr('x', (d) => x1(d[0])).attr('width', x1.bandwidth()).attr('y', (d) => y(d[1])).attr('height', (d) => y(0) - y(d[1])).attr('rx', 3)
      .attr('fill', (d) => (d[0] === 'log' ? 'var(--brand)' : 'var(--soft)'))
      .on('mousemove', (ev, d) => showTip(ev, `${d[2]}: ${h(d[3].log)} logged of ${h(d[3].est)} estimated${d[3].est ? ` (${pct(d[3].log / d[3].est)})` : ''}`)).on('mouseleave', hideTip);
  }

  function listItems(target, items, empty) {
    const ul = $(target);
    if (!items.length) { ul.replaceChildren(el('li', { class: 'empty' }, empty)); return; }
    ul.replaceChildren(...items);
  }

  function taskLi(t, right) {
    const li = el('li');
    const left = el('span', { class: 't' });
    left.append(t.url ? el('a', { href: t.url, target: '_blank', rel: 'noopener' }, t.name) : document.createTextNode(t.name));
    left.append(el('small', {}, [t.client, t.assignee || 'Unassigned'].filter(Boolean).join(' · ')));
    li.append(left, right);
    return li;
  }

  // ---------- tabs ----------
  function drawDashboard(f) {
    const tasks = scopeTasks(f);
    const projects = projectRows(f);
    const active = projects.filter((p) => p.health !== 'Completed');
    const onTrack = active.filter((p) => p.health === 'On track').length;
    const ot = onTime(tasks, f.from, f.to);
    const span = daysBetween(f.from, f.to) + 1;
    const prev = onTime(tasks, addDays(f.from, -span), addDays(f.from, -1));
    const diff = Number.isFinite(ot.rate) && Number.isFinite(prev.rate) ? Math.round((ot.rate - prev.rate) * 100) : null;
    const overdue = tasks.filter((t) => t.st === 'overdue');
    const rows = sessionRows(f);
    const [hf, ht] = hoursWindow(f);
    kpis('#dash-kpis', [
      { icon: 'layers', val: String(active.length), lbl: 'Active projects', sub: `${onTrack} on track (${pct(active.length ? onTrack / active.length : NaN)})` },
      { icon: 'target', val: pct(ot.rate), lbl: 'On-time delivery', sub: diff === null ? `${ot.ok} of ${ot.n} tasks finished on time` : `${diff >= 0 ? '▲ +' : '▼ '}${diff} pp vs prior period`, trend: diff === null ? '' : diff >= 0 ? 'up' : 'down' },
      { icon: 'clock', val: h(sum(rows)), lbl: 'Hours logged', sub: `${fmtDay(hf)} – ${fmtDay(ht)}`, demo: true },
      { icon: 'alert', val: String(overdue.length), lbl: 'Overdue tasks', sub: `across ${new Set(overdue.map((t) => t.project_id)).size} projects` },
    ]);

    const counts = HEALTH.map((x) => ({ n: x.k, v: active.filter((p) => p.health === x.k).length, c: x.c }));
    donut('#health-donut', counts, 'Projects');
    trendChart('#trend', tasks, f);

    const od = overdue.slice().sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
    $('#overdue-num').replaceChildren(document.createTextNode(String(od.length)));
    listItems('#overdue-list', od.slice(0, 5).map((t) => taskLi(t, pill(`${daysBetween(t.deadline, TODAY)}d overdue`, 'bad'))), 'Nothing overdue.');

    const sev = { Delayed: 0, 'At risk': 1, 'On hold': 2 };
    const attn = active.filter((p) => p.health === 'Delayed' || p.health === 'At risk').sort((a, b) => sev[a.health] - sev[b.health] || b.overdue - a.overdue || (a.deadline || '9').localeCompare(b.deadline || '9'));
    $('#attn-count').textContent = `(${attn.length})`;
    table('#attn-table', attn.map((p) => [linkOrText(p.project, p.url, p.service), p.service_group, pill(p.health, HEALTH_PILL[p.health]), fmtDay(p.deadline), p.issue]), 'No project needs attention.');

    bars('#bars-service', groupSum(rows, (r) => r.service), { limit: 8 });
  }

  function drawDelivery(f) {
    const all = scopeTasks(f);
    const tasks = all.filter((t) => inRange(t, f));
    const projects = projectRows(f);
    const active = projects.filter((p) => p.health !== 'Completed');
    const risky = active.filter((p) => p.health === 'At risk' || p.health === 'Delayed');
    const ot = onTime(all, f.from, f.to);
    const done = tasks.filter((t) => t.st === 'done').length;
    kpis('#deliv-kpis', [
      { icon: 'target', val: pct(ot.rate), lbl: 'On-time delivery', sub: `${ot.ok} of ${ot.n} finished on time` },
      { icon: 'layers', val: String(active.length), lbl: 'Active projects', sub: `${projects.length - active.length} completed` },
      { icon: 'alert', val: String(risky.length), lbl: 'Projects at risk', sub: `${risky.filter((p) => p.health === 'Delayed').length} delayed` },
      { icon: 'check', val: `${done} / ${tasks.length}`, lbl: 'Tasks completed', sub: `${pct(tasks.length ? done / tasks.length : NaN)} of tasks due or done in range` },
    ]);
    gantt(projects);
    const n = (s) => tasks.filter((t) => t.st === s).length;
    donut('#donut', [
      { n: 'Completed', v: n('done'), c: 'var(--brand)' },
      { n: 'In progress', v: n('open'), c: 'var(--brand-2)' },
      { n: 'Not started', v: n('scheduled'), c: 'var(--hold)' },
      { n: 'Overdue', v: n('overdue'), c: 'var(--bad)' },
    ], 'Tasks');
    trendChart('#trend2', all, f);

    const soon = all.filter((t) => isOpen(t) && t.deadline && t.deadline >= TODAY && t.deadline <= addDays(TODAY, 7)).sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
    listItems('#due-list', soon.slice(0, 8).map((t) => taskLi(t, pill(t.deadline === TODAY ? 'Today' : fmtDay(t.deadline), t.deadline <= addDays(TODAY, 1) ? 'warn' : 'brand'))), 'Nothing due in the next 7 days.');

    const open = all.filter(isOpen);
    const risks = [
      ['Overdue tasks', all.filter((t) => t.st === 'overdue').length, 'var(--bad)'],
      ['Projects past their deadline', active.filter((p) => p.dueIn !== null && p.dueIn < 0).length, 'var(--bad)'],
      ['Open tasks with no assignee', open.filter((t) => !t.assignee).length, 'var(--warn)'],
      ['Open tasks with no deadline', open.filter((t) => !t.deadline).length, 'var(--warn)'],
      ['Due in the next 2 days', soon.filter((t) => t.deadline <= addDays(TODAY, 2)).length, 'var(--brand)'],
    ];
    listItems('#risk-list', risks.map(([lbl, v, c]) => { const li = el('li'); li.append(el('span', { class: 'dot', style: `background:${c}` }), el('span', {}, lbl), el('span', { class: 'n' }, String(v))); return li; }), '');

    const od = all.filter((t) => t.st === 'overdue').sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
    table('#overdue-table', od.map((t) => [linkOrText(t.name, t.url, t.project), t.client, t.assignee || '—', fmtDay(t.deadline), [`${daysBetween(t.deadline, TODAY)}d`, 'num bad']]), 'Nothing overdue.');

    const byClient = d3.rollups(tasks, (v) => {
      const o = onTime(v, f.from, f.to);
      return { done: v.filter((t) => t.st === 'done').length, total: v.length, overdue: v.filter((t) => t.st === 'overdue').length, ot: o.rate };
    }, (t) => t.client).sort((a, b) => b[1].total - a[1].total);
    table('#deliv-table', byClient.map(([k, v]) => [k, [v.done, 'num'], [v.total, 'num'], [pct(v.total ? v.done / v.total : NaN), 'num'], [v.overdue, v.overdue ? 'num bad' : 'num'], [pct(v.ot), 'num']]));
  }

  function drawTeam(f) {
    const rows = sessionRows(f, { ignorePerson: true });
    const [hf, ht] = hoursWindow(f);
    const days = workdays(hf, ht);
    const tasks = scopeTasks(f, { ignorePerson: true });
    const open = tasks.filter(isOpen);
    const scopePeople = DATA.people.filter((p) => !f.team || p.team === f.team);
    const logged = new Set(rows.map((r) => r.person));
    const total = sum(rows);
    const cap = scopePeople.length * days * BENCH_PER_DAY;
    kpis('#team-kpis', [
      { icon: 'people', val: `${scopePeople.filter((p) => logged.has(p.person)).length} of ${scopePeople.length}`, lbl: 'People logging time', sub: `${pct(scopePeople.length ? scopePeople.filter((p) => logged.has(p.person)).length / scopePeople.length : NaN)} of the team`, demo: true },
      { icon: 'clock', val: h(total), lbl: 'Hours logged', sub: `${days} working days · ${fmtDay(hf)} – ${fmtDay(ht)}`, demo: true },
      { icon: 'target', val: pct(cap ? total / cap : NaN), lbl: 'Utilisation', sub: `of ${h(cap)} capacity (8h × working days)`, demo: true },
      { icon: 'list', val: String(open.length), lbl: 'Open tasks assigned', sub: `${open.filter((t) => t.st === 'overdue').length} overdue · ${open.filter((t) => !t.assignee).length} unassigned` },
    ]);

    const teams = [...new Set(DATA.people.map((p) => p.team))].filter((t) => !f.team || t === f.team).sort();
    bars('#bars-util', teams.map((team) => {
      const n = DATA.people.filter((p) => p.team === team).length;
      return [team, n && days ? sum(rows.filter((r) => r.team === team)) / (n * days * BENCH_PER_DAY) : 0];
    }).sort((a, b) => b[1] - a[1]), { fmt: pct, limit: 20, color: (t) => 'var(--brand)' });

    estChart(projectRows(f));

    // workload per person: open tasks, split into overdue / due in 7 days / later
    const box = $('#workload');
    const people = d3.rollups(open.filter((t) => t.assignee), (v) => ({
      overdue: v.filter((t) => t.st === 'overdue').length,
      soon: v.filter((t) => t.st !== 'overdue' && t.deadline && t.deadline <= addDays(TODAY, 7)).length,
      total: v.length,
    }), (t) => t.assignee).sort((a, b) => b[1].total - a[1].total);
    if (!people.length) box.replaceChildren(el('div', { class: 'empty' }, 'No open tasks assigned.'));
    else {
      const max = people[0][1].total;
      box.replaceChildren(...people.map(([name, v]) => {
        const row = el('div', { class: 'bar-row click', title: `${name}: ${v.total} open · ${v.soon} due in 7 days · ${v.overdue} overdue` });
        const track = el('div', { class: 'track', style: 'background:transparent' });
        const later = v.total - v.overdue - v.soon;
        for (const [n, c] of [[v.overdue, 'var(--bad)'], [v.soon, 'var(--warn)'], [later, 'var(--brand)']]) if (n) track.append(el('div', { class: 'fill', style: `width:${(n / max) * 100}%;background:${c}` }));
        const val = el('span', { class: 'v' });
        val.append(el('b', {}, String(v.total)), document.createTextNode(v.overdue ? ` · ${v.overdue} late` : ''));
        row.append(el('span', { class: 'name' }, name), track, val);
        row.addEventListener('click', () => { $('#f-person').value = name; draw(); });
        return row;
      }));
    }

    timeChart(sessionRows(f));

    const tbox = $('#team-tables');
    tbox.replaceChildren();
    for (const team of teams) {
      const members = DATA.people.filter((p) => p.team === team);
      const trows = rows.filter((r) => r.team === team);
      const teamHours = sum(trows);
      const teamOpen = open.filter((t) => t.team === team).length;
      const stats = members.map((p) => {
        const pr = trows.filter((r) => r.person === p.person);
        return { name: p.person, hours: sum(pr), logged: new Set(pr.map((r) => r.item_id || r.task)).size, open: open.filter((t) => t.assignee === p.person).length };
      }).sort((a, b) => b.hours - a.hours);
      const maxH = Math.max(...stats.map((s) => s.hours), 0.0001);
      const block = el('div', { class: 'team-block' });
      block.append(el('h3', {}, `${team} · ${h(teamHours)} · ${teamOpen} open tasks · ${members.length} people`));
      const t = el('table', { class: 'tbl' });
      t.append(el('thead'), el('tbody'));
      const head = el('tr');
      for (const [txt, cls] of [['Person', ''], ['Hours', 'num'], ['% of team hours', 'num'], ['Tasks logged on', 'num'], ['Open tasks', 'num'], ['% of team open tasks', 'num']]) head.append(el('th', cls ? { class: cls } : {}, txt));
      t.tHead.append(head);
      const cs = getComputedStyle(document.documentElement);
      const heatOf = d3.interpolateRgb(cs.getPropertyValue('--heat0').trim(), cs.getPropertyValue('--heat1').trim());
      for (const s of stats) {
        const tr = el('tr');
        const hc = el('td', { class: 'num' });
        hc.append(el('span', { class: 'heat', style: `background:${heatOf(s.hours / maxH)};color:${s.hours / maxH > 0.55 ? '#fff' : 'inherit'}` }, h(s.hours)));
        tr.append(el('td', {}, s.name), hc, el('td', { class: 'num' }, pct(teamHours ? s.hours / teamHours : NaN)), el('td', { class: 'num' }, String(s.logged)),
          el('td', { class: 'num' }, String(s.open)), el('td', { class: 'num' }, pct(teamOpen ? s.open / teamOpen : NaN)));
        t.tBodies[0].append(tr);
      }
      block.append(t);
      tbox.append(block);
    }

    bars('#bars-project', groupSum(sessionRows(f), (r) => `${r.project} (${r.service_group})`));
    const card = $('#person-card');
    card.hidden = !f.person;
    if (f.person) {
      $('#person-title').textContent = `${f.person} — open tasks`;
      const mine = scopeTasks(f).filter(isOpen).sort((a, b) => ((a.deadline || '9') < (b.deadline || '9') ? -1 : 1));
      const label = { overdue: ['Overdue', 'bad'], open: ['In progress', 'brand'], scheduled: ['Not started', 'hold'] };
      table('#person-tasks', mine.map((t) => [linkOrText(t.name, t.url, t.project), t.client, pill(...label[t.st]), fmtDay(t.deadline)]), 'No open tasks.');
    }
  }

  function drawManagement(f) {
    const rows = sessionRows(f);
    const internal = rows.filter((r) => r.clockin || /internal|admin|unravel/i.test(r.service_group));
    const rev = rows.filter((r) => r.revision);
    kpis('#mgmt-kpis', [
      { icon: 'clock', val: h(sum(rows) - sum(internal)), lbl: 'Client hours', sub: `${new Set(rows.map((r) => r.service_group)).size} clients`, demo: true },
      { icon: 'flag', val: h(sum(rev)), lbl: 'Revision time', sub: `${rev.length} logs on ${new Set(rev.map((r) => r.item_id || r.task)).size} tasks`, demo: true },
      { icon: 'people', val: h(sum(internal)), lbl: 'Internal & clock-in', sub: `${pct(sum(rows) ? sum(internal) / sum(rows) : NaN)} of hours`, demo: true },
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
    const open = scopeTasks(f).filter(isOpen);
    const missing = open.map((t) => [t, [!t.assignee && 'assignee', !t.deadline && 'deadline', !t.item_type && 'work item type'].filter(Boolean)]).filter(([, m]) => m.length);
    const stale = open.filter((t) => t.st === 'overdue' && t.stage && DONE_STAGE.test(t.stage));
    const all = sessionRows(f, { keepRunaway: true });
    const run = all.filter((r) => r.runaway || r.hours > RUNAWAY_HOURS);
    const untitled = all.filter((r) => !r.runaway && isUntitled(r));
    kpis('#dq-kpis', [
      { icon: 'list', val: String(missing.length), lbl: 'Open tasks missing data', sub: `${pct(open.length ? missing.length / open.length : NaN)} of ${open.length} open tasks` },
      { icon: 'check', val: String(stale.length), lbl: 'Overdue but probably finished', sub: 'in a done-like stage' },
      { icon: 'clock', val: String(run.length), lbl: 'Timers >12h', sub: `${h(sum(run))} left out`, demo: true },
      { icon: 'flag', val: `${untitled.length}`, lbl: 'Logs without a title', sub: `${pct(all.length ? untitled.length / all.length : NaN)} of ${all.length} logs`, demo: true },
    ]);
    table('#missing-table', missing.slice(0, 300).map(([t, m]) => [linkOrText(t.name, t.url, t.project), t.client, m.join(', ')]), 'Every open task has an assignee, deadline and type.');
    table('#stale-table', stale.map((t) => [linkOrText(t.name, t.url, t.client), t.stage, fmtDay(t.deadline)]), 'None found.');
    table('#runaway-table', run.sort((a, b) => b.hours - a.hours).map((r) => [r.person, r.date, r.task, [h(r.hours), 'num']]), 'None.');
    const by = new Map();
    for (const r of untitled) by.set(r.person, (by.get(r.person) || 0) + 1);
    bars('#untitled-list', [...by.entries()].sort((a, b) => b[1] - a[1]), { fmt: String, limit: 40 });
  }

  function draw() {
    const f = filters();
    document.querySelectorAll('[data-demo]').forEach((b) => { b.hidden = !HOURS_DEMO; });
    ({ dashboard: drawDashboard, team: drawTeam, delivery: drawDelivery, management: drawManagement, quality: drawQuality })[state.tab](f);
  }

  // ---------- export ----------
  function exportCsv() {
    const f = filters();
    const rows = scopeTasks(f).filter((t) => inRange(t, f));
    const cols = ['client', 'service', 'project', 'name', 'assignee', 'team', 'item_type', 'stage', 'st', 'start', 'deadline', 'finished', 'url'];
    const head = ['Client', 'Service', 'Project', 'Task', 'Assignee', 'Team', 'Work item type', 'Stage', 'State', 'Start', 'Deadline', 'Finished', 'Link'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head.map(q).join(','), ...rows.map((t) => cols.map((c) => q(t[c])).join(','))].join('\r\n');
    const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `unravel-tasks-${f.from}-to-${f.to}.csv` });
    document.body.append(a); a.click(); a.remove();
  }

  // ---------- wiring ----------
  function setTab(tab) {
    state.tab = PAGES[tab] ? tab : 'dashboard';
    document.querySelectorAll('.nav button').forEach((x) => x.classList.toggle('on', x.dataset.tab === state.tab));
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + state.tab; });
    const [eb, title, sub] = PAGES[state.tab];
    $('#eyebrow').textContent = eb; $('#page-title').textContent = title; $('#page-sub').textContent = sub;
    history.replaceState(null, '', '#' + state.tab);
    draw();
  }
  document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.goto)));
  document.querySelectorAll('#grain button').forEach((b) => b.addEventListener('click', () => {
    state.grain = b.dataset.g;
    document.querySelectorAll('#grain button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  }));
  for (const k of [...F, 'runaway']) $('#f-' + k).addEventListener('change', () => { if (k === 'client' || k === 'team') refreshOptions(); draw(); });
  $('#f-reset').addEventListener('click', () => { resetFilters(); refreshOptions(); draw(); });
  $('#more-toggle').addEventListener('click', (e) => { const m = $('#more'); m.hidden = !m.hidden; e.currentTarget.setAttribute('aria-expanded', String(!m.hidden)); });
  $('#export').addEventListener('click', exportCsv);
  let width = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - width) > 8) { width = innerWidth; draw(); } });

  // ---------- data loading ----------
  // Tasks and projects come live from /api/data (Rework, cached by Vercel for 5 minutes). The last
  // answer is kept in this browser so the page draws at once; the bundled files are the fallback.
  const CACHE_KEY = 'udm-live-v1';
  const syncBtn = $('#sync');
  const syncNote = $('#sync-note');
  const fmtTime = (s) => new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function setLive(live) {
    DATA.tasks = live.tasks.map((t) => ({ ...t, st: taskState(t) }));
    DATA.projects = live.projects;
    DATA.sync = { ...(DATA.sync || {}), ...live.sync };
  }

  function note(text, bad = false) {
    syncNote.textContent = text;
    syncNote.classList.toggle('bad', bad);
  }
  const syncedText = () => (DATA.sync && DATA.sync.updated_at ? `Updated ${fmtTime(DATA.sync.updated_at)}` : 'Not synced yet');

  async function fetchLive(fresh) {
    const r = await fetch('/api/data' + (fresh ? `?fresh=${Date.now()}` : ''), { cache: fresh ? 'no-store' : 'default' });
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || body.error) { const e = new Error(body.error || `HTTP ${r.status}`); e.status = r.status; e.body = body; throw e; }
    return body;
  }

  async function refresh(fresh) {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    const t0 = Date.now();
    const tick = setInterval(() => note(`Syncing with Rework… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
    note('Syncing with Rework…');
    try {
      const live = await fetchLive(fresh);
      setLive(live);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(live)); } catch { /* storage full or blocked: fine */ }
      refreshOptions();
      draw();
      note(syncedText());
    } catch (e) {
      if (e.status === 503) {
        const b = e.body || {};
        note(`${syncedText()} · live sync not set up: server sees ${b.has_key ? '' : 'no '}REWORK_API_KEY, ${b.has_password ? '' : 'no '}REWORK_API_PASSWORD` +
          ` (variables found: ${(b.variables_seen || []).join(', ') || 'none'}; ${b.environment || '?'}${b.commit ? ' ' + b.commit : ''})`, true);
      }
      else if (e.status === 429) note(`${syncedText()} · Rework limit reached, Sync again in about ${Math.max(1, Math.ceil(((e.body && e.body.retry_after) || 60) / 60))} min. The data shown is still valid.`, true);
      else note(`${syncedText()} · sync failed (${e.message})`, true);
    } finally {
      clearInterval(tick);
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync';
    }
  }

  syncBtn.addEventListener('click', () => refresh(true));

  (async () => {
    try {
      const [sessions, projects, people, meta, tasks, sync] = await Promise.all([
        load('sessions', []), load('projects'), load('people'), load('meta', {}), load('tasks', []), load('sync', null)]);
      DATA = {
        sessions: sessions.map((r) => ({ ...r, hours: Number(r.hours) || 0, runaway: r.runaway === true || r.runaway === 'true' })),
        projects, people, meta, sync,
        tasks: tasks.map((t) => ({ ...t, st: taskState(t) })),
      };
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { cached = null; }
      if (cached && cached.sync && (!sync || cached.sync.updated_at > sync.updated_at)) setLive(cached);
      HOURS_DEMO = !DATA.sync || DATA.sync.hours_source !== 'rework';
      resetFilters();
      refreshOptions();
      setTab(location.hash.slice(1));
      note(syncedText());
    } catch (e) {
      $('#page-sub').textContent = 'Could not load data: ' + e.message;
      return;
    }
    refresh(false);
  })();
})();
