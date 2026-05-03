/* ══════════════════════════════════════════════════════════════════
   SIREN HUNTER VII — GAME LOGIC
   Engine (audio, radar, proximity, maps) is untouched from v1.
   New: session management, wonder loader, flavour cycle, final screen.
══════════════════════════════════════════════════════════════════ */

/* ── CONSTANTS ──────────────────────────────────────────────────── */
const BEACON_THRESHOLD_M  = 50;    // fallback if wonder.beaconRadiusMeters not set
const AUDIO_MAX_RANGE_M   = 2200;
const AMBIENT_VOLUME      = 0.3;
const PAUSED_VOLUME       = AMBIENT_VOLUME * 0.25;
const KEY_TURN_DEGREES    = 18;
const CLICK_DRAG_PX       = 8;
const TYPEWRITER_SPEED_MS = 38;    // ms per character on final screen
const FLAVOUR_GAP_MS      = 30000; // 30s between flavour lines
const FLAVOUR_HOLD_MS     = 10000; // 10s visible
const DEBUG = new URLSearchParams(location.search).has('debug');

let pageWonderQueue = []; // persists for page lifetime — ensures no repeats until all 7 seen

/* ── GAME STATE ─────────────────────────────────────────────────── */
const gameState = {
  // Session
  sessionQueue:    [],      // shuffled WONDERS for this session
  sessionIndex:    0,       // which wonder we're on (0-6)
  sessionScore:    0,       // accumulated score across all wonders
  sessionSeconds:  0,       // accumulated time across all wonders (seconds used)

  // Current wonder
  currentWonder:   null,
  panorama:        null,
  gameplayStarted: false,
  initToken:       0,

  // Timer / score
  timerInterval:   null,
  secondsLeft:     420,
  score:           0,
  bestDistance:    Infinity,
  currentDistance: Infinity,
  winTriggered:    false,

  // Audio
  paused:          false,
  ambientSound:    null,
  volumeOn:        true,
  audioCtx:        null,
  beaconToneNode:  null,

  // Radar
  radarVisible:    false,
  radarFrame:      null,
  signalInterval:  null,

  // Flavour text
  flavourTimeout:  null,
  flavourInterval: null,

  // Controls
  mouseDown:       null,
};

let lastPingTime = 0;

