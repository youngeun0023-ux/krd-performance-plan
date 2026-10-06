(function () {
  const listeners = new Set();
  const pending = new Map();
  const CACHE_KEY = 'krd-shared-comments-v2';
  let serial = 0, started = false, inFlight = null, pollTimer = null;
  let latestRows = null, lastRequestAt = 0, errors = 0, queued = false, activeRead = null;
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cache && Array.isArray(cache.rows)) latestRows = cache.rows;
  } catch (_) {}
  function emit(rows, error, meta) {
    if (rows && !error) {
      latestRows = rows;
      if (!(meta && meta.cached)) {
        try { localStorage.setItem(CACHE_KEY,JSON.stringify({rows,at:Date.now()})); } catch (_) {}
        for (const operation of [...pending.values()]) {
          if (operation.confirmed(rows)) operation.finish(null);
        }
      }
    }
    listeners.forEach(fn => fn(rows,error,meta || {}));
  }
  function endpoint() {
    const url = window.KRD_SHEETS_URL;
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url || '')) {
      throw new Error('구글시트 연결 설정이 필요합니다.');
    }
    return url;
  }
  function read(requestId) {
    let cancel;
    const promise = new Promise((resolve,reject) => {
      let url;
      try { url = endpoint(); } catch(error) { reject(error); return; }
      const name = 'krd_cb_' + Date.now() + '_' + (++serial);
      const script = document.createElement('script');
      let timer;
      function clean() {
        clearTimeout(timer); script.remove();
        window[name] = () => {};
        setTimeout(() => { delete window[name]; },60000);
      }
      cancel = () => { clean(); const error = new Error('조회 교체'); error.cancelled = true; reject(error); };
      window[name] = payload => { clean(); payload.ok ? resolve(payload) : reject(new Error(payload.error || '조회 실패')); };
      script.onerror = () => { clean(); reject(new Error('구글시트 연결 실패')); };
      timer = setTimeout(() => { clean(); const error = new Error('연결 확인 중 · 마지막으로 확인한 댓글을 표시합니다'); error.delayed = true; reject(error); },35000);
      const params = new URLSearchParams({callback:name,t:String(Date.now())});
      if (requestId) params.set('requestId',requestId);
      script.async = true;
      script.src = url + '?' + params;
      document.head.appendChild(script);
    });
    promise.requestId = requestId;
    promise.cancel = () => { if (cancel) cancel(); };
    return promise;
  }
  function schedule(delay) {
    clearTimeout(pollTimer);
    if (started && (!document.hidden || pending.size)) pollTimer = setTimeout(() => refresh(delay === 0),delay);
  }
  function refresh(force) {
    if (!started) return Promise.resolve();
    if (inFlight) {
      if (force) queued = true;
      // Saving must not wait behind a slow background read.
      if (force && pending.size && activeRead && !activeRead.requestId) activeRead.cancel();
      return inFlight;
    }
    if (document.hidden && !pending.size) return Promise.resolve();
    const elapsed = Date.now() - lastRequestAt;
    if (!force && elapsed < 1000) { schedule(1000-elapsed); return Promise.resolve(); }
    clearTimeout(pollTimer);
    lastRequestAt = Date.now();
    const requestId = pending.keys().next().value;
    activeRead = read(requestId);
    inFlight = activeRead.then(payload => {
      errors = 0;
      const operation = pending.get(requestId);
      if (operation && payload.operation && !payload.operation.ok) {
        operation.finish(new Error(payload.operation.error || '저장 실패'));
      }
      emit(payload.comments,null);
      if (pending.has(requestId) && payload.operation && payload.operation.ok) pending.get(requestId).finish(null);
    }).catch(error => { if (!error.cancelled) { errors++; emit(null,error); } }).finally(() => {
      inFlight = null; activeRead = null;
      const immediate = queued;
      queued = false;
      schedule(immediate ? 0 : errors ? Math.min(10000,2000 * errors) : pending.size ? 1000 : 2000);
    });
    return inFlight;
  }
  function write(action,fields) {
    const requestId = crypto.randomUUID();
    let url;
    try { url = endpoint(); } catch(error) { return Promise.reject(error); }
    const promise = new Promise((resolve,reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => finish(new Error('저장 확인이 지연됩니다. 댓글 목록을 확인한 뒤 다시 시도해주세요.')),45000);
      function finish(error) {
        if (!pending.has(requestId)) return;
        pending.delete(requestId); clearTimeout(timer); controller.abort();
        error ? reject(error) : resolve();
      }
      function confirmed(rows) {
        if (action === 'add') return rows.some(row => row.id === 'm_' + requestId && row.cardId === fields.cardId && row.body === fields.body.trim().slice(0,3000));
        const row = rows.find(row => row.id === fields.id);
        return action === 'resolve' ? !!row && row.resolved === fields.resolved : action === 'delete' && !row;
      }
      pending.set(requestId,{confirmed,finish});
      // Confirm through the shared, single read loop, without awaiting POST redirects.
      fetch(url,{method:'POST',mode:'no-cors',signal:controller.signal,
        headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({action,requestId,...fields})
      }).catch(() => {});
      refresh(true);
    });
    promise.commentId = 'm_' + requestId;
    return promise;
  }
  window.KRDComments = {
    subscribe(fn) {
      listeners.add(fn);
      if (latestRows) fn(latestRows,null,{cached:true});
      if (started) refresh();
      return () => listeners.delete(fn);
    },
    refresh,
    add(cardId,author,body) { return write('add',{cardId,author,body}); },
    resolve(id,resolved) { return write('resolve',{id,resolved}); },
    remove(id) { return write('delete',{id}); }
  };
  function start() {
    if (started) return;
    started = true;
    // Run after load has finished so Google reads cannot prolong page loading.
    setTimeout(() => refresh(true),0);
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load',start,{once:true});
  document.addEventListener('visibilitychange',() => {
    if (!document.hidden) refresh(true);
    else if (!pending.size) clearTimeout(pollTimer);
  });
  window.addEventListener('focus',() => refresh());
})();
