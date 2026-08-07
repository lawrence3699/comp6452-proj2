'use strict';

document.documentElement.classList.add('js');

const SCENES = Object.freeze([
  { number: '01', name: 'Team', duration: 6200 },
  { number: '02', name: 'Yan · Registry', duration: 7600 },
  { number: '03', name: 'Hu · Compliance', duration: 8000 },
  { number: '04', name: 'Lin · Off-chain', duration: 7600 },
  { number: '05', name: 'Huang · Network', duration: 7600 },
  { number: '06', name: 'Integration', duration: 7200 },
  { number: '07', name: 'Evidence', duration: 7000 },
]);

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const reelApp = document.getElementById('reel-app');
const viewport = document.getElementById('reel-viewport');
const track = document.getElementById('reel-track');
const sceneElements = [...document.querySelectorAll('.reel-scene')];
const sceneNumber = document.getElementById('scene-number');
const sceneName = document.getElementById('scene-name');
const sceneTabs = document.getElementById('scene-tabs');
const timelineProgress = document.getElementById('scene-timeline-progress');
const previousButton = document.getElementById('previous-scene');
const nextButton = document.getElementById('next-scene');
const playButton = document.getElementById('play-scene');
const fullscreenButton = document.getElementById('fullscreen-button');
const proofCounter = document.getElementById('proof-counter');

const state = {
  position: 0,
  target: 0,
  velocity: 0,
  index: 0,
  elapsed: 0,
  playing: !reduceMotion.matches,
  dragging: false,
  dragWasPlaying: false,
  lastFrame: performance.now(),
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const rubberband = (overshoot, dimension, constant = 0.55) =>
  (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));

const project = (velocity, decelerationRate = 0.998) =>
  (velocity / 1000) * decelerationRate / (1 - decelerationRate);

SCENES.forEach((scene, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scene-tab';
  button.textContent = scene.name;
  button.setAttribute('aria-label', `Show scene ${scene.number}: ${scene.name}`);
  button.addEventListener('click', () => goToScene(index));
  sceneTabs.append(button);
});

const updatePlayButton = () => {
  playButton.setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
  playButton.querySelector('span').textContent = state.playing ? 'Ⅱ' : '▶';
  playButton.querySelector('strong').textContent = state.playing ? 'Pause' : 'Play';
  reelApp.classList.toggle('is-paused', !state.playing);
};

const activateScene = (index) => {
  sceneElements.forEach((scene, sceneIndex) => {
    const active = sceneIndex === index;
    scene.classList.remove('is-active');
    scene.setAttribute('aria-hidden', String(!active));
    // Force a style boundary so every micro-animation restarts from frame zero.
    if (active) void scene.offsetWidth;
    if (active) scene.classList.add('is-active');
  });

  [...sceneTabs.children].forEach((tab, tabIndex) => {
    if (tabIndex === index) tab.setAttribute('aria-current', 'step');
    else tab.removeAttribute('aria-current');
  });

  sceneNumber.textContent = SCENES[index].number;
  sceneName.textContent = SCENES[index].name;
  if (index === SCENES.length - 1) {
    proofCounter.textContent = state.playing && !reduceMotion.matches ? '0' : '336';
  }
};

function goToScene(index, { preserveVelocity = true } = {}) {
  const next = clamp(index, 0, SCENES.length - 1);
  state.index = next;
  state.target = next;
  state.elapsed = 0;
  if (!preserveVelocity) state.velocity = 0;
  if (reduceMotion.matches) state.position = next;
  activateScene(next);
}

const togglePlayback = () => {
  state.playing = !state.playing;
  updatePlayButton();
};

previousButton.addEventListener('click', () => goToScene((state.index - 1 + SCENES.length) % SCENES.length));
nextButton.addEventListener('click', () => goToScene((state.index + 1) % SCENES.length));
playButton.addEventListener('click', togglePlayback);

fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    goToScene(0, { preserveVelocity: false });
  }
});

let dragStartX = 0;
let dragStartPosition = 0;
let dragSamples = [];

viewport.addEventListener('pointerdown', (event) => {
  if (event.target.closest('a, button')) return;
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('is-dragging');
  state.dragging = true;
  state.dragWasPlaying = state.playing;
  state.playing = false;
  updatePlayButton();
  dragStartX = event.clientX;
  dragStartPosition = state.position;
  dragSamples = [{ x: event.clientX, time: performance.now() }];
});