/* ══════════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
══════════════════════════════════════════════════════════════════ */
function startSession() {
  if (pageWonderQueue.length === 0) pageWonderQueue = shuffleArray([...WONDERS]);
  gameState.sessionQueue   = [...pageWonderQueue];
  gameState.sessionIndex   = 0;
  gameState.sessionScore   = 0;
  gameState.sessionSeconds = 0;
  gameState.score          = 0;
  enterWonder(pageWonderQueue[0]);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── goNextWonder: advance session; check if all 7 done ─────────── */
function goNextWonder() {
  gameState.sessionScore   += gameState.score;
  gameState.sessionSeconds += (gameState.currentWonder?.timeLimit || 420) - gameState.secondsLeft;
  gameState.score           = 0;

  hideOverlay();
  pageWonderQueue.shift(); // remove completed wonder from page-level queue
  gameState.sessionIndex++;

  if (pageWonderQueue.length === 0) {
    showFinalScreen();
    return;
  }
  enterWonder(pageWonderQueue[0]);
}

/* ── retryWonder: keep score, reset timer ───────────────────────── */
function retryWonder() {
  const wonder = gameState.currentWonder;
  hideOverlay();
  stopTimer();
  stopSignalLoop();
  stopAmbient();
  stopRadarLoop();
  stopFlavourCycle();
  showLoader();
  gameState.secondsLeft   = wonder.timeLimit || 420;
  gameState.winTriggered  = false;
  gameState.paused        = false;
  gameState.bestDistance  = Infinity;
  // score intentionally NOT reset — carries over
  gameState.currentDistance = Infinity;
  resetGameUI();
  waitForMaps(() => requestAnimationFrame(() => requestAnimationFrame(() => initGame(wonder))));
}

/* ── restartWonder: reset score + timer, same wonder ────────────── */
function restartWonder() {
  const wonder = gameState.currentWonder;
  hideOverlay();
  stopTimer();
  stopSignalLoop();
  stopAmbient();
  stopRadarLoop();
  stopFlavourCycle();
  showLoader();
  gameState.score         = 0;
  gameState.secondsLeft   = wonder.timeLimit || 420;
  gameState.winTriggered  = false;
  gameState.paused        = false;
  gameState.bestDistance  = Infinity;
  gameState.currentDistance = Infinity;
  resetGameUI();
  waitForMaps(() => requestAnimationFrame(() => requestAnimationFrame(() => initGame(wonder))));
}

/* ── goRandomWonder: score resets, pick any wonder ─────────────── */
function goRandomWonder() {
  hideOverlay();
  gameState.score = 0;
  const wonder = WONDERS[Math.floor(Math.random() * WONDERS.length)];
  enterWonder(wonder);
}

/* ── restartAllSession: full reset, new shuffle ─────────────────── */
function restartAllSession() {
  gameState.score = 0;
  startSession();
}

function resetGameUI() {
  document.getElementById('radar-canvas').classList.add('hidden');
  document.getElementById('city-desc').classList.add('hidden');
  document.getElementById('ctrl-pill').className = 'ctrl-pill sound-active';
  gameState.radarVisible = false;
  gameState.volumeOn     = true;
  updateHUD();
}

/* ══════════════════════════════════════════════════════════════════
   WONDER LOADER SCREEN (7-second Ken Burns intro)
══════════════════════════════════════════════════════════════════ */
function enterWonder(wonder) {
  gameState.currentWonder = wonder;
  if (!gameState.audioCtx) {
    gameState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Set up loader screen visuals
  const bgImg = document.getElementById('loader-bg-img');
  bgImg.src = wonder.image;
  bgImg.onerror = () => { bgImg.style.opacity = '0'; };
  bgImg.style.opacity = '';
  // Restart Ken Burns by re-cloning the animation
  bgImg.style.animation = 'none';
  bgImg.offsetHeight;   // force reflow
  bgImg.style.animation = '';

  document.getElementById('loader-wonder-name').textContent = wonder.label;

  const countEl = document.getElementById('loader-countdown');
  countEl.textContent = '7';

  showScreen('screen-loader');

  let count = 7;
  let earlyPanoId = null;
  let tickId;

  const finish = () => {
    clearInterval(tickId);
    const loaderScreen = document.getElementById('screen-loader');
    loaderScreen.style.transition = 'opacity 0.5s ease';
    loaderScreen.style.opacity    = '0';
    setTimeout(() => {
      loaderScreen.style.opacity    = '';
      loaderScreen.style.transition = '';
      showScreen('screen-game');
      showLoader();
      sizeMapContainer();
      waitForMaps(() => requestAnimationFrame(() => requestAnimationFrame(() => initGame(wonder, earlyPanoId))));
    }, 500);
  };

  const tick = () => {
    count--;
    countEl.textContent = count > 0 ? count : '';
    if (count <= 0) finish();
  };

  // Pre-resolve panorama during countdown; if ready early, burn remaining numbers fast
  if (window._mapsReady) {
    const svc = new google.maps.StreetViewService();
    const tryPreResolve = (radius) => {
      svc.getPanorama({ location: { lat: wonder.startLat, lng: wonder.startLng }, radius }, (data, status) => {
        if (status === google.maps.StreetViewStatus.OK && data?.location?.pano) {
          earlyPanoId = data.location.pano;
          if (count > 1) { clearInterval(tickId); tickId = setInterval(tick, 220); }
        } else if (status !== google.maps.StreetViewStatus.OK && radius < 1000) {
          tryPreResolve(1000);
        }
      });
    };
    tryPreResolve(500);
  }

  tickId = setInterval(tick, 1000);
}

function waitForMaps(cb) {
  if (window._mapsReady) { cb(); return; }
  setTimeout(() => waitForMaps(cb), 100);
}

/* ══════════════════════════════════════════════════════════════════
   SCREEN NAVIGATION
══════════════════════════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'screen-final') {
    document.querySelectorAll('#screen-final .stars-canvas').forEach(initStars);
  }
}

/* ══════════════════════════════════════════════════════════════════
   GAME INIT  (Street View creation — engine untouched)
══════════════════════════════════════════════════════════════════ */
function initGame(wonder, preResolvedPanoId = null) {
  const token = ++gameState.initToken;
  stopTimer();
  stopSignalLoop();
  stopAmbient();
  stopRadarLoop();
  stopFlavourCycle();

  gameState.secondsLeft     = wonder.timeLimit || 420;
  gameState.bestDistance    = Infinity;
  gameState.currentDistance = Infinity;
  gameState.winTriggered    = false;
  gameState.gameplayStarted = false;
  gameState.paused          = false;
  gameState.radarVisible    = false;
  gameState.volumeOn        = true;
  hideOverlay();
  resetGameUI();

  if (preResolvedPanoId) {
    createPanorama(wonder, preResolvedPanoId, token);
  } else {
    resolveStartPanorama(wonder, token, (panoId, status) => {
      if (token !== gameState.initToken) return;
      if (!panoId) { showStreetViewError(wonder, status); return; }
      createPanorama(wonder, panoId, token);
    });
  }
}

function resolveStartPanorama(wonder, token, cb) {
  const svc        = new google.maps.StreetViewService();
  const startCoords = { lat: wonder.startLat, lng: wonder.startLng };

  const resolveByLocation = (radius, done) => {
    svc.getPanorama({ location: startCoords, radius }, (data, status) => {
      if (token !== gameState.initToken) return;
      if (status === google.maps.StreetViewStatus.OK && data?.location?.pano) {
        done(data.location.pano, status);
      } else if (radius < 1000) {
        resolveByLocation(1000, done);
      } else {
        done(null, status);
      }
    });
  };

  if (wonder.startPano) {
    svc.getPanorama({ pano: wonder.startPano }, (data, status) => {
      if (token !== gameState.initToken) return;
      if (status === google.maps.StreetViewStatus.OK && data?.location?.pano) {
        cb(data.location.pano, status); return;
      }
      resolveByLocation(500, cb);
    });
    return;
  }

  resolveByLocation(500, cb);
}

function createPanorama(wonder, panoId, token) {
  const mapDiv = document.getElementById('map');
  if (gameState.panorama) google.maps.event.clearInstanceListeners(gameState.panorama);

  gameState.panorama = new google.maps.StreetViewPanorama(mapDiv, {
    pano:                   panoId,
    pov:                    { heading: wonder.startHeading ?? 180, pitch: wonder.startPitch ?? 0 },
    zoom:                   0,
    visible:                true,
    addressControl:         false,
    fullscreenControl:      false,
    motionTracking:         false,
    motionTrackingControl:  false,
    showRoadLabels:         false,
    zoomControl:            false,
    panControl:             false,
    linksControl:           true,
    clickToGo:              false,
  });

  // Wire listeners BEFORE triggering resize so no early-firing events are missed
  bindGameControls();

  const startOnce = () => {
    if (token !== gameState.initToken || gameState.gameplayStarted) return;
    const pos  = gameState.panorama?.getPosition();
    const pano = gameState.panorama?.getPano();
    if (!pos || !pano) return;

    gameState.gameplayStarted = true;
    updatePlayerPosition(wonder);
    hideLoader();
    startTimer();
    startSignalLoop();
    initAmbient(wonder.id);
    startFlavourCycle(wonder);
    if (DEBUG) { initDebugOverlay(); updateDebugPanel(pos, gameState.currentDistance); }
  };

  gameState.panorama.addListener('pano_changed',     startOnce);
  gameState.panorama.addListener('status_changed',   () => {
    if (gameState.panorama.getStatus() === google.maps.StreetViewStatus.OK) startOnce();
  });
  gameState.panorama.addListener('position_changed', () => {
    updatePlayerPosition(wonder);
    if (!gameState.winTriggered &&
        gameState.currentDistance < (wonder.beaconRadiusMeters || BEACON_THRESHOLD_M)) {
      triggerWin(wonder);
    }
    startOnce();
  });
  gameState.panorama.addListener('pov_changed', () => {
    const pos = gameState.panorama.getPosition();
    if (pos) drawRadar(pos, wonder);
  });

  google.maps.event.trigger(gameState.panorama, 'resize');

  setTimeout(startOnce, 2500);
  setTimeout(startOnce, 5000);
  setTimeout(() => {
    if (token !== gameState.initToken || gameState.gameplayStarted) return;
    hideLoader();
    showStreetViewError(wonder, gameState.panorama?.getStatus?.() || 'NO_PANORAMA');
  }, 12000);
}

function updatePlayerPosition(wonder) {
  const pos = gameState.panorama?.getPosition();
  if (!pos) return;
  gameState.currentDistance = haversineDistance(pos, wonder.beaconLat, wonder.beaconLng);
  updateScoreFromProgress();
  drawRadar(pos, wonder);
  if (DEBUG) updateDebugPanel(pos, gameState.currentDistance);
}

function updateScoreFromProgress() {
  if (!isFinite(gameState.currentDistance)) return;
  if (!isFinite(gameState.bestDistance)) {
    gameState.bestDistance = gameState.currentDistance;
    updateHUD(); return;
  }
  const improvement = gameState.bestDistance - gameState.currentDistance;
  if (improvement >= 1) {
    const multiplier = gameState.volumeOn ? 2 : 1;
    gameState.score += Math.round(improvement * multiplier);
    gameState.bestDistance = gameState.currentDistance;
    updateHUD();
  }
}

function sizeMapContainer() {
  const mapDiv = document.getElementById('map');
  mapDiv.style.width  = `${window.innerWidth}px`;
  mapDiv.style.height = `${window.innerHeight}px`;
}

function resizePanorama() {
  sizeMapContainer();
  if (gameState.panorama) google.maps.event.trigger(gameState.panorama, 'resize');
}

function showStreetViewError(wonder, status) {
  stopTimer(); stopSignalLoop(); stopAmbient(); stopRadarLoop(); stopFlavourCycle();
  hideLoader();
  document.getElementById('fail-desc').textContent =
    `Street View could not load for ${wonder.name} (${status}). Check coordinates or API key restrictions.`;
  showOverlay('hunt-failed');
}

/* ══════════════════════════════════════════════════════════════════
   PLAYER CONTROLS  (engine untouched)
══════════════════════════════════════════════════════════════════ */
function bindGameControls() {
  const mapDiv = document.getElementById('map');
  mapDiv.oncontextmenu = e => e.preventDefault();
  mapDiv.onmousedown   = e => {
    if (!isGameInputAllowed(e)) return;
    gameState.mouseDown = { button: e.button, x: e.clientX, y: e.clientY };
  };
  mapDiv.onmouseup = e => {
    if (!isGameInputAllowed(e) || !gameState.mouseDown) return;
    const dx = Math.abs(e.clientX - gameState.mouseDown.x);
    const dy = Math.abs(e.clientY - gameState.mouseDown.y);
    const wasClick = dx <= CLICK_DRAG_PX && dy <= CLICK_DRAG_PX;
    const button   = gameState.mouseDown.button;
    gameState.mouseDown = null;
    if (!wasClick) return;
    if (button === 0) moveByHeading(0);
    if (button === 2) moveByHeading(180);
  };
  if (!window.__sirenHunterKeysBound) {
    window.__sirenHunterKeysBound = true;
    document.addEventListener('keydown', handleGameKeydown);
  }
}

function handleGameKeydown(e) {
  if (e.target?.matches?.('input, textarea')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!document.getElementById('instructions-modal').classList.contains('hidden')) { hideInstructions(); return; }
    if (isGameScreenActive()) { pauseGame(); return; }
    return;
  }
  if (e.shiftKey && e.key.toLowerCase() === 'r' && isGameplayActive()) { e.preventDefault(); restartWonder(); return; }
  if (!isGameplayActive()) return;
  if      (e.key === ' ')          { e.preventDefault(); toggleAudioMode(); }
  else if (e.key === 'ArrowUp')    { e.preventDefault(); moveByHeading(0); }
  else if (e.key === 'ArrowDown')  { e.preventDefault(); moveByHeading(180); }
  else if (e.key === 'ArrowLeft')  { e.preventDefault(); rotateView(-KEY_TURN_DEGREES); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); rotateView(KEY_TURN_DEGREES); }
}

