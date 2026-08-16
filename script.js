/* ============================================================
   BANDON PRO — script.js
   Transcriptor de bandoneón en vivo + Editor + Partitura + IA
   100% en el navegador. Sin backend. Código modular y comentado.
   ============================================================ */

(() => {
  'use strict';

  /* =========================================================
     0. UTILIDADES GENERALES / MANEJO DE ERRORES
     Envolvemos cualquier operación riesgosa (audio, librerías
     externas, Web Speech) en try/catch para que un fallo puntual
     nunca rompa el resto del preview.
  ========================================================= */
  function safe(fn, label) {
    try { return fn(); }
    catch (err) { console.warn(`[Bandon Pro] Error en ${label || 'operación'}:`, err); return null; }
  }
  async function safeAsync(fn, label) {
    try { return await fn(); }
    catch (err) { console.warn(`[Bandon Pro] Error en ${label || 'operación async'}:`, err); return null; }
  }

  /* =========================================================
     1. DATOS MUSICALES
  ========================================================= */
  const NOTE_NAMES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const NOTE_NAMES_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

  // Pronunciación en español argentino (regla exacta pedida por el usuario)
  const VOICE_ES_AR = {
    'C':'Do', 'C#':'Do sostenido', 'Db':'Do sostenido',
    'D':'Re', 'D#':'Re sostenido', 'Eb':'Re sostenido',
    'E':'Mi',
    'F':'Fa', 'F#':'Fa sostenido', 'Gb':'Fa sostenido',
    'G':'Sol', 'G#':'Sol sostenido', 'Ab':'Sol sostenido',
    'A':'La', 'A#':'La sostenido', 'Bb':'La sostenido',
    'B':'Si'
  };

  const KEYS = [
    { value:'C',  label:'Do mayor (C)' },  { value:'G',  label:'Sol mayor (G)' },
    { value:'D',  label:'Re mayor (D)' },  { value:'A',  label:'La mayor (A)' },
    { value:'E',  label:'Mi mayor (E)' },  { value:'B',  label:'Si mayor (B)' },
    { value:'F#', label:'Fa# mayor (F#)' },{ value:'F',  label:'Fa mayor (F)' },
    { value:'Bb', label:'Sib mayor (Bb)' },{ value:'Eb', label:'Mib mayor (Eb)' },
    { value:'Ab', label:'Lab mayor (Ab)' },{ value:'Db', label:'Reb mayor (Db)' },
    { value:'Am', label:'La menor (Am)' }, { value:'Dm', label:'Re menor (Dm)' },
    { value:'Em', label:'Mi menor (Em)' },
  ];
  const MAJOR_SCALE = [0,2,4,5,7,9,11];
  const MINOR_SCALE = [0,2,3,5,7,8,10];
  const KEY_TONIC_SEMITONE = { C:0,G:7,D:2,A:9,E:4,B:11,'F#':6,F:5,Bb:10,Eb:3,Ab:8,Db:1,Am:9,Dm:2,Em:4 };
  const VEXFLOW_KEY_MAP = { C:'C',G:'G',D:'D',A:'A',E:'E',B:'B','F#':'F#',F:'F',Bb:'Bb',Eb:'Eb',Ab:'Ab',Db:'Db',Am:'Am',Dm:'Dm',Em:'Em' };

  // Perfiles de acordes básicos (tríadas) para detección por chroma — mayor/menor/disminuido
  const CHORD_TEMPLATES = (() => {
    const out = {};
    for (let root=0; root<12; root++){
      out[NOTE_NAMES_SHARP[root]+' mayor'] = [root,(root+4)%12,(root+7)%12];
      out[NOTE_NAMES_SHARP[root]+' menor'] = [root,(root+3)%12,(root+7)%12];
    }
    return out;
  })();

  /* =========================================================
     2. ESTADO GLOBAL
  ========================================================= */
  const state = {
    audioCtx:null, analyser:null, mediaStream:null, sourceNode:null,
    rafId:null, listening:false,
    notes:[],               // {id,name,octave,vexKey,type,duration,time,velocity,freq,track}
    lastNote:null, lastNoteStartTime:0, silenceStart:null, silenceRegistered:false,
    currentAudioEl:null,
    dataArray:null, bufferLength:0,

    // grabación
    mediaRecorder:null, recordedChunks:[], recordStartTime:0, recordTimerId:null, isRecording:false, isPaused:false,

    // reproducción de partitura / transporte
    playIndex:0, isPlayingScore:false, playTimeoutId:null, scoreSynth:null, metronomeLoop:null,

    // loop de aprendizaje
    loopActive:false,

    // voz
    voiceEnabled:false,

    // chroma para acordes
    chromaBuf:new Float32Array(12),
  };

  const MIN_NOTE_MS = 90;
  const SILENCE_MS = 250;
  let noteIdSeq = 1;

  /* =========================================================
     3. REFERENCIAS DOM
  ========================================================= */
  const $ = (id) => document.getElementById(id);
  const el = {};
  [ 'keySelect','timeSig','bpm','sensitivity','instrumentSelect','accidentalPref','quantizeSelect','geminiKey',
    'autocorrectToggle','restToggle','metronomeToggle','chordToggle','trackSeparationToggle','separationNote',
    'micBtn','recordBtn','pauseRecordBtn','recordTimer','fileInput','loadFileBtn','undoBtn','clearBtn',
    'statusDot','statusText','playbackRate','rateValue',
    'noteBig','noteSub','tuningFill','centsText','chordText','aiExplain',
    'statCount','statRests','statFreq','statConf','statTrack','statDifficulty',
    'notesTableBody','exportCsv',
    'rewindBtn','playBtn','pauseBtn','stopBtn','forwardBtn','realSoundToggle',
    'zoomRange','zoomValue','editNoteIndex','semitoneDownBtn','semitoneUpBtn',
    'scoreTitle','scoreComposer','exportPng','exportPdf','exportXml','exportMidi','printBtn','scoreContainer','scoreSvg',
    'loopStart','loopEnd','loopToggleBtn','difficultyExplain',
    'voiceToggleBtn','slowVoiceToggle','voiceStatus',
    'tabNav'
  ].forEach(id => el[id] = $(id));

  /* =========================================================
     4. TABS
  ========================================================= */
  function initTabs() {
    const buttons = Array.from(el.tabNav.querySelectorAll('.tab-btn'));
    buttons.forEach(btn => btn.addEventListener('click', () => {
      buttons.forEach(b => b.setAttribute('aria-selected','false'));
      btn.setAttribute('aria-selected','true');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      const panel = document.querySelector(`[data-panel="${btn.dataset.tab}"]`);
      if (panel) panel.classList.remove('hidden');
    }));
  }

  /* =========================================================
     5. INICIALIZACIÓN
  ========================================================= */
  function populateKeys() {
    el.keySelect.innerHTML = KEYS.map(k => `<option value="${k.value}">${k.label}</option>`).join('');
    el.keySelect.value = 'C';
  }

  function init() {
    populateKeys();
    initTabs();
    bindEvents();
    renderScore();
    updateDifficulty();
  }

  function bindEvents() {
    el.micBtn.addEventListener('click', toggleMic);
    el.recordBtn.addEventListener('click', toggleRecording);
    el.pauseRecordBtn.addEventListener('click', togglePauseRecording);
    el.loadFileBtn.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', handleFileLoad);
    el.playbackRate.addEventListener('input', () => {
      const v = parseFloat(el.playbackRate.value).toFixed(2);
      el.rateValue.textContent = v + 'x';
      if (state.currentAudioEl) state.currentAudioEl.playbackRate = parseFloat(v);
    });
    el.undoBtn.addEventListener('click', undoLastNote);
    el.clearBtn.addEventListener('click', clearAll);
    el.exportCsv.addEventListener('click', exportCsv);

    el.playBtn.addEventListener('click', playScore);
    el.pauseBtn.addEventListener('click', pauseScore);
    el.stopBtn.addEventListener('click', stopScore);
    el.rewindBtn.addEventListener('click', () => seekScore(-1));
    el.forwardBtn.addEventListener('click', () => seekScore(1));

    el.zoomRange.addEventListener('input', () => { el.zoomValue.textContent = el.zoomRange.value + '%'; renderScore(); });
    el.editNoteIndex.addEventListener('change', highlightEditableNote);
    el.semitoneDownBtn.addEventListener('click', () => shiftSelectedNote(-1));
    el.semitoneUpBtn.addEventListener('click', () => shiftSelectedNote(1));

    el.exportPng.addEventListener('click', exportPng);
    el.exportPdf.addEventListener('click', exportPdf);
    el.exportXml.addEventListener('click', exportMusicXml);
    el.exportMidi.addEventListener('click', exportMidi);
    el.printBtn.addEventListener('click', () => window.print());

    el.keySelect.addEventListener('change', renderScore);
    el.timeSig.addEventListener('change', renderScore);
    el.accidentalPref.addEventListener('change', renderScore);
    el.quantizeSelect.addEventListener('change', () => { applyQuantization(); renderScore(); renderTable(); });
    el.scoreTitle.addEventListener('input', renderScore);
    el.scoreComposer.addEventListener('input', renderScore);
    el.noteBig.addEventListener('click', explainWithAI);

    el.trackSeparationToggle.addEventListener('change', () => {
      el.separationNote.classList.toggle('hidden', !el.trackSeparationToggle.checked);
    });

    el.loopToggleBtn.addEventListener('click', toggleLoop);

    el.voiceToggleBtn.addEventListener('click', toggleVoice);
  }

  /* =========================================================
     6. MICRÓFONO / GRAFO DE AUDIO
  ========================================================= */
  async function toggleMic() {
    if (state.listening) stopListening();
    else await startMic();
  }

  async function startMic() {
    await safeAsync(async () => {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
      });
      setupAudioGraph(state.mediaStream);
      state.listening = true;
      el.micBtn.textContent = '⏸️ Detener escucha';
      el.micBtn.classList.add('recording-pulse');
      el.statusDot.classList.replace('bg-white/20','bg-ok');
      el.statusText.textContent = 'Escuchando micrófono…';
      loopDetect();
    }, 'acceso al micrófono') || alert('No se pudo acceder al micrófono. Revisá los permisos del navegador.');
  }

  function stopListening() {
    state.listening = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.mediaStream) state.mediaStream.getTracks().forEach(t => t.stop());
    el.micBtn.textContent = '🎙️ Empezar a escuchar';
    el.micBtn.classList.remove('recording-pulse');
    el.statusDot.classList.replace('bg-ok','bg-white/20');
    el.statusText.textContent = 'Micrófono apagado';
  }

  function setupAudioGraph(streamOrElement, isMediaElement=false) {
    safe(() => {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = state.audioCtx;
      state.analyser = ctx.createAnalyser();
      state.analyser.fftSize = 2048;
      state.bufferLength = state.analyser.fftSize;
      state.dataArray = new Float32Array(state.bufferLength);

      if (isMediaElement) {
        state.sourceNode = ctx.createMediaElementSource(streamOrElement);
        state.sourceNode.connect(state.analyser);
        state.analyser.connect(ctx.destination);
      } else {
        state.sourceNode = ctx.createMediaStreamSource(streamOrElement);
        state.sourceNode.connect(state.analyser);
      }
    }, 'setupAudioGraph');
  }

  /* =========================================================
     7. GRABACIÓN DE AUDIO (MediaRecorder) — botón "Grabar"
  ========================================================= */
  async function toggleRecording() {
    if (state.isRecording) stopRecording();
    else await startRecording();
  }

  async function startRecording() {
    await safeAsync(async () => {
      if (!state.mediaStream) {
        state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio:true });
        setupAudioGraph(state.mediaStream);
        if (!state.listening) { state.listening = true; loopDetect(); }
      }
      state.recordedChunks = [];
      state.mediaRecorder = new MediaRecorder(state.mediaStream);
      state.mediaRecorder.ondataavailable = e => { if (e.data.size>0) state.recordedChunks.push(e.data); };
      state.mediaRecorder.onstop = () => {
        const blob = new Blob(state.recordedChunks, { type:'audio/webm' });
        downloadBlob(blob, 'bandon_pro_grabacion.webm');
      };
      state.mediaRecorder.start();
      state.isRecording = true; state.isPaused = false;
      state.recordStartTime = Date.now();
      el.recordBtn.textContent = '⏹ Detener grabación';
      el.recordBtn.classList.add('recording-pulse');
      el.pauseRecordBtn.disabled = false;
      el.recordTimer.classList.remove('hidden');
      state.recordTimerId = setInterval(updateRecordTimer, 500);
    }, 'grabación de audio') || alert('No se pudo iniciar la grabación de audio.');
  }

  function togglePauseRecording() {
    if (!state.mediaRecorder) return;
    safe(() => {
      if (state.isPaused) { state.mediaRecorder.resume(); state.isPaused = false; el.pauseRecordBtn.textContent = '⏸ Pausar grabación'; }
      else { state.mediaRecorder.pause(); state.isPaused = true; el.pauseRecordBtn.textContent = '▶ Reanudar grabación'; }
    }, 'pausar grabación');
  }

  function stopRecording() {
    safe(() => state.mediaRecorder && state.mediaRecorder.stop(), 'detener grabación');
    state.isRecording = false; state.isPaused = false;
    el.recordBtn.textContent = '⏺ Grabar audio';
    el.recordBtn.classList.remove('recording-pulse');
    el.pauseRecordBtn.disabled = true;
    clearInterval(state.recordTimerId);
  }

  function updateRecordTimer() {
    const secs = Math.floor((Date.now()-state.recordStartTime)/1000);
    const m = String(Math.floor(secs/60)).padStart(2,'0');
    const s = String(secs%60).padStart(2,'0');
    el.recordTimer.textContent = `${m}:${s}`;
  }

  /* =========================================================
     8. CARGA DE ARCHIVO (audio/video)
  ========================================================= */
  function handleFileLoad(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (state.listening) stopListening();

    safe(() => {
      const url = URL.createObjectURL(file);
      const audioEl = new Audio(url);
      audioEl.crossOrigin = 'anonymous';
      audioEl.playbackRate = parseFloat(el.playbackRate.value);
      state.currentAudioEl = audioEl;

      audioEl.addEventListener('canplay', () => {
        setupAudioGraph(audioEl, true);
        audioEl.play();
        state.listening = true;
        el.statusDot.classList.replace('bg-white/20','bg-ok');
        el.statusText.textContent = 'Analizando archivo: ' + file.name;
        loopDetect();
      });
      audioEl.addEventListener('ended', () => {
        state.listening = false;
        el.statusDot.classList.replace('bg-ok','bg-white/20');
        el.statusText.textContent = 'Archivo finalizado';
      });
    }, 'carga de archivo');
  }

  /* =========================================================
     9. DETECCIÓN DE PITCH (AUTOCORRELACIÓN) + CHROMA/ACORDES
  ========================================================= */
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i=0;i<SIZE;i++){ const v=buf[i]; rms += v*v; }
    rms = Math.sqrt(rms/SIZE);
    if (rms < 0.008) return { freq:-1, rms };

    let r1=0, r2=SIZE-1, threshold=0.2;
    for (let i=0;i<SIZE/2;i++){ if (Math.abs(buf[i])<threshold){ r1=i; break; } }
    for (let i=1;i<SIZE/2;i++){ if (Math.abs(buf[SIZE-i])<threshold){ r2=SIZE-i; break; } }

    const trimmed = buf.slice(r1, r2);
    const n = trimmed.length;
    const c = new Array(n).fill(0);
    for (let lag=0; lag<n; lag++){
      let sum = 0;
      for (let i=0;i<n-lag;i++){ sum += trimmed[i]*trimmed[i+lag]; }
      c[lag] = sum;
    }
    let d = 0;
    while (d < n-1 && c[d] > c[d+1]) d++;
    let maxVal=-1, maxPos=-1;
    for (let i=d;i<n;i++){ if (c[i] > maxVal){ maxVal = c[i]; maxPos = i; } }
    let T0 = maxPos;
    if (T0 <= 0) return { freq:-1, rms };

    const x1 = c[T0-1] || 0, x2 = c[T0], x3 = c[T0+1] || 0;
    const a = (x1 + x3 - 2*x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b/(2*a);

    return { freq: sampleRate / T0, rms };
  }

  function freqToNoteInfo(freq) {
    const A4 = 440;
    const noteNum = 12 * (Math.log2(freq / A4)) + 57;
    const rounded = Math.round(noteNum);
    const cents = Math.floor((noteNum - rounded) * 100);
    const flat = el.accidentalPref.value === 'flat';
    const table = flat ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
    const name = table[((rounded % 12) + 12) % 12];
    const octave = Math.floor(rounded / 12) - 1;
    return { name, octave, cents, midi: rounded };
  }

  function autocorrectToKey(midi) {
    const keyVal = el.keySelect.value;
    const tonic = KEY_TONIC_SEMITONE[keyVal] ?? 0;
    const scale = keyVal.endsWith('m') ? MINOR_SCALE : MAJOR_SCALE;
    const pitchClass = ((midi % 12) + 12) % 12;
    const rel = ((pitchClass - tonic) + 12) % 12;
    let best = scale[0], bestDist = 99;
    for (const deg of scale) {
      const dist = Math.min(Math.abs(deg-rel), 12-Math.abs(deg-rel));
      if (dist < bestDist) { bestDist = dist; best = deg; }
    }
    const correctedPc = (tonic + best) % 12;
    let adj = correctedPc - pitchClass;
    if (adj > 6) adj -= 12; if (adj < -6) adj += 12;
    return midi + adj;
  }

  // Heurística simple de separación melodía/acompañamiento:
  // si la nota detectada está por debajo de un umbral relativo de energía
  // respecto del pico reciente, se clasifica como "acompañamiento".
  let recentPeakRms = 0.02;
  function classifyTrack(rms) {
    if (!el.trackSeparationToggle.checked) return 'melodia';
    recentPeakRms = Math.max(rms, recentPeakRms*0.98);
    return rms > recentPeakRms*0.55 ? 'melodia' : 'acompañamiento';
  }

  // Detección de acorde por chroma (perfil de 12 clases de tono) usando FFT
  function detectChord() {
    if (!el.chordToggle.checked || !state.analyser) { el.chordText.classList.add('hidden'); return; }
    safe(() => {
      const freqBins = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(freqBins);
      const chroma = new Float32Array(12);
      const sampleRate = state.audioCtx.sampleRate;
      const binHz = sampleRate / state.analyser.fftSize;
      for (let i=1;i<freqBins.length;i++){
        const freq = i*binHz;
        if (freq < 80 || freq > 1200) continue;
        const midi = 69 + 12*Math.log2(freq/440);
        const pc = ((Math.round(midi)%12)+12)%12;
        chroma[pc] += freqBins[i];
      }
      const maxC = Math.max(...chroma) || 1;
      for (let i=0;i<12;i++) chroma[i] /= maxC;

      let bestChord = null, bestScore = -1;
      for (const [name, tones] of Object.entries(CHORD_TEMPLATES)) {
        const score = tones.reduce((s,t)=>s+chroma[t],0) - (12-tones.length)*0.05;
        if (score > bestScore) { bestScore = score; bestChord = name; }
      }
      if (bestScore > 1.2) {
        el.chordText.textContent = 'Acorde: ' + bestChord;
        el.chordText.classList.remove('hidden');
      }
    }, 'detección de acordes');
  }

  function loopDetect() {
    if (!state.listening) return;
    safe(() => {
      state.analyser.getFloatTimeDomainData(state.dataArray);
      const sensitivityMap = { alta:0.005, media:0.012, estricta:0.02 };
      const rmsThreshold = sensitivityMap[el.sensitivity.value] ?? 0.008;
      const { freq, rms } = autoCorrelate(state.dataArray, state.audioCtx.sampleRate);

      if (freq > 60 && freq < 2000 && rms > rmsThreshold) handleDetectedPitch(freq, rms);
      else handleSilence();

      detectChord();
    }, 'loopDetect');
    state.rafId = requestAnimationFrame(loopDetect);
  }

  function handleDetectedPitch(freq, rms) {
    state.silenceStart = null;
    let info = freqToNoteInfo(freq);
    if (el.autocorrectToggle.checked) {
      const corrected = autocorrectToKey(info.midi);
      const flat = el.accidentalPref.value === 'flat';
      const table = flat ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
      info = { ...info, name: table[((corrected%12)+12)%12], octave: Math.floor(corrected/12)-1, midi:corrected };
    }
    const track = classifyTrack(rms);

    el.noteBig.textContent = info.name + info.octave;
    el.noteSub.textContent = 'detectando…';
    el.statFreq.textContent = freq.toFixed(1) + ' Hz';
    el.statConf.textContent = Math.min(100, Math.round(rms*400)) + '%';
    el.statTrack.textContent = track === 'melodia' ? 'Melodía' : 'Acompañamiento';

    const centsClamped = Math.max(-50, Math.min(50, info.cents));
    el.tuningFill.style.left = (50 + centsClamped) + '%';
    el.centsText.textContent = (info.cents>0?'+':'') + info.cents + ' cents';

    const now = performance.now();
    if (!state.lastNote || state.lastNote.name !== info.name || state.lastNote.octave !== info.octave) {
      state.lastNote = { name: info.name, octave: info.octave };
      state.lastNoteStartTime = now;
    } else {
      const heldMs = now - state.lastNoteStartTime;
      if (heldMs > MIN_NOTE_MS && !state.lastNote.registered) {
        registerNote(info.name, info.octave, freq, track);
        state.lastNote.registered = true;
      }
    }
  }

  function handleSilence() {
    el.noteSub.textContent = 'esperando sonido…';
    const now = performance.now();
    if (state.silenceStart === null) state.silenceStart = now;
    else if (el.restToggle.checked && (now - state.silenceStart) > SILENCE_MS && !state.silenceRegistered) {
      registerRest();
      state.silenceRegistered = true;
    }
    state.lastNote = null;
  }

  /* =========================================================
     10. REGISTRO DE NOTAS / SILENCIOS / VOZ
  ========================================================= */
  function registerNote(name, octave, freq, track) {
    state.silenceRegistered = false;
    const vexKey = `${name.toLowerCase().replace('b','b')}/${octave}`;
    const noteObj = {
      id: noteIdSeq++, name, octave, vexKey, type:'note',
      duration:'q', time:new Date().toLocaleTimeString(), velocity:'mf',
      freq: freq.toFixed(1), track: track || 'melodia'
    };
    state.notes.push(noteObj);
    renderTable();
    updateStats();
    renderScore();
    updateDifficulty();
    if (state.voiceEnabled) speakNoteAR(name);
  }

  function registerRest() {
    const restObj = { id:noteIdSeq++, name:'Silencio', octave:'', vexKey:'b/4', type:'rest',
      duration:'q', time:new Date().toLocaleTimeString(), velocity:'', freq:'', track:'' };
    state.notes.push(restObj);
    renderTable();
    updateStats();
    renderScore();
  }

  // --- Pronunciación de notas en español argentino (función exclusiva) ---
  let voiceQueue = Promise.resolve();
  function speakNoteAR(name) {
    if (!('speechSynthesis' in window)) return;
    const texto = VOICE_ES_AR[name] || name;
    const delay = el.slowVoiceToggle.checked ? 1000 : 0;
    voiceQueue = voiceQueue.then(() => new Promise(resolve => {
      safe(() => {
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = 'es-AR';
        u.rate = el.slowVoiceToggle.checked ? 0.9 : 1.3;
        u.volume = 0.7;
        u.onend = () => setTimeout(resolve, delay);
        u.onerror = () => resolve();
        speechSynthesis.speak(u);
      }, 'speechSynthesis');
      // fallback por si el evento onend no dispara en algún navegador
      setTimeout(resolve, 2500 + delay);
    }));
  }

  function toggleVoice() {
    state.voiceEnabled = !state.voiceEnabled;
    el.voiceToggleBtn.setAttribute('aria-pressed', String(state.voiceEnabled));
    el.voiceToggleBtn.textContent = state.voiceEnabled ? '🔇 Desactivar Voz' : '🔊 Activar Voz';
    el.voiceToggleBtn.classList.toggle('bg-brass', state.voiceEnabled);
    el.voiceStatus.textContent = 'Voz: ' + (state.voiceEnabled ? 'activada' : 'desactivada');
  }

  /* =========================================================
     11. TABLA DE NOTAS (con edición por click)
  ========================================================= */
  function renderTable() {
    el.notesTableBody.innerHTML = '';
    state.notes.forEach((n, i) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-brass/10 cursor-pointer';
      tr.innerHTML = `<td class="p-2">${i+1}</td><td class="p-2">${n.name}</td><td class="p-2">${n.octave}</td>
        <td class="p-2">${n.duration}</td><td class="p-2">${n.track||''}</td><td class="p-2">${n.time}</td>
        <td class="p-2">${n.type==='note' ? '✎' : ''}</td>`;
      if (n.type === 'note') tr.addEventListener('click', () => openQuickEdit(i));
      el.notesTableBody.appendChild(tr);
    });
    refreshEditSelect();
  }

  function refreshEditSelect() {
    const noteIdxs = state.notes.map((n,i)=>({n,i})).filter(o => o.n.type==='note');
    el.editNoteIndex.innerHTML = '<option value="">— elegí una nota —</option>' +
      noteIdxs.map(o => `<option value="${o.i}">#${o.i+1} — ${o.n.name}${o.n.octave}</option>`).join('');
  }

  function openQuickEdit(i) {
    el.editNoteIndex.value = String(i);
    // Cambiamos a la pestaña Editor para que el usuario vea las herramientas de corrección
    document.querySelector('[data-tab="editor"]').click();
  }

  function highlightEditableNote() { /* selección visual reservada para futuras mejoras */ }

  function shiftSelectedNote(semitones) {
    const idx = parseInt(el.editNoteIndex.value, 10);
    if (isNaN(idx) || !state.notes[idx]) { alert('Elegí primero una nota de la lista.'); return; }
    const n = state.notes[idx];
    const flat = el.accidentalPref.value === 'flat';
    const table = flat ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
    let midi = table.indexOf(n.name) + (parseInt(n.octave,10)+1)*12;
    midi += semitones;
    const pc = ((midi%12)+12)%12;
    n.name = table[pc];
    n.octave = Math.floor(midi/12)-1;
    n.vexKey = `${n.name.toLowerCase()}/${n.octave}`;
    renderTable();
    renderScore();
    updateDifficulty();
  }

  function undoLastNote() { state.notes.pop(); renderTable(); updateStats(); renderScore(); updateDifficulty(); }

  function clearAll() {
    if (!confirm('¿Vaciar toda la transcripción?')) return;
    state.notes = [];
    renderTable(); updateStats(); renderScore(); updateDifficulty();
  }

  function updateStats() {
    el.statCount.textContent = state.notes.filter(n=>n.type==='note').length;
    el.statRests.textContent = state.notes.filter(n=>n.type==='rest').length;
  }

  /* =========================================================
     12. CUANTIZACIÓN
  ========================================================= */
  function applyQuantization() {
    const q = el.quantizeSelect.value;
    if (q === 'none') return;
    const durMap = { '4':'q', '8':'8', '16':'16' };
    state.notes.forEach(n => { n.duration = durMap[q] || n.duration; });
  }

  /* =========================================================
     13. PARTITURA CON VEXFLOW 4 (con zoom)
  ========================================================= */
  function renderScore() {
    safe(() => {
      el.scoreSvg.innerHTML = '';
      const VF = Vex.Flow;
      const zoom = (parseInt(el.zoomRange.value,10) || 100) / 100;
      const width = Math.max(600, 120 + state.notes.length * 55);
      const renderer = new VF.Renderer(el.scoreSvg, VF.Renderer.Backends.SVG);
      renderer.resize(width*zoom, 220*zoom);
      const ctx = renderer.getContext();
      ctx.scale(zoom, zoom);

      const title = el.scoreTitle.value || 'Transcripción sin título';
      const composer = el.scoreComposer.value || '';
      ctx.setFont('Playfair Display', 16, '700'); ctx.fillText(title, 20, 22);
      ctx.setFont('Libre Franklin', 11); ctx.fillText(composer, 20, 38);

      const stave = new VF.Stave(20, 48, width - 40);
      const keyVal = VEXFLOW_KEY_MAP[el.keySelect.value] || 'C';
      stave.addClef('treble').addTimeSignature(el.timeSig.value).addKeySignature(keyVal);
      stave.setContext(ctx).draw();

      if (state.notes.length === 0) {
        ctx.setFont('Libre Franklin', 12);
        ctx.fillText('Todavía no hay notas capturadas…', 30, 140);
        return;
      }
      const vfNotes = state.notes.map(n => n.type === 'rest'
        ? new VF.StaveNote({ clef:'treble', keys:['b/4'], duration:'qr' })
        : new VF.StaveNote({ clef:'treble', keys:[n.vexKey], duration: n.duration || 'q' }));

      const beatValue = parseInt(el.timeSig.value.split('/')[1], 10) || 4;
      const voice = new VF.Voice({ num_beats: vfNotes.length, beat_value: beatValue });
      voice.setStrict(false);
      voice.addTickables(vfNotes);
      new VF.Formatter().joinVoices([voice]).format([voice], width - 100);
      voice.draw(ctx, stave);
    }, 'renderScore');
  }

  /* =========================================================
     14. TRANSPORTE / REPRODUCCIÓN CON SONIDO REAL (Tone.js)
  ========================================================= */
  function getSynthForInstrument() {
    const instrument = el.instrumentSelect.value;
    if (state.scoreSynth) { safe(()=>state.scoreSynth.dispose(),'dispose synth'); }
    switch (instrument) {
      case 'piano':  state.scoreSynth = new Tone.PolySynth(Tone.Synth, { oscillator:{type:'triangle'} }).toDestination(); break;
      case 'violin': state.scoreSynth = new Tone.Synth({ oscillator:{type:'sawtooth'}, envelope:{attack:0.08,release:0.4} }).toDestination(); break;
      case 'voz':    state.scoreSynth = new Tone.Synth({ oscillator:{type:'sine'}, envelope:{attack:0.05,release:0.3} }).toDestination(); break;
      default:       state.scoreSynth = new Tone.Synth({ oscillator:{type:'square8'}, envelope:{attack:0.02,release:0.5} }).toDestination(); // bandoneón aprox.
    }
    return state.scoreSynth;
  }

  async function playScore() {
    if (state.notes.length === 0) return;
    await safeAsync(async () => {
      await Tone.start();
      const synth = getSynthForInstrument();
      const bpm = parseInt(el.bpm.value, 10) || 100;
      Tone.Transport.bpm.value = bpm;
      state.isPlayingScore = true;
      el.playBtn.disabled = true; el.pauseBtn.disabled = false; el.stopBtn.disabled = false;

      if (el.metronomeToggle.checked) startMetronome(bpm);

      playFromIndex(state.playIndex, synth, 60/bpm);
    }, 'reproducción de partitura');
  }

  function playFromIndex(startIdx, synth, stepDur) {
    let idx = startIdx;
    const loopOn = state.loopActive;
    const loopStart = Math.max(0, (parseInt(el.loopStart.value,10)||1)-1);
    const loopEnd = Math.min(state.notes.length-1, (parseInt(el.loopEnd.value,10)||state.notes.length)-1);

    function step() {
      if (!state.isPlayingScore) return;
      if (idx >= state.notes.length) {
        if (loopOn) idx = loopStart; else { stopScore(); return; }
      }
      if (loopOn && idx > loopEnd) idx = loopStart;

      const n = state.notes[idx];
      state.playIndex = idx;
      if (n && n.type === 'note' && el.realSoundToggle.checked) {
        safe(() => synth.triggerAttackRelease(n.name.replace('b','b') + n.octave, stepDur*0.9), 'triggerAttackRelease');
      }
      idx++;
      state.playTimeoutId = setTimeout(step, stepDur*1000);
    }
    step();
  }

  function pauseScore() {
    state.isPlayingScore = false;
    clearTimeout(state.playTimeoutId);
    stopMetronome();
    el.playBtn.disabled = false; el.pauseBtn.disabled = true;
  }

  function stopScore() {
    state.isPlayingScore = false;
    clearTimeout(state.playTimeoutId);
    stopMetronome();
    state.playIndex = 0;
    el.playBtn.disabled = false; el.pauseBtn.disabled = true; el.stopBtn.disabled = true;
  }

  function seekScore(delta) {
    state.playIndex = Math.max(0, Math.min(state.notes.length-1, state.playIndex + delta));
  }

  function startMetronome(bpm) {
    safe(() => {
      const click = new Tone.MembraneSynth().toDestination();
      state.metronomeLoop = new Tone.Loop(time => click.triggerAttackRelease('C2','16n',time), '4n').start(0);
      Tone.Transport.start();
    }, 'metrónomo');
  }
  function stopMetronome() {
    safe(() => { if (state.metronomeLoop) { state.metronomeLoop.stop(); state.metronomeLoop.dispose(); state.metronomeLoop=null; } Tone.Transport.stop(); }, 'stopMetronome');
  }

  /* =========================================================
     15. LOOP DE SECCIÓN (aprendizaje)
  ========================================================= */
  function toggleLoop() {
    state.loopActive = !state.loopActive;
    el.loopToggleBtn.textContent = state.loopActive ? '🔁 Loop activo' : '🔁 Activar loop';
    el.loopToggleBtn.classList.toggle('bg-brass', state.loopActive);
  }

  /* =========================================================
     16. DIFICULTAD ESTIMADA
  ========================================================= */
  function updateDifficulty() {
    const notes = state.notes.filter(n => n.type === 'note');
    if (notes.length < 3) { el.statDifficulty.textContent = '—'; el.difficultyExplain.textContent = 'Capturá algunas notas para ver un análisis de dificultad.'; return; }

    const flat = el.accidentalPref.value === 'flat';
    const table = flat ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
    const midis = notes.map(n => table.indexOf(n.name) + (parseInt(n.octave,10)+1)*12);
    const range = Math.max(...midis) - Math.min(...midis);
    let jumpSum = 0;
    for (let i=1;i<midis.length;i++) jumpSum += Math.abs(midis[i]-midis[i-1]);
    const avgJump = jumpSum / (midis.length-1);
    const accidentalCount = notes.filter(n => n.name.includes('#') || n.name.includes('b')).length;
    const density = notes.length; // proxy simple de densidad

    let score = 0;
    score += range > 24 ? 2 : range > 14 ? 1 : 0;
    score += avgJump > 5 ? 2 : avgJump > 2.5 ? 1 : 0;
    score += accidentalCount > notes.length*0.3 ? 2 : accidentalCount > 0 ? 1 : 0;
    score += density > 60 ? 2 : density > 25 ? 1 : 0;

    let label, desc;
    if (score <= 2) { label='Fácil'; desc='Rango e intervalos acotados, pocas alteraciones. Ideal para practicar a tempo lento.'; }
    else if (score <= 5) { label='Media'; desc='Rango e intervalos moderados, con algunas alteraciones. Conviene trabajar por secciones con loop.'; }
    else { label='Difícil'; desc='Rango amplio, saltos grandes y/o muchas alteraciones. Recomendado practicar con el loop de sección y tempo reducido.'; }

    el.statDifficulty.textContent = label;
    el.difficultyExplain.textContent = `${label} — ${desc} (rango: ${range} semitonos, salto promedio: ${avgJump.toFixed(1)}, alteraciones: ${accidentalCount}/${notes.length}).`;
  }

  /* =========================================================
     17. EXPORTACIONES (CSV, PNG, PDF, MusicXML, MIDI)
  ========================================================= */
  function exportCsv() {
    const header = ['#','Nota','Octava','Duracion','Pista','Tiempo'];
    const rows = state.notes.map((n,i) => [i+1, n.name, n.octave, n.duration, n.track, n.time]);
    const csv = [header, ...rows].map(r => r.join(',')).join('\n');
    downloadBlob(new Blob([csv], {type:'text/csv'}), 'bandon_pro_notas.csv');
  }

  function svgToCanvas(callback) {
    safe(() => {
      const svgEl = el.scoreSvg.querySelector('svg');
      if (!svgEl) return;
      const svgData = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([svgData], {type:'image/svg+xml;charset=utf-8'});
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = svgEl.width.baseVal.value || 800;
        canvas.height = svgEl.height.baseVal.value || 220;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        callback(canvas);
      };
      img.src = url;
    }, 'svgToCanvas');
  }

  function exportPng() { svgToCanvas(canvas => canvas.toBlob(blob => downloadBlob(blob, 'bandon_pro_partitura.png'))); }

  function exportPdf() {
    svgToCanvas(canvas => safe(() => {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation:'landscape', unit:'pt', format:[canvas.width+40, canvas.height+40] });
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 20, 20, canvas.width, canvas.height);
      pdf.save('bandon_pro_partitura.pdf');
    }, 'exportPdf'));
  }

  function exportMusicXml() {
    safe(() => {
      const beats = parseInt(el.timeSig.value.split('/')[0],10) || 4;
      const beatType = parseInt(el.timeSig.value.split('/')[1],10) || 4;
      const notesXml = state.notes.map(n => {
        if (n.type === 'rest') return `<note><rest/><duration>1</duration><type>quarter</type></note>`;
        const step = n.name.replace('#','').replace('b','');
        const alter = n.name.includes('#') ? '<alter>1</alter>' : n.name.includes('b') ? '<alter>-1</alter>' : '';
        return `<note><pitch><step>${step}</step>${alter}<octave>${n.octave}</octave></pitch><duration>1</duration><type>quarter</type></note>`;
      }).join('\n      ');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>${escapeXml(el.scoreTitle.value || 'Transcripción')}</work-title></work>
  <identification><creator type="composer">${escapeXml(el.scoreComposer.value || '')}</creator></identification>
  <part-list><score-part id="P1"><part-name>Bandoneón</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions><key><fifths>0</fifths></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      ${notesXml}
    </measure>
  </part>
</score-partwise>`;
      downloadBlob(new Blob([xml], {type:'application/xml'}), 'bandon_pro_partitura.musicxml');
    }, 'exportMusicXml');
  }

  function escapeXml(s) { return String(s).replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }

  function exportMidi() {
    safe(() => {
      const bpm = parseInt(el.bpm.value,10) || 100;
      const ticksPerBeat = 480;
      const microsecPerBeat = Math.round(60000000 / bpm);
      const events = [];
      events.push(midiVarLen(0).concat([0xFF,0x51,0x03,(microsecPerBeat>>16)&0xFF,(microsecPerBeat>>8)&0xFF,microsecPerBeat&0xFF]));

      let anyNote = false;
      state.notes.forEach(n => {
        if (n.type !== 'note') return;
        anyNote = true;
        const midiNum = noteNameToMidi(n.name, n.octave);
        events.push(midiVarLen(0).concat([0x90, midiNum, 100]));
        events.push(midiVarLen(ticksPerBeat).concat([0x80, midiNum, 0]));
      });
      if (!anyNote) { alert('No hay notas para exportar a MIDI.'); return; }
      events.push(midiVarLen(0).concat([0xFF,0x2F,0x00]));

      let trackBytes = [];
      events.forEach(e => trackBytes = trackBytes.concat(e));
      const header = [0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,(ticksPerBeat>>8)&0xFF,ticksPerBeat&0xFF];
      const trackHeader = [0x4D,0x54,0x72,0x6B,(trackBytes.length>>>24)&0xFF,(trackBytes.length>>>16)&0xFF,(trackBytes.length>>>8)&0xFF,trackBytes.length&0xFF];
      const fullBytes = new Uint8Array([...header, ...trackHeader, ...trackBytes]);
      downloadBlob(new Blob([fullBytes], {type:'audio/midi'}), 'bandon_pro_transcripcion.mid');
    }, 'exportMidi');
  }

  function midiVarLen(value) {
    let buffer = value & 0x7F; const bytes = [];
    while ((value >>= 7)) { buffer <<= 8; buffer |= ((value & 0x7F) | 0x80); }
    while (true) { bytes.push(buffer & 0xFF); if (buffer & 0x80) buffer >>= 8; else break; }
    return bytes;
  }

  function noteNameToMidi(name, octave) {
    const idx = NOTE_NAMES_SHARP.indexOf(name) >= 0 ? NOTE_NAMES_SHARP.indexOf(name) : NOTE_NAMES_FLAT.indexOf(name);
    return (parseInt(octave,10)+1) * 12 + Math.max(idx,0);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  /* =========================================================
     18. EXPLICACIÓN DE TEORÍA MUSICAL CON GEMINI
  ========================================================= */
  async function explainWithAI() {
    const label = el.noteBig.textContent;
    if (!label || label === '—') return;
    const apiKey = el.geminiKey.value.trim();
    el.aiExplain.classList.remove('hidden');
    if (!apiKey) { el.aiExplain.textContent = 'Ingresá tu API Key de Gemini en Configuración para habilitar las explicaciones de teoría musical.'; return; }
    el.aiExplain.textContent = 'Consultando a la IA…';

    const keyVal = el.keySelect.value;
    const prompt = `Sos un profesor de teoría musical especializado en bandoneón y tango. En 2-3 frases breves, explicá qué función cumple la nota ${label} dentro de la tonalidad de ${keyVal}, y da un consejo práctico de digitación o interpretación para bandoneón. Respondé en español rioplatense, tono cercano.`;

    await safeAsync(async () => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] })
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      el.aiExplain.textContent = text || 'No se pudo obtener una respuesta de la IA.';
    }, 'consulta a Gemini') || (el.aiExplain.textContent = 'Error al consultar Gemini. Verificá tu API Key y conexión.');
  }

  /* =========================================================
     19. ARRANQUE
  ========================================================= */
  document.addEventListener('DOMContentLoaded', init);

})();
