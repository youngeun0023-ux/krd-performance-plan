(function () {
  const listeners = new Set();
  let serial = 0;
  let busy = false;
  function emit(rows, error) { listeners.forEach(fn => fn(rows,error,!error)); }
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
  async function write(action,fields) {
    const requestId = crypto.randomUUID();
    const url = endpoint();
    // The opaque HTTP response is NOT a save acknowledgement.
    await fetch(url,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({action,requestId,...fields})});
    const start = Date.now();
    while (Date.now()-start < 30000) {
      const payload = await read(requestId);
      if (payload.operation) {
        if (!payload.operation.ok) throw new Error(payload.operation.error || '저장 실패');
        emit(payload.comments,null);
        return;
      }
      await new Promise(resolve => setTimeout(resolve,1000));
    }
    throw new Error('저장 확인이 지연됩니다. 댓글 목록을 확인해주세요.');
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