function isGameScreenActive()  { return document.getElementById('screen-game')?.classList.contains('active'); }
function isGameplayActive()    { return isGameScreenActive() && gameState.gameplayStarted && !gameState.paused && !gameState.winTriggered; }
function isGameInputAllowed(e) { return isGameplayActive() && e.target.closest('#map'); }
function toggleAudioMode()     { setAudioMode(gameState.volumeOn ? 'radar' : 'sound'); }

function rotateView(delta) {
  const pov = gameState.panorama.getPov();
  gameState.panorama.setPov({ ...pov, heading: (pov.heading + delta + 360) % 360 });
}

function moveByHeading(offsetDeg) {
  const links   = gameState.panorama?.getLinks?.() || [];
  if (!links.length) return;
  const heading = (gameState.panorama.getPov().heading + offsetDeg + 360) % 360;
  const best    = links.reduce((w, link) => {
    const diff = angularDistance(heading, link.heading);
    return !w || diff < w.diff ? { link, diff } : w;
  }, null);
  if (!best?.link?.pano) return;
  gameState.panorama.setPano(best.link.pano);
}

function angularDistance(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/* ══════════════════════════════════════════════════════════════════
   TIMER  (engine untouched)
══════════════════════════════════════════════════════════════════ */
function startTimer() {
  clearInterval(gameState.timerInterval);
  gameState.timerInterval = setInterval(() => {
    gameState.secondsLeft--;
    updateHUD();
    if (gameState.secondsLeft <= 0) triggerFail();
  }, 1000);
}

function stopTimer() {
  clearInterval(gameState.timerInterval);
  gameState.timerInterval = null;
}

function timeTaken() {
  const taken = (gameState.currentWonder?.timeLimit || 420) - gameState.secondsLeft;
  return String(Math.floor(taken / 60)).padStart(2, '0') + ':' + String(taken % 60).padStart(2, '0');
}

function updateHUD() {
  const m = String(Math.floor(gameState.secondsLeft / 60)).padStart(2, '0');
  const s = String(gameState.secondsLeft % 60).padStart(2, '0');
  document.getElementById('hud-timer').textContent = `${m}:${s}`;
  const runningTotal = Math.max(0, gameState.sessionScore + gameState.score);
  document.getElementById('hud-score').textContent = String(runningTotal).padStart(4, '0');
}

/* ══════════════════════════════════════════════════════════════════
   PROXIMITY SIGNAL — Web Audio API  (engine untouched)
══════════════════════════════════════════════════════════════════ */
function startSignalLoop() {
  clearInterval(gameState.signalInterval);
  lastPingTime = 0;
  gameState.signalInterval = setInterval(proximityTick, 50);
}

function stopSignalLoop() {
  clearInterval(gameState.signalInterval);
  gameState.signalInterval = null;
  stopBeaconTone();
}

function proximityTick() {
  if (!gameState.volumeOn || gameState.paused || gameState.winTriggered) return;
  const dist = gameState.currentDistance;
  if (!isFinite(dist) || dist >= AUDIO_MAX_RANGE_M) return;
  const signal = getSignalProperties();
  const now    = Date.now();
  if (now - lastPingTime >= signal.intervalMs) { playPing(signal.volume, signal.pan); lastPingTime = now; }
}

function playPing(volume, pan = 0) {
  if (!gameState.audioCtx) return;
  try {
    const ctx     = gameState.audioCtx;
    const osc     = ctx.createOscillator();
    const gain    = ctx.createGain();
    const panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    osc.connect(gain);
    if (panNode) { gain.connect(panNode); panNode.connect(ctx.destination); panNode.pan.value = Math.max(-1, Math.min(1, pan)); }
    else          { gain.connect(ctx.destination); }
    osc.type            = 'sine';
    osc.frequency.value = 396;
    gain.gain.setValueAtTime(volume * 0.28, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.22);
  } catch (e) {}
}

function playBeaconTone() {
  if (!gameState.audioCtx || gameState.beaconToneNode) return;
  const ctx  = gameState.audioCtx;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type            = 'sine';
  osc.frequency.value = 396;
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.40, ctx.currentTime + 0.5);
  osc.start(ctx.currentTime);
  gameState.beaconToneNode = { osc, gain };
}

