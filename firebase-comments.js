(function () {
  const listeners = new Set();
  const CACHE_KEY = 'krd-firestore-comments-v1';
  let latestRows = null, latestMeta = {cached:true}, api, db, auth, ready, readInFlight;
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cache && Array.isArray(cache.rows)) latestRows = cache.rows;
  } catch (_) {}
  function describe(error) {
    if (error && (error.code === 'permission-denied' || error.code === 'firestore/permission-denied')) return new Error('댓글 접근 권한을 확인해주세요.');
    if (error && error.code === 'auth/operation-not-allowed') return new Error('Firebase 익명 로그인을 켜주세요.');
    return new Error('댓글 연결을 확인하고 있습니다 · 잠시 후 다시 시도해주세요.');
  }
  function emit(rows,error,meta) {
    if (rows) {
      latestRows = rows; latestMeta = meta || {};
      if (!latestMeta.cached) {
        try { localStorage.setItem(CACHE_KEY,JSON.stringify({rows,at:Date.now()})); } catch (_) {}
      }
    }
    listeners.forEach(fn => fn(rows,error,meta || {}));
  }
  function rowsOf(snapshot) {
    return snapshot.docs.map(doc => ({...doc.data(),id:doc.id}))
      .sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  }
  function start() {
    if (ready) return ready;
    ready = (async () => {
      const base = 'https://www.gstatic.com/firebasejs/12.19.0/';
      const [appModule,authModule,firestoreModule] = await Promise.all([
        import(base+'firebase-app.js'), import(base+'firebase-auth.js'), import(base+'firebase-firestore.js')
      ]);
      api = firestoreModule;
      const app = appModule.initializeApp(window.KRD_FIREBASE_CONFIG);
      auth = authModule.getAuth(app);
      await auth.authStateReady();
      if (!auth.currentUser) await authModule.signInAnonymously(auth);
      db = api.getFirestore(app);
      api.onSnapshot(api.collection(db,'comments'), {includeMetadataChanges:true}, snapshot => {
        emit(rowsOf(snapshot),null,{cached:snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites});
      }, error => emit(null,describe(error)));
    })();
    ready.catch(error => emit(null,describe(error)));
    return ready;
  }
  function write(action,fields) {
    const id = action === 'add' ? 'm_' + crypto.randomUUID() : fields.id;
    const promise = start().then(async () => {
      const ref = api.doc(db,'comments',id), now = new Date().toISOString();
      if (action === 'add') {
        const row = {id,cardId:fields.cardId,author:(fields.author || '익명').trim().slice(0,20),
          body:fields.body.trim().slice(0,3000),resolved:false,createdAt:now,updatedAt:now};
        await api.setDoc(ref,row);
      } else if (action === 'resolve') {
        await api.updateDoc(ref,{resolved:fields.resolved,updatedAt:now});
      } else {
        await api.deleteDoc(ref);
      }
    }).catch(error => { throw describe(error); });
    promise.commentId = id;
    return promise;
  }
  window.KRDComments = {
    subscribe(fn) {
      listeners.add(fn);
      if (latestRows) fn(latestRows,null,latestMeta);
      return () => listeners.delete(fn);
    },
    refresh() {
      // The live listener handles reconnects; explicit refresh is coalesced.
      if (!ready) return Promise.resolve();
      if (readInFlight) return readInFlight;
      readInFlight = ready.then(() => api.getDocsFromServer(api.collection(db,'comments')))
        .then(snapshot => emit(rowsOf(snapshot),null,{cached:snapshot.metadata.hasPendingWrites}))
        .catch(error => emit(null,describe(error))).finally(() => { readInFlight = null; });
      return readInFlight;
    },
    add(cardId,author,body) { return write('add',{cardId,author,body}); },
    resolve(id,resolved) { return write('resolve',{id,resolved}); },
    remove(id) { return write('delete',{id}); }
  };
  if (document.readyState === 'complete') setTimeout(start,0);
  else window.addEventListener('load',() => setTimeout(start,0),{once:true});
})();
