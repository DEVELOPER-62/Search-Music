// app.js — core logic (search + mic recognition + fallback)
const $ = (s, root=document) => root.querySelector(s);
const resultsEl = $('#results');
const emptyEl = $('#empty');
const toastEl = $('#toast');

const state = {
  auddKey: localStorage.getItem('auddKey') || '',
  acr: {
    key: localStorage.getItem('acrKey') || '',
    secret: localStorage.getItem('acrSecret') || '',
    host: localStorage.getItem('acrHost') || '',
  },
  media: { stream: null, recorder: null, chunks: [], analyser: null, rmsSamples: [] },
};

// UI helpers
const showToast = (msg, t=2200) => { toastEl.textContent = msg; toastEl.classList.add('show'); setTimeout(()=>toastEl.classList.remove('show'), t); };
const setLoading = (on) => { const btn = $('#btnSearch'); btn.disabled = on; btn.textContent = on ? 'Memuat…' : 'Google-style Search'; };

const youTubeSearchURL = (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
const googleSearchURL = (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

// Render
function renderTracks(items){
  resultsEl.innerHTML = '';
  if(!items || !items.length){ emptyEl.style.display='block'; return; }
  emptyEl.style.display='none';
  for(const it of items){
    const title = it.trackName || it.title || 'Tidak diketahui';
    const artist = it.artistName || it.artist || '';
    const artwork = it.artworkUrl100?.replace('100x100bb', '400x400bb') || it.image || 'https://via.placeholder.com/400x400?text=Music';
    const preview = it.previewUrl || null;
    const ytQuery = `${title} ${artist}`.trim();
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" src="${artwork}" alt="${title} cover" loading="lazy" />
      <div class="card-body">
        <h3 class="track">${title}</h3>
        <p class="artist">${artist}</p>
        <div class="actions">
          <a class="a primary" target="_blank" rel="noreferrer" href="${youTubeSearchURL(ytQuery)}">Buka di YouTube</a>
          ${preview ? `<button class="a" data-preview="${preview}">▶︎ Preview 30s</button>`: ''}
          ${it.collectionViewUrl ? `<a class="a" target="_blank" rel="noreferrer" href="${it.collectionViewUrl}">Lihat di iTunes</a>`:''}
        </div>
      </div>`;
    resultsEl.appendChild(card);
  }
}

// Text search (like Google)
async function searchText(term){
  if(!term){ return; }
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=12`;
  setLoading(true);
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('Gagal memuat');
    const data = await res.json();
    if(!data.results?.length){
      // fallback to Google if iTunes empty
      window.open(googleSearchURL(term), '_blank');
      showToast('Tidak ditemukan di katalog. Mencari di Google…');
      renderTracks([]);
      return;
    }
    renderTracks(data.results || []);
    showToast(`Menampilkan ${data.results?.length || 0} lagu untuk "${term}"`);
  }catch(err){
    console.error(err);
    showToast('Terjadi kesalahan saat mencari.');
  }finally{ setLoading(false); }
}

// Mic recording + quality estimate
let audioCtx, source, analyser, rafId;
async function startRecording(){
  if(!navigator.mediaDevices?.getUserMedia){ showToast('Browser tidak mendukung mikrofon.'); return; }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    state.media.stream = stream;
    state.media.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    state.media.chunks = [];
    state.media.recorder.ondataavailable = (e) => { if(e.data.size) state.media.chunks.push(e.data); };
    state.media.recorder.onstop = onRecordingStop;

    // WebAudio analyser for RMS estimate (signal quality proxy)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    state.media.analyser = analyser;
    state.media.rmsSamples = [];
    const data = new Uint8Array(analyser.fftSize);
    const sample = () => {
      analyser.getByteTimeDomainData(data);
      // compute RMS 0..1
      let sum=0;
      for(let i=0;i<data.length;i++){
        const v = (data[i]-128)/128;
        sum += v*v;
      }
      const rms = Math.sqrt(sum/data.length);
      state.media.rmsSamples.push(rms);
      // update UI
      const sq = estimateSignalQuality();
      $('#sqVal').textContent = `${Math.round(sq*100)}%`;
      rafId = requestAnimationFrame(sample);
    };
    sample();

    state.media.recorder.start();
    $('#btnMic').classList.add('recording');
    $('#micText').textContent = 'Merekam… klik untuk selesai';
    showToast('Merekam… klik 🎙️ lagi untuk berhenti');
  }catch(err){ console.error(err); showToast('Tidak bisa mengakses mikrofon.'); }
}

function stopRecording(){
  const r = state.media.recorder; if(r && r.state !== 'inactive'){ r.stop(); }
  state.media.stream?.getTracks().forEach(t=>t.stop());
  cancelAnimationFrame(rafId);
  if(audioCtx){ audioCtx.close(); }
  $('#btnMic').classList.remove('recording');
  $('#micText').textContent = 'Kenali';
}

function estimateSignalQuality(){
  // simple heuristic: target RMS ~0.05..0.25; clamp to 0..1
  const arr = state.media.rmsSamples;
  if(!arr.length) return 0;
  const avg = arr.reduce((a,b)=>a+b,0)/arr.length;
  const quality = Math.max(0, Math.min(1, (avg - 0.02) / (0.22 - 0.02)));
  return quality;
}

// AI confidence estimate (combines provider score + signal quality)
function combineConfidence(providerScore /*0..1 or null*/){
  const sq = estimateSignalQuality(); // 0..1
  let conf;
  if (providerScore == null) {
    conf = 0.6*sq + 0.2; // baseline when provider doesn't supply score
  } else {
    conf = 0.7*providerScore + 0.3*sq;
  }
  conf = Math.max(0, Math.min(1, conf));
  $('#confVal').textContent = `${Math.round(conf*100)}%`;
  return conf;
}

// Recognition providers
async function recognizeWithAudD(blob){
  if(!state.auddKey) return null;
  const form = new FormData();
  form.append('api_token', state.auddKey);
  form.append('return', 'timecode,apple_music,spotify,youtube');
  form.append('file', blob, 'recording.webm');
  let res = await fetch('https://api.audd.io/', { method:'POST', body: form });
  let data = await res.json();
  if(!data?.result){
    // try alt endpoint
    const form2 = new FormData();
    form2.append('api_token', state.auddKey);
    form2.append('return', 'timecode,apple_music,spotify,youtube');
    form2.append('audio', blob, 'recording.webm');
    res = await fetch('https://api.audd.io/recognize', { method:'POST', body: form2 });
    data = await res.json();
  }
  if(!data?.result) return null;
  const r = data.result;
  return {
    title: r.title,
    artist: r.artist,
    artwork: r.apple_music?.artwork?.url?.replace('{w}x{h}','400x400') || null,
    previewUrl: r.apple_music?.previews?.[0]?.url || r.spotify?.preview_url || null,
    itunesUrl: r.apple_music?.url || null,
    youtubeId: r.youtube?.video_id || null,
    providerScore: r.score ? (parseFloat(r.score)/100) : null // may not exist
  };
}

// Placeholder for ACRCloud (requires proper signed request from backend; here for completeness)
async function recognizeWithACRCloud(/*blob*/){
  const {key, secret, host} = state.acr;
  if(!key || !secret || !host) return null;
  // NOTE: Proper ACRCloud identify API requires HMAC signing with secret.
  // For security, this should be proxied via your backend. This front-end placeholder returns null.
  return null;
}

async function onRecordingStop(){
  const blob = new Blob(state.media.chunks, { type: 'audio/webm' });
  state.media.chunks = [];
  showToast('Mengunggah & mengenali…');
  let best = null;

  // Try providers (AudD first)
  try{
    const audd = await recognizeWithAudD(blob);
    if (audd) best = { provider: 'AudD', ...audd };
    const acr = await recognizeWithACRCloud(blob);
    if (acr && !best) best = { provider: 'ACRCloud', ...acr };
  }catch(e){ console.error(e); }

  if(!best){
    $('#confVal').textContent = '—';
    showToast('Tidak terdeteksi. Mencari via Google…');
    // Open Google as fallback using generic query from any heard terms (here we cannot parse lyrics locally).
    window.open('https://www.google.com/search?q=apa+judul+lagu+ini', '_blank');
    renderTracks([]);
    return;
  }

  const conf = combineConfidence(best.providerScore);
  const items = [{
    title: best.title,
    artist: best.artist,
    image: best.artwork || (best.youtubeId ? `https://i.ytimg.com/vi/${best.youtubeId}/hqdefault.jpg` : null),
    previewUrl: best.previewUrl || null,
    collectionViewUrl: best.itunesUrl || null,
    trackName: best.title,
    artistName: best.artist
  }];
  renderTracks(items);
  const tag = conf >= 0.88 ? '✅ (≥88% yakin)' : '';
  showToast(`Ditemukan: ${best.title} — ${best.artist} ${tag}`);
}

// Events
$('#btnSearch').addEventListener('click', () => {
  const term = $('#q').value.trim(); if(term) searchText(term); else $('#q').focus();
});
$('#q').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ const term = e.currentTarget.value.trim(); if(term) searchText(term); }});
resultsEl.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-preview]'); if(!btn) return; 
  const url = btn.getAttribute('data-preview');
  const audio = new Audio(url); audio.play();
});
$('#btnMic').addEventListener('click', () => {
  const rec = state.media.recorder; if(rec && rec.state === 'recording'){ stopRecording(); } else { startRecording(); }
});

// Settings dialog
const dlg = document.getElementById('settingsDlg');
$('#btnSettings').addEventListener('click', () => {
  $('#auddKey').value = state.auddKey;
  $('#acrKey').value = state.acr.key;
  $('#acrSecret').value = state.acr.secret;
  $('#acrHost').value = state.acr.host;
  dlg.showModal();
});
$('#saveSettings').addEventListener('click', (e) => {
  e.preventDefault();
  state.auddKey = $('#auddKey').value.trim(); localStorage.setItem('auddKey', state.auddKey);
  state.acr.key = $('#acrKey').value.trim(); localStorage.setItem('acrKey', state.acr.key);
  state.acr.secret = $('#acrSecret').value.trim(); localStorage.setItem('acrSecret', state.acr.secret);
  state.acr.host = $('#acrHost').value.trim(); localStorage.setItem('acrHost', state.acr.host);
  dlg.close();
  showToast('Disimpan.');
});