function stopBeaconTone() {
  if (!gameState.beaconToneNode) return;
  try {
    const { osc, gain } = gameState.beaconToneNode;
    gain.gain.linearRampToValueAtTime(0, gameState.audioCtx.currentTime + 0.3);
    osc.stop(gameState.audioCtx.currentTime + 0.3);
  } catch (e) {}
  gameState.beaconToneNode = null;
}

/* ══════════════════════════════════════════════════════════════════
   WIN / FAIL
══════════════════════════════════════════════════════════════════ */
function triggerWin(wonder) {
  if (gameState.winTriggered) return;
  gameState.winTriggered = true;
  const timeMultiplier = gameState.volumeOn ? 3 : 1.5;
  gameState.score += Math.max(0, Math.round(gameState.secondsLeft * timeMultiplier));
  updateHUD();
  stopTimer(); stopSignalLoop(); stopAmbient(); stopRadarLoop(); stopFlavourCycle();
  playBeaconTone();
  setTimeout(() => {
    stopBeaconTone();
    document.getElementById('win-time').textContent  = timeTaken();
    document.getElementById('win-score').textContent = String(gameState.score).padStart(4, '0');
    document.getElementById('win-desc').textContent  = '';
    showOverlay('siren-hunted');
  }, 5000);
}

function triggerFail() {
  stopTimer(); stopSignalLoop(); stopAmbient(); stopRadarLoop(); stopFlavourCycle();
  const wonder = gameState.currentWonder;
  document.getElementById('fail-time').textContent  = timeTaken();
  document.getElementById('fail-score').textContent = String(gameState.score).padStart(4, '0');
  document.getElementById('fail-desc').textContent  = wonder?.failText || '';
  showOverlay('hunt-failed');
}

