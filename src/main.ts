import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles.css';
import {
  JourneyController,
  WheelIntent,
  type MotionMode,
  type TimedFrame,
} from './controller';
import { RollingDigits, earthDistance } from './instruments';
import { inspectionInput } from './inspection-input';
import {
  CHECKPOINTS,
  TOTAL,
  OBSERVATION_FACTS,
  resolveStop,
  PLAYBACK_SECONDS,
  LEG_DURATIONS,
} from './journey';
import { distanceAxis, type FlightState } from './flight';
import {
  C,
  PARKER,
  RS,
  EARTH_RADIUS,
  duration,
  tidal,
  travelTime,
  AU,
} from './science';
import {
  readUnitMode,
  writeUnitMode,
  formatLength,
  formatAcceleration,
  speedValue,
  speedUnit,
  observationFacts,
  detailFacts,
  type UnitMode,
} from './units';
import type { JourneyRenderer } from './renderer';
import { AudioEngine } from './audio';
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
let renderer: JourneyRenderer | null | undefined;
let disposed = false;
const audio = new AudioEngine(),
  controller = new JourneyController(),
  wheel = new WheelIntent();
const MOTION_KEY = 'journey-through-space.motion';
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
function readMotionMode(): MotionMode {
  try {
    const saved =
      localStorage.getItem(MOTION_KEY) ??
      localStorage.getItem('event-horizon.motion');
    if (saved === 'system' || saved === 'full' || saved === 'reduced')
      return saved;
  } catch {
    /* storage unavailable */
  }
  return 'full';
}
function writeMotionMode(mode: MotionMode) {
  try {
    localStorage.setItem(MOTION_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}
controller.setMotionMode(readMotionMode(), reducedQuery.matches);
const motionSelect = $<HTMLSelectElement>('#motion-mode');
motionSelect.value = controller.currentMotionMode;
const digits = new RollingDigits($('#speed-digits'));
const clearInspection = inspectionInput($('#inspection'), controller, () => {
  state = controller.snapshot();
  renderer?.render(state, time);
});

let state: TimedFrame = controller.snapshot(),
  time = 0,
  last = performance.now(),
  visible = !document.hidden,
  uiAt = 0,
  selected = -1;
const axisModel = distanceAxis(0, 0);
let unitMode: UnitMode = readUnitMode();
const unitSelect = $<HTMLSelectElement>('#unit-mode');
unitSelect.value = unitMode;
unitSelect.addEventListener('change', () => {
  unitMode = unitSelect.value as UnitMode;
  writeUnitMode(unitMode);
  updateUI();
});
function closeSettings(focus = true) {
  $('#preference-controls').hidden = true;
  $('#settings-toggle').setAttribute('aria-expanded', 'false');
  if (focus) $('#settings-toggle').focus();
}
$('#settings-toggle').addEventListener('click', () => {
  const open = $('#preference-controls').hidden;
  $('#preference-controls').hidden = !open;
  $('#settings-toggle').setAttribute('aria-expanded', String(open));
  if (open) motionSelect.focus();
});
function closeAuHelp(focus = true) {
  $('#au-help').hidden = true;
  $('#au-help-toggle').setAttribute('aria-expanded', 'false');
  if (focus) $('#au-help-toggle').focus();
}
$('#au-help-toggle').addEventListener('click', () => {
  const open = $('#au-help').hidden;
  $('#au-help').hidden = !open;
  $('#au-help-toggle').setAttribute('aria-expanded', String(open));
});
let previewIndex = -1;
const routeStopButtons: HTMLButtonElement[] = [];
function closePreview(focus = false) {
  $('#route-preview').hidden = true;
  if (focus && previewIndex >= 0) routeStopButtons[previewIndex]?.focus();
}
function summary(stop: (typeof CHECKPOINTS)[number]) {
  return stop.id === 'earth'
    ? 'One blue world, a thin atmosphere, and everything we have ever called home.'
    : (stop.description.match(/.*?[.!?](?:\s|$)/)?.[0].trim() ??
        stop.description);
}
function positionPreview(i: number) {
  const popup = $('#route-preview');
  const btn = routeStopButtons[i];
  if (popup.hidden || !btn) return;
  const railRect = $('#rail').getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const anchorX = btnRect.left + btnRect.width / 2 - railRect.left;
  const popupWidth = popup.offsetWidth || Math.min(360, railRect.width);
  const left = Math.max(
    0,
    Math.min(railRect.width - popupWidth, anchorX - popupWidth / 2),
  );
  popup.style.left = `${left}px`;
  const arrowX = Math.max(18, Math.min(popupWidth - 18, anchorX - left));
  popup.style.setProperty('--preview-arrow-x', `${arrowX}px`);
}
function preview(i: number) {
  previewIndex = i;
  $('#route-preview-text').textContent =
    `${CHECKPOINTS[i].name} — ${summary(CHECKPOINTS[i])}`;
  $('#route-preview').hidden = false;
  positionPreview(i);
}
const touchRoute = () => matchMedia('(hover: none)').matches;
for (const [i, p] of CHECKPOINTS.entries()) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = p.name;
  b.dataset.stop = p.id;
  b.className = 'route-stop';
  b.setAttribute('aria-label', `Go to ${p.name}`);
  b.style.setProperty(
    '--route-gap',
    `${i ? 8 + Math.sqrt(LEG_DURATIONS[i - 1]) * 2 : 0}px`,
  );
  b.addEventListener('pointerenter', () => {
    if (!touchRoute()) preview(i);
  });
  b.addEventListener('focus', () => preview(i));
  b.addEventListener('click', (event) => {
    if (touchRoute() && event.detail !== 0) preview(i);
    else {
      closePreview();
      flyToStop(i);
    }
  });
  routeStopButtons.push(b);
  $('#route-stops').append(b);
}
const routeProgressFill = document.createElement('span');
routeProgressFill.id = 'route-progress-fill';
routeProgressFill.setAttribute('aria-hidden', 'true');
const routeTraveler = document.createElement('span');
routeTraveler.id = 'route-traveler';
routeTraveler.setAttribute('aria-hidden', 'true');
routeTraveler.dataset.active = 'false';
routeTraveler.innerHTML =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.5 8 2.5 2.5 5.2 8 2.5 13.5Z"/></svg>';
$('#route-stops').append(routeProgressFill, routeTraveler);
$('#route-scroll').addEventListener('scroll', () => {
  if (previewIndex >= 0 && !$('#route-preview').hidden)
    positionPreview(previewIndex);
});
$('#route-go').addEventListener('click', () => {
  const target = previewIndex;
  closePreview();
  if (target >= 0) flyToStop(target);
});
$('#rail').addEventListener('pointerleave', () => {
  if (!touchRoute() && !$('#rail').contains(document.activeElement))
    closePreview();
});
document.addEventListener('focusin', (e) => {
  if (!$('#rail').contains(e.target as Node)) closePreview();
});
document.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target as Node;
    const dismissing =
      !$('#preference-controls').hidden ||
      !$('#au-help').hidden ||
      !$('#route-preview').hidden;
    if (dismissing && $('#inspection').contains(target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      clearInspection();
    }
    if (!$('#settings').contains(target)) closeSettings(false);
    if (!$('#earth-distance').contains(target)) closeAuHelp(false);
    if (!$('#rail').contains(target)) closePreview();
  },
  { capture: true },
);
let navigationToken = 0;
async function go(id: string, record = true, fade = true) {
  const restoreNavigationFocus = document.activeElement === $('#route-go');
  const token = ++navigationToken;
  closePreview();
  clearInspection();
  wheel.reset();
  controller.pause(performance.now());
  document.body.classList.toggle('direct-navigation', fade);
  if (fade) await new Promise((resolve) => setTimeout(resolve, 160));
  if (token !== navigationToken) return;
  controller.observe(resolveStop(id));
  if (resolveStop(id) === 0) {
    time = 0;
    renderer?.resetTiming();
  }
  state = controller.snapshot();
  updateUI();
  renderer?.render(state, time);
  const hash = `#${CHECKPOINTS[state.now].id}`;
  if (record && location.hash !== hash) history.pushState(null, '', hash);
  else history.replaceState(null, '', hash);
  document.body.classList.remove('direct-navigation');
  if (id === 'earth' || restoreNavigationFocus) $('#next').focus();
  $('#journey-announcement').textContent =
    `Arrived at ${CHECKPOINTS[state.now].name}.`;
}
window.addEventListener(
  'hashchange',
  () => void go(location.hash.slice(1), false),
);
window.addEventListener(
  'popstate',
  () => void go(location.hash.slice(1), false),
);
document.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
    'a[href^="#"]',
  );
  if (link) {
    e.preventDefault();
    for (const d of document.querySelectorAll<HTMLDialogElement>(
      'dialog[open]',
    ))
      d.close();
    go(link.hash.slice(1));
  }
});
for (const id of ['sources', 'details']) {
  const d = $<HTMLDialogElement>(`#${id}`);
  $(`#${id}-close`).addEventListener('click', () => d.close());
  d.addEventListener('close', () =>
    (id === 'sources' ? $('#settings-toggle') : $('#details-open')).focus(),
  );
}
function openDialog(id: string) {
  $<HTMLDialogElement>(`#${id}`).showModal();
}
$('#sources-open').addEventListener('click', () => {
  closeSettings(false);
  openDialog('sources');
});
$('#details-open').addEventListener('click', () => {
  updateDetails();
  openDialog('details');
});
function updateDetails() {
  const p = CHECKPOINTS[state.now];
  $('#details-title').textContent = p.name;
  const metrics: [string, string][] = [
    ['Direct distance to Earth', formatLength(state.earthKm, unitMode)],
    ['Light signal to Earth', duration(state.earthKm / C)],
    ['Route distance', formatLength(state.routeKm, unitMode)],
    ['Light-equivalent route time', duration(state.routeKm / C)],
    ['Full forward playback', `${PLAYBACK_SECONDS} seconds`],
    ['At Parker’s record speed', duration(state.routeKm / PARKER)],
  ];
  if (p.radius && p.kind !== 'blackhole')
    metrics.unshift(
      ['Diameter', formatLength(p.radius * 2, unitMode)],
      [
        'Diameter compared with Earth',
        `${(p.radius / EARTH_RADIUS).toFixed(2)} ×`,
      ],
      ['Mass', `${p.mass.toExponential(3)} kg`],
    );
  if (p.kind === 'blackhole')
    metrics.unshift(
      ['Black-hole mass', '≈ 4 million solar masses'],
      ['Horizon radius', formatLength(RS, unitMode, 1)],
      ['Virtual camera radius', `${state.bhRadius.toFixed(2)} rₛ`],
      [
        `Tidal difference across ${formatLength(0.002, unitMode, 6)}`,
        formatAcceleration(tidal(state.bhRadius * RS) / 1000, unitMode),
      ],
    );
  $('#details-content').innerHTML =
    `<p>${p.description}</p><dl>${metrics.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}${detailFacts(
      p.id,
      unitMode,
    )
      .map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`)
      .join(
        '',
      )}</dl><p class="note">${p.id === 'moon' ? `Mean Earth–Moon distance: ${formatLength(384400, unitMode)}. The lunar position is a mean-distance illustration, not a dated ephemeris.` : p.note}</p><p class="note">Earth distance is straight-line displacement from Earth's center, rounded in the selected units in the instrument. Tour distance follows the authored route. Inspection changes neither value. Virtual speed is the route-distance derivative. Facts and approximate model values: see the linked source and source limitations.${` <a href="${OBSERVATION_FACTS[p.id].source}" target="_blank" rel="noreferrer">NASA · ${p.name} reference</a>`}</p><p class="note">Distances and visibility are rescaled in the visuals. Warp streaks illustrate compressed travel, not an actual faster-than-light spacecraft. Reference positions are approximations, not Horizons vectors. Parker comparisons hold its record speed constant without acceleration or braking.</p>${p.kind === 'blackhole' ? '<p class="note">The bright ring is illustrative. Optical framing is independent of the scientific observation radius; spin and relativistic orbital evolution are omitted. The descent and dark interior are illustrative, not a survival or geodesic simulation; the radius is not a measured local velocity.</p>' : ''}`;
}
function isWebglActive() {
  return Boolean(renderer && !renderer.contextLost && !renderer.fallbackPinned);
}
function updateUI() {
  const s = state,
    p = CHECKPOINTS[s.now],
    flying = s.playback !== 'observing',
    complete = s.playback === 'complete',
    descent = s.sequence === 'descent',
    webgl = isWebglActive();
  document.body.dataset.checkpoint = p.id;
  document.body.dataset.phase = s.phase;
  document.body.dataset.playback = s.playback;
  document.body.classList.add('timed-journey');
  document.body.classList.toggle('in-flight', flying);
  document.documentElement.dataset.kind = p.kind;
  document.documentElement.dataset.motion = s.reducedMotion
    ? 'reduced'
    : 'full';
  document.documentElement.dataset.motionMode = s.motionMode;
  document.documentElement.classList.toggle('has-webgl', webgl);
  document.documentElement.classList.toggle(
    'no-webgl',
    renderer !== undefined && !webgl,
  );
  document.documentElement.style.setProperty('--accent', p.color);
  document.documentElement.style.setProperty('--fallback-color', p.color);
  for (const el of [
    $('.masthead'),
    $('.flight-panel'),
    $('#timed-navigation'),
  ]) {
    el.hidden = flying;
    el.inert = flying;
  }
  $('#rail').hidden = complete;
  $('#rail').inert = complete;
  $('#inspection').hidden = complete;
  $('#inspection').inert = flying || !webgl;
  $('#inspection').setAttribute('aria-disabled', String(flying || !webgl));
  $('#location').textContent = p.name;
  $('#description').textContent = summary(p);
  const key = `${s.now}:${unitMode}`;
  if ($('#observation-facts').dataset.stop !== key) {
    $('#observation-facts').dataset.stop = key;
    $('#observation-facts').innerHTML = observationFacts(p.id, unitMode)
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join('');
  }
  $<HTMLButtonElement>('#previous').disabled = s.now === 0;
  $('#previous').innerHTML =
    `<span class="nav-direction"><svg viewBox="0 0 24 12" aria-hidden="true"><path d="M23 6H2m5-5L2 6l5 5"/></svg> Previous</span><span>${s.now ? CHECKPOINTS[s.now - 1].name : 'Earth'}</span>`;
  const atEnd = s.now === CHECKPOINTS.length - 1;
  $('#previous').setAttribute(
    'aria-label',
    `Previous · ${s.now ? CHECKPOINTS[s.now - 1].name : 'Earth'}`,
  );
  $('#next').setAttribute(
    'aria-label',
    atEnd ? 'Enter the event horizon' : `Next · ${CHECKPOINTS[s.now + 1].name}`,
  );
  $('#next').dataset.action = atEnd ? 'enter' : 'next';
  $('#next').innerHTML =
    `<span class="nav-direction">${atEnd ? 'Continue' : 'Next'} <svg viewBox="0 0 24 12" aria-hidden="true"><path d="M1 6h21m-5-5 5 5-5 5"/></svg></span><span>${atEnd ? 'Enter the event horizon' : CHECKPOINTS[s.now + 1].name}</span>`;
  $('#playback-controls').hidden = !flying || complete;
  $('#pause-flight').textContent = s.playback === 'paused' ? 'Resume' : 'Pause';
  $('#skip-flight').textContent = descent ? 'Finish descent' : 'Skip flight';
  $('#skip-flight').setAttribute(
    'aria-description',
    descent
      ? 'Finish the illustrative descent'
      : `Skip flight to ${CHECKPOINTS[s.next].name}`,
  );
  $('#timed-instruments').hidden = complete;
  $('#speedometer').hidden = !flying || descent;
  $('#descent-instrument').hidden = !descent || complete;
  $('#earth-distance').hidden = descent;
  const earth = earthDistance(s.earthKm, unitMode);
  $('#earth-miles').textContent = earth.distance;
  $('#earth-context').textContent = earth.context;
  $('#au-help-toggle').hidden = !earth.context.includes('AU');
  if ($('#au-help-toggle').hidden) {
    const restoreFocus = document.activeElement === $('#au-help-toggle');
    closeAuHelp(false);
    if (restoreFocus)
      (flying ? $('#pause-flight') : $('#settings-toggle')).focus();
  }
  $('#au-help').textContent =
    `An astronomical unit (AU) is approximately the average Earth–Sun distance: ${formatLength(AU, unitMode)}.`;
  $('#speed-unit').textContent = speedUnit(unitMode);
  digits.update(
    speedValue(s.speedKmS, unitMode),
    s.playback !== 'flying',
    s.reducedMotion,
    performance.now(),
    unitMode === 'miles' ? 'miles per hour' : 'kilometres per hour',
  );
  const clampedThrust = Math.max(0, Math.min(1, s.thrust));
  $('#speedometer').style.setProperty(
    '--speed-color',
    speedColor(clampedThrust),
  );
  $('#speed-needle').style.transform = `rotate(${180 * clampedThrust}deg)`;
  $('#speed-arc').setAttribute(
    'stroke-dashoffset',
    String(100 * (1 - clampedThrust)),
  );
  $('#horizon-radius').textContent =
    s.bhRadius <= 1
      ? 'Inside the horizon'
      : formatLength((s.bhRadius - 1) * RS, unitMode);
  $('#ending').hidden = !complete;
  $('#final-stats').textContent =
    `${formatLength(TOTAL, unitMode)} through ${CHECKPOINTS.length} stops; ${PLAYBACK_SECONDS} seconds of forward route playback, plus 20 seconds of optional descent. ${duration(travelTime(TOTAL))} light-equivalent route time.`;
  if (selected !== s.now) {
    selected = s.now;
    for (const [i, el] of routeStopButtons.entries())
      el.setAttribute('aria-current', i === s.now ? 'step' : 'false');
    if (!flying) revealCurrentStop(s.now);
  }
  updateRouteTraveler(s);
  if ($<HTMLDialogElement>('#details').open) updateDetails();
  const lost = renderer?.contextLost && !renderer.fallbackPinned;
  $('#context-actions').hidden = !lost;
  $('#render-status').textContent = lost
    ? 'Graphics context lost · Journey paused. Restore 3D view or continue with static illustration.'
    : renderer === null || renderer?.fallbackPinned
      ? 'Static illustration · 3D inspection unavailable.'
      : renderer?.textureFailures
        ? 'Some imagery unavailable · illustrated surfaces remain active.'
        : renderer?.pendingTextures
          ? 'Loading planetary imagery…'
          : '';
}
function speedColor(thrust: number) {
  const stops: [number, [number, number, number]][] = [
    [0, [46, 232, 154]],
    [0.42, [245, 200, 66]],
    [0.74, [255, 122, 41]],
    [1, [255, 51, 75]],
  ];
  const t = Math.max(0, Math.min(1, thrust));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i],
      [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / Math.max(1e-6, t1 - t0);
      const rgb = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
      return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }
  }
  return 'rgb(255, 51, 75)';
}
function stopCenter(index: number) {
  const btn = routeStopButtons[index];
  return btn ? btn.offsetLeft + btn.offsetWidth / 2 : 0;
}
function updateRouteTraveler(s: TimedFrame) {
  const startBtn = routeStopButtons[s.now];
  if (!startBtn || s.playback === 'complete') return;
  const earthX = stopCenter(0);
  const startX = stopCenter(s.now);
  const endX = routeStopButtons[s.next] ? stopCenter(s.next) : startX;
  const active = s.playback !== 'observing' && s.sequence === 'route';
  const currentX = active ? startX + (endX - startX) * s.legProgress : startX;
  routeProgressFill.style.left = `${earthX}px`;
  routeProgressFill.style.width = `${Math.max(0, currentX - earthX)}px`;
  for (let i = 0; i < routeStopButtons.length; i++) {
    routeStopButtons[i].dataset.visited = String(stopCenter(i) < currentX - 1);
  }
  if (active) {
    routeTraveler.dataset.active = 'true';
    routeTraveler.style.transform = `translateX(${currentX}px) translate(-50%, -50%) scaleX(${s.direction < 0 ? -1 : 1})`;
    const scroll = $('#route-scroll');
    if (
      scroll.scrollWidth > scroll.clientWidth &&
      (currentX < scroll.scrollLeft + 44 ||
        currentX > scroll.scrollLeft + scroll.clientWidth - 44)
    ) {
      scroll.scrollLeft = Math.max(0, currentX - scroll.clientWidth / 2);
    }
  } else {
    routeTraveler.dataset.active = 'false';
    routeTraveler.style.transform = `translateX(${currentX}px) translate(-50%, -50%)`;
  }
}
function revealCurrentStop(index: number) {
  requestAnimationFrame(() => {
    routeStopButtons[index]?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: 'instant',
    });
    updateRouteTraveler(state);
  });
}
function handlePlaybackTransition(
  previousPlayback: TimedFrame['playback'],
  nextPlayback: TimedFrame['playback'],
) {
  if (previousPlayback !== 'observing' && nextPlayback === 'observing') {
    const hash = `#${CHECKPOINTS[state.now].id}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
    updateUI();
    $('#next').focus();
    $('#journey-announcement').textContent =
      `Arrived at ${CHECKPOINTS[state.now].name}.`;
  }
  if (previousPlayback !== 'complete' && nextPlayback === 'complete') {
    updateUI();
    $('#replay').focus();
    $('#journey-announcement').textContent =
      'Journey complete. Return to Earth to replay.';
  }
}
let lastPhase = '';
let frameId: number;
function frame() {
  frameId = requestAnimationFrame(frame);
  const now = performance.now(),
    dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (!visible) return;
  if (controller.snapshot().playback !== 'paused') time += dt;
  const previousPlayback = state.playback;
  state = controller.tick(now);
  handlePlaybackTransition(previousPlayback, state.playback);
  renderer?.render(state, time);
  audio.update(state as TimedFrame);
  const uiInterval =
    state.playback === 'flying' && !state.reducedMotion ? 33 : 70;
  if (
    state.now !== selected ||
    state.phase !== lastPhase ||
    now - uiAt >= uiInterval
  ) {
    updateUI();
    uiAt = now;
    lastPhase = state.phase;
  } else if (state.playback === 'flying') {
    updateRouteTraveler(state);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) controller.pause(performance.now());
  visible = !document.hidden;
  audio.setHidden(document.hidden);
  clearInspection();
  wheel.reset();
  last = performance.now();
  renderer?.resetTiming();
  state = controller.snapshot();
  updateUI();
});
window.addEventListener('resize', () => {
  renderer?.resize();
  updateUI();
  if (state.playback === 'observing') revealCurrentStop(state.now);
  if (previewIndex >= 0 && !$('#route-preview').hidden)
    positionPreview(previewIndex);
  renderer?.render(state, time);
});
window.addEventListener('pagehide', (event) => {
  // A persisted page may be restored from the back/forward cache; keep it alive.
  if (event.persisted) return;
  disposed = true;
  cancelAnimationFrame(frameId);
  audio.dispose();
  renderer?.dispose();
});
controller.observe(resolveStop(location.hash.slice(1)));
state = controller.snapshot();
history.replaceState(null, '', `#${CHECKPOINTS[state.now].id}`);
updateUI();
declare global {
  interface Window {
    __horizon?: {
      frames: () => number;
      state: () => FlightState;
      textureFailures: () => number;
      visible: () => boolean;
      axis: () => ReturnType<typeof distanceAxis>;
      render: () => JourneyRenderer['diagnostics'] | undefined;
      audio: () => ReturnType<AudioEngine['diagnostics']>;
      motion: () => { mode: MotionMode; reduced: boolean };
      loseContext: () => void;
      restoreContext: () => void;
      setQuality: (scale: number) => void;
    };
  }
}
window.__horizon = {
  frames: () => renderer?.frames ?? 0,
  state: () => state,
  textureFailures: () => renderer?.textureFailures ?? 0,
  visible: () => visible,
  axis: () => axisModel,
  render: () => renderer?.diagnostics,
  audio: () => audio.diagnostics(),
  motion: () => ({
    mode: controller.currentMotionMode,
    reduced: controller.reducedMotion,
  }),
  loseContext: () => renderer?.loseContext(),
  restoreContext: () => renderer?.restoreContext(),
  setQuality: (scale: number) => renderer?.setQuality(scale),
};

async function initializeRenderer() {
  const module = await import('./renderer').catch(() => null);
  if (disposed) return;
  const graphics =
    module?.JourneyRenderer.create($<HTMLCanvasElement>('#universe')) ?? null;
  renderer = graphics;
  if (!graphics) {
    updateUI();
    return;
  }
  graphics.onStatusChange = () => updateUI();
  graphics.onContextLost = () => {
    controller.pause(performance.now());
    clearInspection();
    wheel.reset();
    state = controller.snapshot();
    updateUI();
    $('#journey-announcement').textContent =
      'Graphics context lost. Journey paused. Restore 3D view or continue with static illustration.';
  };
  graphics.onContextRestored = () => {
    state = controller.snapshot();
    updateUI();
    graphics.render(state, time);
    $('#journey-announcement').textContent = '3D view restored.';
  };
  graphics.render(state, time);
  updateUI();
}
$('#restore-webgl').addEventListener('click', () => {
  renderer?.restoreContext();
});
$('#continue-fallback').addEventListener('click', () => {
  renderer?.useStaticFallback();
  updateUI();
  $('#journey-announcement').textContent =
    'Continuing with static illustration.';
});
function applyMotionPreference(mode: MotionMode, persist: boolean) {
  if (persist) writeMotionMode(mode);
  controller.setMotionMode(mode, reducedQuery.matches);
  motionSelect.value = mode;
  state = controller.snapshot();
  updateUI();
  renderer?.render(state, time);
  audio.update(state);
}
motionSelect.addEventListener('change', () => {
  const mode = motionSelect.value as MotionMode;
  applyMotionPreference(mode, true);
  $('#journey-announcement').textContent =
    `Motion preference set to ${mode} (${controller.reducedMotion ? 'reduced motion' : 'full motion'}).`;
});
reducedQuery.addEventListener('change', () => {
  controller.setSystemReducedMotion(reducedQuery.matches);
  state = controller.snapshot();
  updateUI();
  renderer?.render(state, time);
  audio.update(state);
});

const soundToggle = $<HTMLButtonElement>('#sound-toggle');
function updateSound() {
  const status = audio.status;
  soundToggle.hidden = !audio.available;
  soundToggle.dataset.state = status;
  soundToggle.setAttribute('aria-pressed', String(status !== 'off'));
  $('#sound-label').textContent =
    status === 'off'
      ? 'Sound off'
      : status === 'on'
        ? 'Sound on'
        : 'Sound on · tap to allow';
}
audio.onchange = updateSound;
soundToggle.addEventListener('click', () => {
  // A click on a blocked "on" state is the gesture that lets playback resume.
  void audio
    .set(audio.status === 'blocked' ? true : !audio.preference)
    .then(() => {
      $('#journey-announcement').textContent = audio.preference
        ? 'Sound on.'
        : 'Sound off.';
    });
});
updateSound();

function flyToStop(index: number) {
  if (
    document.body.classList.contains('direct-navigation') ||
    document.querySelector('dialog[open]')
  )
    return;
  clearInspection();
  closePreview();
  if (controller.flyTo(performance.now(), index)) {
    wheel.reset();
    state = controller.snapshot();
    updateUI();
    $('#pause-flight').focus();
    $('#journey-announcement').textContent =
      `Flying to ${CHECKPOINTS[state.next].name}.`;
  }
}
function launch(direction: number) {
  if (
    document.body.classList.contains('direct-navigation') ||
    document.querySelector('dialog[open]')
  )
    return;
  const s = controller.snapshot();
  if (s.playback !== 'observing') return;
  clearInspection();
  closePreview();
  if (controller.launch(performance.now(), direction)) {
    wheel.reset();
    state = controller.snapshot();
    updateUI();
    $('#pause-flight').focus();
    $('#journey-announcement').textContent =
      `Flying to ${CHECKPOINTS[state.next].name}.`;
  }
}
function enterHorizon() {
  clearInspection();
  if (controller.enterHorizon(performance.now())) {
    wheel.reset();
    state = controller.snapshot();
    updateUI();
    $('#pause-flight').focus();
    $('#journey-announcement').textContent =
      'Horizon approach started. Illustrative twenty-second descent.';
  }
}
$('#next').addEventListener('click', () =>
  $('#next').dataset.action === 'enter' ? enterHorizon() : launch(1),
);
$('#previous').addEventListener('click', () => launch(-1));
$('#pause-flight').addEventListener('click', () => {
  if (controller.snapshot().playback === 'paused')
    controller.resume(performance.now());
  else controller.pause(performance.now());
  state = controller.snapshot();
  updateUI();
  $('#journey-announcement').textContent =
    (state as TimedFrame).playback === 'paused'
      ? 'Flight paused.'
      : 'Flight resumed.';
});
$('#skip-flight').addEventListener('click', () => {
  const previousPlayback = state.playback;
  controller.skip();
  wheel.reset();
  state = controller.snapshot();
  handlePlaybackTransition(previousPlayback, state.playback);
  renderer?.render(state, time);
  audio.update(state);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#preference-controls').hidden) {
      closeSettings();
      return;
    }
    if (!$('#au-help').hidden) {
      closeAuHelp();
      return;
    }
    if (!$('#route-preview').hidden) {
      closePreview(true);
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    const wasFlying = controller.snapshot().playback === 'flying';
    controller.pause(performance.now());
    state = controller.snapshot();
    updateUI();
    if (wasFlying && state.playback === 'paused') {
      $('#journey-announcement').textContent = 'Flight paused.';
    }
  }
});
document.addEventListener(
  'wheel',
  (e) => {
    const excluded = (e.target as HTMLElement).closest(
      'button,select,a,input,textarea,[contenteditable],dialog,#rail,#settings,#au-help',
    );
    if (
      excluded ||
      document.querySelector('dialog[open]') ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.altKey ||
      Math.abs(e.deltaX) >= Math.abs(e.deltaY)
    ) {
      wheel.feed(0, performance.now(), false);
      return;
    }
    e.preventDefault();
    const delta =
      e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    const direction = wheel.feed(
      delta,
      performance.now(),
      controller.snapshot().playback === 'observing',
    );
    if (direction) launch(direction);
  },
  { passive: false, capture: true },
);

frameId = requestAnimationFrame(frame);
void initializeRenderer();
