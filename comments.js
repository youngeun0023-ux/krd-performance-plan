(function () {
  const listeners = new Set();
  let serial = 0;
  let busy = false;
  const pending = new Map();
  function emit(rows, error) {
    if (rows && !error) {
      for (const [requestId, operation] of pending) {
        if (operation.confirmed(rows)) operation.finish(null);
      }
    }
    listeners.forEach(fn => fn(rows,error,!error));
  }
  function endpoint() {
    const url = window.KRD_SHEETS_URL;
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url || '')) {
      throw new Error('구글시트 연결 설정이 필요합니다.');
    }
    return url;
  }
  function read(requestId) {
    return new Promise((resolve,reject) => {
      let url;
      try { url = endpoint(); } catch(error) { reject(error); return; }
      const name = 'krd_cb_' + Date.now() + '_' + (++serial);
      const script = document.createElement('script');
      let timer;
      function clean() {
        clearTimeout(timer); script.remove();
        // A response can arrive after a timeout; keep a harmless callback briefly.
        window[name] = () => {};
        setTimeout(() => { delete window[name]; },60000);
      }
      window[name] = payload => { clean(); payload.ok ? resolve(payload) : reject(new Error(payload.error || '조회 실패')); };
      script.onerror = () => { clean(); reject(new Error('구글시트 연결 실패')); };
      timer = setTimeout(() => { clean(); reject(new Error('구글시트 응답 지연')); },20000);
      const params = new URLSearchParams({callback:name,t:String(Date.now())});
      if (requestId) params.set('requestId',requestId);
      script.src = url + '?' + params;
      document.head.appendChild(script);
    });
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try { const payload = await read(); emit(payload.comments,null); }
    catch(error) { emit(null,error); }
    finally { busy = false; }
  }
  function write(action,fields) {
    const requestId = crypto.randomUUID();
    let url;
    try { url = endpoint(); } catch(error) { return Promise.reject(error); }
    return new Promise((resolve,reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => finish(new Error('저장 확인이 지연됩니다. 댓글 목록을 확인한 뒤 다시 시도해주세요.')),45000);
      function finish(error) {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        clearTimeout(timer);
        controller.abort();
        error ? reject(error) : resolve();
      }
      function confirmed(rows) {
        if (action === 'add') {
          return rows.some(row => row.id === 'm_' + requestId && row.cardId === fields.cardId && row.body === fields.body.trim().slice(0,3000));
        }
        const row = rows.find(row => row.id === fields.id);
        if (action === 'resolve') return !!row && row.resolved === fields.resolved;
        return action === 'delete' && !row;
      }
      pending.set(requestId,{confirmed,finish});
      // Start confirmation immediately: Google may store the comment long before
      // its redirect/opaque POST response finishes. HTTP completion is not proof.
      fetch(url,{method:'POST',mode:'no-cors',signal:controller.signal,
        headers:{'Content-Type':'text/plain;charset=UTF-8'},
        body:JSON.stringify({action,requestId,...fields})
      }).catch(() => {});
      (async () => {
        while (pending.has(requestId)) {
          try {
            const payload = await read(requestId);
            if (!pending.has(requestId)) return;
            if (payload.operation && !payload.operation.ok) {
              finish(new Error(payload.operation.error || '저장 실패'));
              return;
            }
            emit(payload.comments,null);
            if (payload.operation && payload.operation.ok) finish(null);
          } catch(error) {
            // A normal refresh can still confirm the exact saved row.
            // Retry transient read/POST errors until the overall deadline.
            if (!pending.has(requestId)) return;
          }
          if (pending.has(requestId)) await new Promise(done => setTimeout(done,1000));
        }
      })();
    });
  }
  window.KRDComments = {
    subscribe(fn) { listeners.add(fn); refresh(); return () => listeners.delete(fn); },
    refresh,
    add(cardId,author,body) { return write('add',{cardId,author,body}); },
    resolve(id,resolved) { return write('resolve',{id,resolved}); },
    remove(id) { return write('delete',{id}); }
  };
  setInterval(() => { if (!document.hidden) refresh(); },2000);
  document.addEventListener('visibilitychange',() => { if (!document.hidden) refresh(); });
  window.addEventListener('focus',refresh);
})();