/* ══════════════════════════════════════════════════════════════════
   OVERLAYS / PAUSE
══════════════════════════════════════════════════════════════════ */
function showOverlay(name) {
  if (name === 'leave-hunt') {
    document.getElementById('quit-time').textContent  = timeTaken();
    document.getElementById('quit-score').textContent = document.getElementById('hud-score').textContent;
    const wonder = gameState.currentWonder;
    document.getElementById('quit-desc').textContent  = wonder?.failText || '';
  }
  document.querySelectorAll('.game-overlay').forEach(o => o.classList.add('hidden'));
  document.getElementById(`overlay-${name}`).classList.remove('hidden');
}

function hideOverlay() {
  document.querySelectorAll('.game-overlay').forEach(o => o.classList.add('hidden'));
}

function pauseGame() {
  if (!isGameplayActive()) return;
  gameState.paused = true;
  stopTimer(); stopSignalLoop();
  gameState.ambientSound?.fade(gameState.ambientSound.volume(), PAUSED_VOLUME, 250);
  showOverlay('leave-hunt');
}

function resumeGame() {
  if (!gameState.paused) { hideOverlay(); return; }
  gameState.paused = false;
  hideOverlay();
  gameState.ambientSound?.fade(gameState.ambientSound.volume(), AMBIENT_VOLUME, 250);
  startTimer(); startSignalLoop();
  if (gameState.radarVisible) startRadarLoop();
}

