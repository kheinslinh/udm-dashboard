// Minimal stand-in for the Claude dashboard runtime, so the page runs as a static site.
// Loads data/*.json, then mounts the page from <template id="dash-page"> and runs its scripts.
(() => {
  const DATASETS = ['sessions', 'projects', 'people'];
  const store = {};
  const calcs = {};
  const listeners = [];
  let params = {};

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const dash = {
    colors: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--chart-${i})`),
    data(id) {
      if (calcs[id]) {
        const c = calcs[id];
        const ins = c.inputs.map((i) => dash.data(i));
        if (ins.some((x) => x.status !== 'ok')) return { status: ins.find((x) => x.status !== 'ok').status, data: [] };
        try {
          const data = c.fn(...ins.map((x) => x.data));
          return { status: 'ok', data, rows: data, columns: data[0] ? Object.keys(data[0]) : [], meta: [] };
        } catch (e) {
          return { status: 'error', data: [], message: String(e) };
        }
      }
      return store[id] || { status: 'missing', data: [] };
    },
    onData(fn) {
      listeners.push(fn);
      fn();
    },
    calc(id, spec) {
      calcs[id] = spec;
    },
    loader() {},
    params: () => ({ ...params }),
    setParams(ch) {
      for (const [k, v] of Object.entries(ch)) {
        if (v === null || v === undefined || v === '') delete params[k];
        else params[k] = v;
      }
      emit();
    },
    resetParams() {
      params = {};
      emit();
    },
    setLink(name) {
      history.replaceState(null, '', name ? `#${name}` : location.pathname);
    },
    refresh() {},
    css,
  };

  function emit() {
    for (const fn of listeners) fn();
  }

  let width = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - width) < 8) return;
    width = window.innerWidth;
    emit();
  });

  window.dash = dash;

  async function loadJSON(name) {
    const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
    return res.json();
  }

  function mount() {
    const root = document.getElementById('dash-root');
    root.appendChild(document.getElementById('dash-page').content.cloneNode(true));
    // Scripts cloned from a template do not run; re-create them in order.
    for (const old of root.querySelectorAll('script')) {
      const s = document.createElement('script');
      s.textContent = old.textContent;
      old.replaceWith(s);
    }
  }

  (async () => {
    try {
      window.UDM_META = await loadJSON('meta');
    } catch (e) {
      window.UDM_META = {};
    }
    for (const id of DATASETS) store[id] = { status: 'loading', data: [] };
    mount();
    await Promise.all(DATASETS.map(async (id) => {
      try {
        const data = await loadJSON(id);
        store[id] = { status: 'ok', data, rows: data, columns: data[0] ? Object.keys(data[0]) : [], meta: [] };
      } catch (e) {
        store[id] = { status: 'error', data: [], message: String(e) };
      }
    }));
    emit();
  })();
})();