viewport.addEventListener('pointermove', (event) => {
  if (!state.dragging) return;
  const width = Math.max(window.innerWidth, 1);
  let next = dragStartPosition - (event.clientX - dragStartX) / width;
  if (next < 0) next = rubberband(next, 1);
  if (next > SCENES.length - 1) {
    next = SCENES.length - 1 + rubberband(next - (SCENES.length - 1), 1);
  }
  state.position = next;
  state.target = next;
  const now = performance.now();
  dragSamples.push({ x: event.clientX, time: now });
  dragSamples = dragSamples.filter((sample) => now - sample.time <= 100);
});

const finishDrag = (event) => {
  if (!state.dragging) return;
  state.dragging = false;
  viewport.classList.remove('is-dragging');
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);

  const first = dragSamples[0];
  const last = dragSamples[dragSamples.length - 1];
  const elapsed = first && last ? Math.max(last.time - first.time, 1) : 1;
  const pointerVelocity = first && last ? ((last.x - first.x) / elapsed) * 1000 : 0;
  const sceneVelocity = -pointerVelocity / Math.max(window.innerWidth, 1);
  const projected = state.position + project(sceneVelocity);
  const target = clamp(Math.round(projected), 0, SCENES.length - 1);
  state.velocity = sceneVelocity;
  state.playing = state.dragWasPlaying;
  updatePlayButton();
  goToScene(target);
};

viewport.addEventListener('pointerup', finishDrag);
viewport.addEventListener('pointercancel', finishDrag);

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') goToScene((state.index - 1 + SCENES.length) % SCENES.length);
  else if (event.key === 'ArrowRight') goToScene((state.index + 1) % SCENES.length);
  else if (event.key === ' ' && !event.repeat) {
    event.preventDefault();
    togglePlayback();
  } else if (event.key.toLowerCase() === 'f') {
    fullscreenButton.click();
  }
});

const render = (now) => {
  const deltaMs = Math.min(now - state.lastFrame, 32);
  const deltaSeconds = deltaMs / 1000;
  state.lastFrame = now;

  if (!state.dragging) {
    if (reduceMotion.matches) {
      state.position = state.target;
      state.velocity = 0;
    } else {
      // Critically damped, velocity-aware spring. Re-targeting keeps live velocity.
      const response = 0.44;
      const omega = (2 * Math.PI) / response;
      const stiffness = omega * omega;
      const damping = 2 * omega;
      const acceleration = -stiffness * (state.position - state.target) - damping * state.velocity;
      state.velocity += acceleration * deltaSeconds;
      state.position += state.velocity * deltaSeconds;
      if (Math.abs(state.position - state.target) < 0.0005 && Math.abs(state.velocity) < 0.003) {
        state.position = state.target;
        state.velocity = 0;
      }
    }
  }

  track.style.transform = `translate3d(${-state.position * window.innerWidth}px, 0, 0)`;

  const settled = Math.abs(state.position - state.target) < 0.015;
  if (state.playing && settled && !document.hidden) {
    state.elapsed += deltaMs;
    const duration = SCENES[state.index].duration;
    if (state.elapsed >= duration) {
      const next = state.index === SCENES.length - 1 ? 0 : state.index + 1;
      goToScene(next);
    }
  }

  const duration = SCENES[state.index].duration;
  const progress = clamp(state.elapsed / duration, 0, 1);
  timelineProgress.style.transform = `scaleX(${progress})`;

  if (state.index === SCENES.length - 1) {
    const counterProgress = clamp(state.elapsed / 1200, 0, 1);
    const eased = 1 - Math.pow(1 - counterProgress, 3);
    proofCounter.textContent = String(Math.round(336 * eased));
  }

  requestAnimationFrame(render);
};

document.addEventListener('visibilitychange', () => {
  state.lastFrame = performance.now();
});
window.addEventListener('resize', () => {
  track.style.transform = `translate3d(${-state.position * window.innerWidth}px, 0, 0)`;
});

activateScene(0);
updatePlayButton();
requestAnimationFrame(render);