function quitToHome() {
  gameState.initToken++;
  stopTimer(); stopSignalLoop(); stopAmbient(); stopRadarLoop(); stopFlavourCycle();
  hideOverlay();
  pageWonderQueue.shift(); // advance queue so quitting doesn't repeat the same wonder
  showScreen('screen-home');
}

function showInstructions() {
  document.getElementById('instructions-modal').classList.remove('hidden');
}
function hideInstructions() {
  document.getElementById('instructions-modal').classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════
   FINAL SCREEN
══════════════════════════════════════════════════════════════════ */
function showFinalScreen() {
  stopTimer(); stopSignalLoop(); stopAmbient(); stopRadarLoop(); stopFlavourCycle();

  const totalMin = Math.floor(gameState.sessionSeconds / 60);
  const totalSec = gameState.sessionSeconds % 60;
  document.getElementById('final-time').textContent =
    `${String(totalMin).padStart(2,'0')}:${String(totalSec).padStart(2,'0')}`;
  document.getElementById('final-score').textContent =
    String(gameState.sessionScore).padStart(4, '0');

  showScreen('screen-final');
  setTimeout(startTransmissionReveal, 600);
}

function startTransmissionReveal() {
  const container = document.getElementById('transmission-lines');
  container.innerHTML = '';
  document.querySelector('.final-btns').classList.add('hidden');

  const items = TRANSMISSION_LINES.map(line => {
    const el = document.createElement('p');
    el.className = 'transmission-line';
    container.appendChild(el);
    return { el, line };
  });

  function revealNext(index) {
    if (index >= items.length) {
      setTimeout(() => {
        const btns = document.querySelector('.final-btns');
        btns.classList.remove('hidden');
        btns.classList.add('final-btns-visible');
      }, 1000);
      return;
    }
    typewriterLine(items[index].el, items[index].line, () => {
      if (index === 1) {
        const el = items[index].el;
        const text = el.textContent;
        const linkStart = text.indexOf('Share the game');
        if (linkStart !== -1) {
          el.innerHTML = text.slice(0, linkStart) +
            '<a href="https://sirenhunter-game.vercel.app" target="_blank" rel="noopener" class="transmission-link">Share the game to spread the fun →</a>';
        }
      }
      revealNext(index + 1);
    });
  }
  revealNext(0);
}

function typewriterLine(el, text, onDone) {
  el.textContent = '';
  let i = 0;
  const tick = setInterval(() => {
    el.textContent += text[i];
    i++;
    if (i >= text.length) {
      clearInterval(tick);
      if (onDone) onDone();
    }
  }, TYPEWRITER_SPEED_MS);
}

/* ══════════════════════════════════════════════════════════════════
   AMBIENT AUDIO — Howler.js  (engine untouched)
══════════════════════════════════════════════════════════════════ */
function initAmbient(wonderId) {
  stopAmbient();
  gameState.ambientSound = new Howl({
    src:          [`audio/${wonderId}/ambient.mp3`],
    loop:         true,
    volume:       gameState.paused ? PAUSED_VOLUME : AMBIENT_VOLUME,
    onloaderror:  () => { /* silently skip if file not present */ },
  });
  gameState.ambientSound.play();
}

function stopAmbient() {
  if (gameState.ambientSound) { gameState.ambientSound.stop(); gameState.ambientSound = null; }
}

function setAudioMode(mode) {
  const pill = document.getElementById('ctrl-pill');
  if (mode === 'sound') {
    gameState.volumeOn     = true;
    gameState.radarVisible = false;
    if (gameState.ambientSound && !gameState.ambientSound.playing()) gameState.ambientSound.play();
    pill.className = 'ctrl-pill sound-active';
    document.getElementById('radar-canvas').classList.add('hidden');
    stopRadarLoop();
  } else {
    gameState.volumeOn     = false;
    gameState.radarVisible = true;
    if (gameState.ambientSound && !gameState.ambientSound.playing()) gameState.ambientSound.play();
    pill.className = 'ctrl-pill radar-active';
    document.getElementById('radar-canvas').classList.remove('hidden');
    const pos = gameState.panorama?.getPosition();
    if (pos && gameState.currentWonder) updatePlayerPosition(gameState.currentWonder);
    startRadarLoop();
  }
}

/* ══════════════════════════════════════════════════════════════════
   FLAVOUR TEXT CYCLE  (30s gap / 10s display / random line per cycle)
══════════════════════════════════════════════════════════════════ */
function startFlavourCycle(wonder) {
  stopFlavourCycle();
  const el    = document.getElementById('city-desc');
  const lines = wonder.flavourLines || [];
  if (!lines.length) return;

  const showLine = () => {
    const line = lines[Math.floor(Math.random() * lines.length)];
    el.textContent = line.text;
    el.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('flavour-visible')));

    gameState.flavourTimeout = setTimeout(() => {
      el.classList.remove('flavour-visible');
      setTimeout(() => el.classList.add('hidden'), 600); // wait for fade-out
    }, FLAVOUR_HOLD_MS);
  };

  // First appearance after 30s, then every 40s (30s gap + 10s hold)
  gameState.flavourTimeout  = setTimeout(showLine, FLAVOUR_GAP_MS);
  gameState.flavourInterval = setInterval(showLine, FLAVOUR_GAP_MS + FLAVOUR_HOLD_MS + 1000);
}

function stopFlavourCycle() {
  clearTimeout(gameState.flavourTimeout);
  clearInterval(gameState.flavourInterval);
  gameState.flavourTimeout  = null;
  gameState.flavourInterval = null;
  const el = document.getElementById('city-desc');
  if (el) { el.classList.add('hidden'); el.classList.remove('flavour-visible'); }
}

/* ══════════════════════════════════════════════════════════════════
   RADAR CANVAS  (engine untouched)
══════════════════════════════════════════════════════════════════ */
function startRadarLoop() {
  stopRadarLoop();
  const tick = () => {
    const wonder = gameState.currentWonder;
    const pos    = gameState.panorama?.getPosition();
    if (gameState.radarVisible && pos && wonder) {
      drawRadar(pos, wonder);
      gameState.radarFrame = requestAnimationFrame(tick);
    }
  };
  gameState.radarFrame = requestAnimationFrame(tick);
}

function stopRadarLoop() {
  if (gameState.radarFrame) { cancelAnimationFrame(gameState.radarFrame); gameState.radarFrame = null; }
}

function drawRadar(pos, wonder) {
  if (!gameState.radarVisible) return;
  const canvas = document.getElementById('radar-canvas');
  const W = canvas.width, H = canvas.height;
  const ctx    = canvas.getContext('2d');
  const cx = W/2, cy = H/2, maxR = cx * 0.82;
  const signal = getSignalProperties(wonder);

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill(); ctx.clip();
  drawRadarGlow(ctx, cx, cy, maxR, signal.relAngle, signal.pulseAlpha);
  ctx.restore();

  [1, 0.65, 0.33].forEach(f => {
    ctx.beginPath(); ctx.arc(cx, cy, maxR*f, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(188,155,105,${0.3*f})`; ctx.lineWidth = 1; ctx.stroke();
  });
  ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(238,185,108,0.5)'; ctx.fill();
}

function drawRadarGlow(ctx, cx, cy, maxR, relAngle, alpha) {
  const sector = getDirectionSector(relAngle);
  let gradient;
  if (sector === 'top') {
    gradient = ctx.createLinearGradient(cx, cy-maxR, cx, cy);
    gradient.addColorStop(0, `rgba(238,185,108,${alpha})`);
    gradient.addColorStop(1, 'rgba(238,185,108,0)');
    ctx.fillStyle = gradient; ctx.fillRect(cx-maxR, cy-maxR, maxR*2, maxR);
  } else if (sector === 'right') {
    gradient = ctx.createLinearGradient(cx+maxR, cy, cx, cy);
    gradient.addColorStop(0, `rgba(238,185,108,${alpha})`);
    gradient.addColorStop(1, 'rgba(238,185,108,0)');
    ctx.fillStyle = gradient; ctx.fillRect(cx, cy-maxR, maxR, maxR*2);
  } else if (sector === 'bottom') {
    gradient = ctx.createLinearGradient(cx, cy+maxR, cx, cy);
    gradient.addColorStop(0, `rgba(238,185,108,${alpha})`);
    gradient.addColorStop(1, 'rgba(238,185,108,0)');
    ctx.fillStyle = gradient; ctx.fillRect(cx-maxR, cy, maxR*2, maxR);
  } else {
    gradient = ctx.createLinearGradient(cx-maxR, cy, cx, cy);
    gradient.addColorStop(0, `rgba(238,185,108,${alpha})`);
    gradient.addColorStop(1, 'rgba(238,185,108,0)');
    ctx.fillStyle = gradient; ctx.fillRect(cx-maxR, cy-maxR, maxR, maxR*2);
  }
}

function getDirectionSector(relAngle) {
  if (relAngle >= 315 || relAngle < 45)  return 'top';
  if (relAngle >= 45  && relAngle < 135) return 'right';
  if (relAngle >= 135 && relAngle < 225) return 'bottom';
  return 'left';
}

function getSignalProperties(wonder) {
  wonder = wonder || gameState.currentWonder;
  const dist    = isFinite(gameState.currentDistance) ? gameState.currentDistance : AUDIO_MAX_RANGE_M;
  const ratio   = Math.max(0, Math.min(1, (AUDIO_MAX_RANGE_M - dist) / AUDIO_MAX_RANGE_M));
  const volume  = Math.min(1, Math.pow(ratio, 0.8));
  const intervalMs = 150 + 1850 * Math.pow(1 - ratio, 2);
  const pos = gameState.panorama?.getPosition();
  let relAngle = 0;
  if (pos && wonder) {
    const bear    = bearingTo(pos, wonder.beaconLat, wonder.beaconLng);
    const heading = gameState.panorama.getPov().heading;
    relAngle = (bear - heading + 360) % 360;
  }
  const pan        = Math.sin(relAngle * Math.PI / 180);
  const pulse      = (Math.sin(Date.now() / intervalMs * Math.PI * 2) + 1) / 2;
  const pulseAlpha = (0.12 + 0.52 * pulse) * (0.35 + 0.65 * Math.max(ratio, 0.2));
  return { intervalMs, volume, pan, relAngle, pulseAlpha };
}

/* ══════════════════════════════════════════════════════════════════
   GEO MATH  (engine untouched)
══════════════════════════════════════════════════════════════════ */
function haversineDistance(pos, lat2, lng2) {
  const R  = 6371000;
  const φ1 = pos.lat() * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2 - pos.lat()) * Math.PI/180;
  const Δλ = (lng2 - pos.lng()) * Math.PI/180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearingTo(pos, lat2, lng2) {
  const φ1 = pos.lat() * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δλ = (lng2 - pos.lng()) * Math.PI/180;
  const y  = Math.sin(Δλ)*Math.cos(φ2);
  const x  = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360;
}

/* ══════════════════════════════════════════════════════════════════
   LOADER (small overlay — while Street View tiles load)
══════════════════════════════════════════════════════════════════ */
function showLoader() { document.getElementById('loader').classList.remove('hidden'); }
function hideLoader() { document.getElementById('loader').classList.add('hidden'); }

/* ══════════════════════════════════════════════════════════════════
   DEBUG OVERLAY  (?debug in URL)
══════════════════════════════════════════════════════════════════ */
function initDebugOverlay() {
  if (document.getElementById('debug-panel')) return;
  const d = document.createElement('div');
  d.id = 'debug-panel';
  d.style.cssText = 'position:fixed;bottom:90px;left:180px;background:rgba(0,0,0,0.75);color:#EEB96C;font-size:11px;padding:6px 10px;z-index:9999;font-family:monospace;pointer-events:none;border-radius:4px;line-height:1.6';
  document.body.appendChild(d);
}

function updateDebugPanel(pos, dist) {
  const d = document.getElementById('debug-panel');
  if (d) d.innerHTML = `lat: ${pos.lat().toFixed(5)}<br>lng: ${pos.lng().toFixed(5)}<br>dist: ${Math.round(dist)}m<br>wonder: ${gameState.currentWonder?.id}`;
}

/* ══════════════════════════════════════════════════════════════════
   STAR FIELD  (untouched)
══════════════════════════════════════════════════════════════════ */
const STAR_COLOURS = ['#BC9B69','#EEB96C','#C8A46E','#D4A849','#F0C060','#A08040','#E8C87A'];

function initStars(canvas) {
  canvas.width  = 1280;
  canvas.height = 832;
  const ctx   = canvas.getContext('2d');
  const stars = Array.from({ length: 130 }, () => ({
    rx:        Math.random(), ry:        Math.random(),
    radius:    Math.random() * 1.4 + 0.4,
    glow:      Math.random() < 0.12,
    colour:    STAR_COLOURS[Math.floor(Math.random() * STAR_COLOURS.length)],
    phase:     Math.random() * Math.PI * 2,
    speed:     Math.random() * 0.012 + 0.004,
    baseAlpha: Math.random() * 0.35 + 0.15,
    swing:     Math.random() * 0.25 + 0.10,
  }));
  (function draw() {
    ctx.clearRect(0, 0, 1280, 832);
    stars.forEach(s => {
      s.phase += s.speed;
      const alpha = Math.max(0, Math.min(1, s.baseAlpha + Math.sin(s.phase) * s.swing));
      const cx = s.rx * 1280, cy = s.ry * 832;
      ctx.globalAlpha = alpha;
      if (s.glow) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s.radius*5);
        g.addColorStop(0, s.colour); g.addColorStop(1, 'transparent');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, s.radius*5, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = alpha * 1.4;
      }
      ctx.fillStyle = s.colour; ctx.beginPath(); ctx.arc(cx, cy, s.radius, 0, Math.PI*2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }());
}

/* ── boot ── */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#screen-home .stars-canvas').forEach(initStars);
  window.addEventListener('resize', resizePanorama);
});

/* ── keyboard zoom: W = in, S = out ── */
document.addEventListener('keydown', e => {
  if (!gameState.panorama) return;
  const key = e.key.toLowerCase();
  if (key === 'w') {
    gameState.panorama.setZoom(Math.min(3, gameState.panorama.getZoom() + 0.5));
  } else if (key === 's') {
    gameState.panorama.setZoom(Math.max(0, gameState.panorama.getZoom() - 0.5));
  }
});
