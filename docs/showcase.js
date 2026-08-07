'use strict';

document.documentElement.classList.add('js');

const DATA = Object.freeze({
  tests: [
    { name: 'batch-registry', count: 46 },
    { name: 'coldchain-compliance', count: 18 },
    { name: 'shared gateway', count: 20 },
    { name: 'storage', count: 34 },
    { name: 'oracle-service', count: 51 },
    { name: 'event indexer', count: 82 },
    { name: 'role applications', count: 85 },
  ],
  events: [
    { name: 'BatchRegistered', source: 'registry' },
    { name: 'CustodyTransferred', source: 'registry' },
    { name: 'BatchFlagged', source: 'registry' },
    { name: 'BatchDelivered', source: 'registry' },
    { name: 'BatchRecalled', source: 'registry' },
    { name: 'ComplianceBreach', source: 'compliance' },
    { name: 'RecallCascaded', source: 'compliance' },
  ],
});

const JOURNEYS = Object.freeze({
  incident: {
    title: 'Sustained risk becomes an automatic decision.',
    description:
      'The first window is safe. Three consecutive breaches then cause coldchain-compliance to invoke batch-registry:FlagBatch in the same atomic transaction. The regulator later recalls the batch.',
    badge: 'Oracle → FLAGGED → RECALLED',
    tone: 'incident',
    nodes: [
      { label: 'CREATED', detail: 'Producer · Org1MSP', mark: '01', tone: 'blue' },
      { label: 'IN_TRANSIT', detail: 'Holder · Org2MSP', mark: '02', tone: 'blue' },
      { label: 'FLAGGED', detail: '3 breach windows', mark: '!', tone: 'orange' },
      { label: 'RECALLED', detail: 'Terminal state', mark: '×', tone: 'red' },
    ],
  },
  clean: {
    title: 'A valid hand-off reaches a clean terminal state.',
    description:
      'Custody walks through the complete state machine. MarkDelivered is accepted only when the batch is AT_WAREHOUSE and the caller belongs to the current holder MSP.',
    badge: 'Holder verified · DELIVERED',
    tone: 'clean',
    nodes: [
      { label: 'CREATED', detail: 'Producer · Org1MSP', mark: '01', tone: 'blue' },
      { label: 'IN_TRANSIT', detail: 'Carrier accepted', mark: '02', tone: 'blue' },
      { label: 'AT_WAREHOUSE', detail: 'Receiving dock', mark: '03', tone: 'green' },
      { label: 'DELIVERED', detail: 'Terminal happy path', mark: '✓', tone: 'green' },
    ],
  },
});

const TEAM = Object.freeze([
  {
    member: 1,
    short: 'Yan',
    name: 'Chaoliang Yan',
    zid: 'z5643222',
    initials: 'CY',
    role: 'Registry owner',
    tags: ['state machine', 'ABAC', 'private data'],
    matrix: [1, 0, 0, 0, 0, 0, 0],
    components: ['Registry', 'PDC', 'Queries'],
    acts: ['01', '03'],
  },
  {
    member: 2,
    short: 'Hu',
    name: 'Zhaoheng Hu',
    zid: 'z5357529',
    initials: 'ZH',
    role: 'Compliance owner',
    tags: ['breach counter', 'FlagBatch call', 'BFS recall'],
    matrix: [0, 1, 0, 0, 0, 0, 0],
    components: ['Compliance', 'Counter', 'BFS recall'],
    acts: ['05', '07'],
  },
  {
    member: 3,
    short: 'Lin',
    name: 'Chi-Hsien Lin',
    zid: 'z5620437',
    initials: 'CL',
    role: 'Off-chain owner',
    tags: ['summarise()', 'tamper check', 'logic split'],
    matrix: [0, 0, 1, 1, 1, 0, 0],
    components: ['Aggregate', 'Storage', 'gateway.ts'],
    acts: ['01', '05', 'Live'],
  },
  {
    member: 4,
    short: 'Huang',
    name: 'Neier Huang',
    zid: 'z5400040',
    initials: 'NH',
    role: 'Client & network owner',
    tags: ['identity wiring', 'role CLIs', 'network scripts'],
    matrix: [0, 0, 0, 0, 0, 1, 1],
    components: ['connect.ts', 'Role CLIs', 'Network'],
    acts: ['01', '02', '04', '06'],
  },
]);

const INDEXER = 'http://127.0.0.1:3001';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const formatTimestamp = (seconds) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Ledger timestamp unavailable';
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(seconds * 1000));
};

const shortHash = (value, keep = 14) => {
  if (typeof value !== 'string') return '';
  return value.length > keep ? `${value.slice(0, keep)}…` : value;
};

// Appearance ---------------------------------------------------------------
const root = document.documentElement;
const themeButton = document.getElementById('theme-toggle');
const savedTheme = localStorage.getItem('coldchain-theme');
if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;

const resolvedDark = () =>
  root.dataset.theme === 'dark' ||
  (root.dataset.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

themeButton.addEventListener('click', () => {
  const next = resolvedDark() ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('coldchain-theme', next);
  themeButton.setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} appearance`);
});

document.getElementById('present-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Fullscreen availability differs for file:// pages and managed browsers.
    document.getElementById('overview').scrollIntoView({ block: 'start' });
  }
});

// Team ownership charts ----------------------------------------------------
const matrixColumns = ['Registry', 'Compliance', 'Aggregate', 'Storage', 'Logic split', 'Clients', 'Network'];
const matrixHost = document.getElementById('team-matrix');
const matrixTable = element('table', 'team-matrix-table');
const matrixCaption = element('caption', '', 'Lead responsibility by team member and project component');
const matrixHead = element('thead');
const matrixHeadRow = element('tr');
matrixHeadRow.append(element('th', '', 'Owner'));
matrixColumns.forEach((column) => matrixHeadRow.append(element('th', '', column)));
matrixHead.append(matrixHeadRow);
const matrixBody = element('tbody');

TEAM.forEach((person) => {
  const row = element('tr');
  row.dataset.member = String(person.member);
  const owner = element('th', '', person.short);
  owner.scope = 'row';
  row.append(owner);
  person.matrix.forEach((value, index) => {
    const cell = element('td', value ? 'is-lead' : '');
    cell.setAttribute('aria-label', `${person.name}: ${matrixColumns[index]} — ${value ? 'lead' : 'not assigned'}`);
    row.append(cell);
  });
  matrixBody.append(row);
});
matrixTable.append(matrixCaption, matrixHead, matrixBody);
matrixHost.append(matrixTable);

const teamCards = document.getElementById('team-cards');
TEAM.forEach((person) => {
  const card = element('article', 'team-member-card');
  card.dataset.member = String(person.member);
  const head = element('div', 'member-head');
  head.append(element('span', 'member-avatar', person.initials));
  const name = element('div', 'member-name');
  name.append(element('strong', '', person.name));
  name.append(element('span', '', person.zid));
  head.append(name);
  card.append(head);
  card.append(element('p', 'member-role', person.role));
  const tags = element('div', 'member-tags');
  person.tags.forEach((tag) => tags.append(element('span', '', tag)));
  card.append(tags);
  const output = element('div', 'member-output-bar');
  person.matrix.forEach((value) => output.append(element('i', value ? 'is-owned' : '')));
  card.append(output);
  teamCards.append(card);
});

const handoffChart = document.getElementById('handoff-chart');
TEAM.forEach((person) => {
  const lane = element('div', 'handoff-lane');
  lane.dataset.member = String(person.member);
  const owner = element('div', 'handoff-person');
  owner.append(element('i'));
  owner.append(element('span', '', person.short));
  const components = element('div', 'handoff-components');
  person.components.forEach((component) => components.append(element('span', '', component)));
  const acts = element('div', 'handoff-acts');
  person.acts.forEach((act) => acts.append(element('span', '', act)));
  lane.append(owner, element('span', 'handoff-arrow'), components, element('span', 'handoff-arrow'), acts);
  handoffChart.append(lane);
});

// Animated collaboration walkthrough --------------------------------------
const FLOW_STEPS = Object.freeze([
  {
    number: '01',
    title: 'Signed registration',
    copy: 'Identity → ABAC → private data',
    owner: 'Huang → Yan',
    source: 'client',
    target: 'registry',
    path: 'client-registry',
    state: 'CREATED',
    coreClass: 'is-updated',
  },
  {
    number: '02',
    title: 'Aggregate & anchor',
    copy: 'summarise() → store → re-hash',
    owner: 'Lin → Hu',
    source: 'offchain',
    target: 'compliance',
    path: 'offchain-compliance',
    state: 'EVIDENCE',
    coreClass: 'is-updated',
  },
  {
    number: '03',
    title: 'Count consecutive breaches',
    copy: '1 → 2 → 3',
    owner: 'Hu',
    source: 'compliance',
    target: 'compliance',
    path: null,
    state: 'BREACH ×3',
    coreClass: 'is-updated',
  },
  {
    number: '04',
    title: 'Cross-chaincode flag',
    copy: 'coldchain-compliance → FlagBatch()',
    owner: 'Hu → Yan',
    source: 'compliance',
    target: 'registry',
    path: 'compliance-registry',
    state: 'FLAGGED',
    coreClass: 'is-updated',
  },
  {
    number: '05',
    title: 'Cycle-safe recall',
    copy: 'BFS + visited set',
    owner: 'Hu',
    source: 'compliance',
    target: 'core',
    path: 'compliance-core',
    state: 'RECALLED',
    coreClass: 'is-recall',
  },
  {
    number: '06',
    title: 'Test every boundary',
    copy: 'Unit tests → Fabric E2E → CI',
    owner: 'All four',
    source: 'all',
    target: 'all',
    path: null,
    state: 'TESTED',
    coreClass: 'is-tested',
  },
]);

const collaborationStage = document.getElementById('collaboration-stage');
const flowPacket = document.getElementById('flow-packet');
const flowCore = document.getElementById('flow-core');
const flowCoreState = document.getElementById('flow-core-state');
const flowCaptionNumber = document.getElementById('flow-caption-number');
const flowCaptionTitle = document.getElementById('flow-caption-title');
const flowCaptionCopy = document.getElementById('flow-caption-copy');
const flowCaptionOwner = document.getElementById('flow-caption-owner');
const flowStepper = document.getElementById('flow-stepper');
const flowPlay = document.getElementById('flow-play');
const flowPrevious = document.getElementById('flow-previous');
const flowNext = document.getElementById('flow-next');

const flowMotion = {
  index: 0,
  playing: !reduceMotion.matches,
  visible: false,
  frame: 0,
  timer: 0,
};

FLOW_STEPS.forEach((step, index) => {
  const button = element('button', 'flow-step-button', step.number);
  button.type = 'button';
  button.setAttribute('aria-label', `Show step ${step.number}: ${step.title}`);
  button.addEventListener('click', () => activateFlowStep(index));
  flowStepper.append(button);
});

const cancelFlowMotion = () => {
  if (flowMotion.frame) cancelAnimationFrame(flowMotion.frame);
  if (flowMotion.timer) clearTimeout(flowMotion.timer);
  flowMotion.frame = 0;
  flowMotion.timer = 0;
};

const scheduleNextFlowStep = (delay = 1700) => {
  if (!flowMotion.playing || !flowMotion.visible || document.hidden) return;
  flowMotion.timer = window.setTimeout(
    () => activateFlowStep((flowMotion.index + 1) % FLOW_STEPS.length),
    delay,
  );
};

const animateFlowPacket = (path, done) => {
  const length = path.getTotalLength();
  let progress = 0;
  let velocity = 0;
  let lastTime = performance.now();
  flowPacket.classList.add('is-visible');

  if (reduceMotion.matches) {
    const point = path.getPointAtLength(length);
    flowPacket.setAttribute('cx', String(point.x));
    flowPacket.setAttribute('cy', String(point.y));
    done();
    return;
  }

  // Critically damped scalar spring: interruptible and presentation-value based.
  const response = 0.52;
  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const damping = 2 * omega;

  const tick = (now) => {
    const dt = Math.min((now - lastTime) / 1000, 0.032);
    lastTime = now;
    const acceleration = -stiffness * (progress - 1) - damping * velocity;
    velocity += acceleration * dt;
    progress += velocity * dt;
    const safeProgress = Math.max(0, Math.min(1, progress));
    const point = path.getPointAtLength(length * safeProgress);
    flowPacket.setAttribute('cx', String(point.x));
    flowPacket.setAttribute('cy', String(point.y));

    if (Math.abs(progress - 1) < 0.003 && Math.abs(velocity) < 0.02) {
      flowMotion.frame = 0;
      done();
      return;
    }
    flowMotion.frame = requestAnimationFrame(tick);
  };
  flowMotion.frame = requestAnimationFrame(tick);
};

function activateFlowStep(index) {
  cancelFlowMotion();
  const safeIndex = (index + FLOW_STEPS.length) % FLOW_STEPS.length;
  const step = FLOW_STEPS[safeIndex];
  flowMotion.index = safeIndex;
  collaborationStage.dataset.step = String(safeIndex);

  document.querySelectorAll('.flow-step-button').forEach((button, buttonIndex) => {
    if (buttonIndex === safeIndex) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });

  document.querySelectorAll('[data-flow-node]').forEach((node) => {
    node.classList.remove('is-active', 'is-source');
    if (step.source === 'all' || node.dataset.flowNode === step.source || node.dataset.flowNode === step.target) {
      node.classList.add('is-active');
    }
    if (node.dataset.flowNode === step.source) node.classList.add('is-source');
  });

  document.querySelectorAll('[data-flow-path]').forEach((path) => path.classList.remove('is-active'));
  flowPacket.classList.remove('is-visible');
  flowCore.classList.remove('is-updated', 'is-recall', 'is-tested');
  flowCore.classList.add(step.coreClass);
  flowCoreState.textContent = step.state;
  flowCaptionNumber.textContent = step.number;
  flowCaptionTitle.textContent = step.title;
  flowCaptionCopy.textContent = step.copy;
  flowCaptionOwner.textContent = step.owner;

  if (step.path) {
    const path = document.querySelector(`[data-flow-path="${step.path}"]`);
    path.classList.add('is-active');
    animateFlowPacket(path, () => scheduleNextFlowStep(1300));
  } else {
    scheduleNextFlowStep(2300);
  }
}

const updateFlowPlayButton = () => {
  flowPlay.setAttribute('aria-label', flowMotion.playing ? 'Pause animation' : 'Play animation');
  flowPlay.querySelector('span:first-child').textContent = flowMotion.playing ? 'Ⅱ' : '▶';
  flowPlay.querySelector('.flow-play-label').textContent = flowMotion.playing ? 'Pause' : 'Play';
};

flowPlay.addEventListener('click', () => {
  flowMotion.playing = !flowMotion.playing;
  updateFlowPlayButton();
  if (flowMotion.playing) activateFlowStep(flowMotion.index);
  else cancelFlowMotion();
});
flowPrevious.addEventListener('click', () => activateFlowStep(flowMotion.index - 1));
flowNext.addEventListener('click', () => activateFlowStep(flowMotion.index + 1));

if ('IntersectionObserver' in window) {
  const flowObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    flowMotion.visible = entry?.isIntersecting === true;
    if (flowMotion.visible) activateFlowStep(flowMotion.index);
    else cancelFlowMotion();
  }, { threshold: 0.32 });
  flowObserver.observe(collaborationStage);
} else {
  flowMotion.visible = true;
  activateFlowStep(0);
}
updateFlowPlayButton();
activateFlowStep(0);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelFlowMotion();
  else if (flowMotion.visible && flowMotion.playing) activateFlowStep(flowMotion.index);
});

// Reveals ------------------------------------------------------------------
const revealNodes = [...document.querySelectorAll('.reveal')];
if (reduceMotion.matches || !('IntersectionObserver' in window)) {
  revealNodes.forEach((node) => node.classList.add('is-visible'));
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
  );
  revealNodes.forEach((node) => revealObserver.observe(node));
}

// Journey ------------------------------------------------------------------
const journeyStage = document.getElementById('journey-stage');
const journeyNodes = document.getElementById('journey-nodes');
const journeyExplanation = document.getElementById('journey-explanation');
let journeyAnimation;

const renderJourney = (name) => {
  const journey = JOURNEYS[name];
  if (!journey) return;

  journeyAnimation?.cancel();
  journeyStage.dataset.journey = name;
  journeyNodes.textContent = '';

  journey.nodes.forEach((item) => {
    const node = element('div', 'journey-node');
    node.dataset.tone = item.tone;
    node.append(element('span', 'journey-node-mark', item.mark));
    node.append(element('strong', '', item.label));
    node.append(element('small', '', item.detail));
    journeyNodes.append(node);
  });

  const copy = element('div');
  copy.append(element('h3', '', journey.title));
  copy.append(element('p', '', journey.description));
  const badge = element('span', `journey-badge${journey.tone === 'clean' ? ' clean' : ''}`, journey.badge);
  journeyExplanation.replaceChildren(copy, badge);

  document.querySelectorAll('[data-journey]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.setAttribute('aria-pressed', String(button.dataset.journey === name));
  });

  if (!reduceMotion.matches) {
    journeyAnimation = journeyStage.animate(
      [
        { opacity: 0.68, transform: 'translateY(5px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }
};

document.querySelectorAll('.segmented-control [data-journey]').forEach((button) => {
  button.addEventListener('click', () => renderJourney(button.dataset.journey));
});
renderJourney('incident');

// Engineering evidence -----------------------------------------------------
const testBars = document.getElementById('test-bars');
const maxTests = Math.max(...DATA.tests.map((item) => item.count));
DATA.tests.forEach((item) => {
  const row = element('div', 'test-bar-row');
  row.append(element('span', '', item.name));
  const track = element('div', 'test-bar-track');
  const fill = element('div', 'test-bar-fill');
  fill.style.setProperty('--bar-scale', String(item.count / maxTests));
  track.append(fill);
  row.append(track, element('strong', '', String(item.count)));
  testBars.append(row);
});

const eventList = document.getElementById('event-list');
DATA.events.forEach((item) => {
  const row = element('div', 'event-item');
  row.append(element('span', `event-source-dot${item.source === 'compliance' ? ' compliance' : ''}`));
  row.append(element('strong', '', item.name));
  row.append(element('span', '', '✓ indexed'));
  eventList.append(row);
});

// Clipboard ----------------------------------------------------------------
const toast = document.getElementById('toast');
let toastTimer;
const showToast = (message) => {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
    window.setTimeout(() => { toast.hidden = true; }, 220);
  }, 1700);
};

document.getElementById('copy-command').addEventListener('click', async () => {
  const command = 'cd application && ./showcase.sh';
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    const input = document.createElement('textarea');
    input.value = command;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  showToast('Demo command copied');
});

// Live indexer -------------------------------------------------------------
const navLive = document.getElementById('nav-live');
const navLiveLabel = document.getElementById('nav-live-label');
const livePanel = document.getElementById('live-panel');
const refreshButton = document.getElementById('refresh-button');
let liveRequest;
let latestBatches = [];

const fetchWithin = async (url, timeout = 1800) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
};

const batchEpoch = (id) => {
  const matches = id.match(/(\d{10})(?!.*\d)/);
  return matches ? Number(matches[1]) : 0;
};

const renderOffline = () => {
  navLive.dataset.state = 'offline';
  navLiveLabel.textContent = 'Indexer offline';
  const card = element('div', 'offline-panel');
  card.append(element('span', '', '○'));
  card.append(element('h3', '', 'Ready when the live demo starts.'));
  card.append(element('p', '', 'The showcase launcher starts a fresh indexer at the current block height, so old rehearsal batches never pollute this view.'));
  card.append(element('code', '', 'cd application && ./showcase.sh'));
  livePanel.replaceChildren(card);
};

const renderOnline = (health, batches, queryTime) => {
  navLive.dataset.state = 'online';
  navLiveLabel.textContent = 'Indexer live';

  const summary = element('div', 'live-summary');
  [
    { value: String(health.indexedEvents ?? 0), label: 'events indexed' },
    { value: String(health.batches ?? batches.length), label: 'batches projected' },
    { value: queryTime ? `${queryTime} ms` : '—', label: 'latest read latency' },
  ].forEach((item) => {
    const card = element('article');
    card.append(element('strong', '', item.value));
    card.append(element('span', '', item.label));
    summary.append(card);
  });

  const heading = element('div', 'batch-heading');
  heading.append(element('strong', '', 'Live batches'));
  heading.append(element('span', '', batches.length ? 'Select one to inspect its projected history' : 'Waiting for the first chaincode event'));

  const grid = element('div', 'batch-grid');
  batches.slice(0, 8).forEach((batchId) => {
    const button = element('button', 'batch-button');
    button.type = 'button';
    button.dataset.batchId = batchId;
    const copy = element('div');
    copy.append(element('strong', '', batchId));
    copy.append(element('small', '', batchId.includes('-OK') ? 'Clean delivery path' : 'Open indexed history'));
    button.append(copy, element('span', '', '›'));
    button.addEventListener('click', () => openBatchSheet(batchId, button));
    grid.append(button);
  });

  livePanel.replaceChildren(summary, heading, grid);
};

const refreshLive = async ({ quiet = false } = {}) => {
  if (liveRequest) liveRequest.abort();
  liveRequest = new AbortController();

  if (!quiet) {
    refreshButton.disabled = true;
    refreshButton.firstElementChild.textContent = '↻';
  }

  try {
    const [healthResponse, batchesResponse] = await Promise.all([
      fetchWithin(`${INDEXER}/health`),
      fetchWithin(`${INDEXER}/batches`),
    ]);
    if (!healthResponse.ok || !batchesResponse.ok) throw new Error('Indexer response was not successful');
    const [health, batchBody] = await Promise.all([healthResponse.json(), batchesResponse.json()]);
    const ids = Array.isArray(batchBody.batches)
      ? batchBody.batches.filter((item) => typeof item === 'string')
      : [];
    latestBatches = ids.sort((a, b) => batchEpoch(b) - batchEpoch(a) || b.localeCompare(a));
    renderOnline(health, latestBatches, batchesResponse.headers.get('X-Query-Time-Ms'));
  } catch {
    renderOffline();
  } finally {
    if (!quiet) refreshButton.disabled = false;
    liveRequest = undefined;
  }
};

refreshButton.addEventListener('click', () => refreshLive());
refreshLive();
window.setInterval(() => {
  if (!document.hidden) refreshLive({ quiet: true });
}, 4000);

// Fluid batch sheet --------------------------------------------------------
const sheet = document.getElementById('batch-sheet');
const scrim = document.getElementById('sheet-scrim');
const sheetHandle = document.getElementById('sheet-handle');
const sheetClose = document.getElementById('sheet-close');
const sheetTitle = document.getElementById('sheet-title');
const sheetContent = document.getElementById('sheet-content');

const sheetMotion = {
  y: 0,
  velocity: 0,
  target: 0,
  closedY: 800,
  frame: 0,
  open: false,
  dragging: false,
  lastFocus: null,
};

const rubberband = (overshoot, dimension, constant = 0.55) =>
  (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));

const project = (velocity, decelerationRate = 0.998) =>
  (velocity / 1000) * decelerationRate / (1 - decelerationRate);

const applySheetPosition = (value) => {
  sheetMotion.y = value;
  sheet.style.transform = `translate3d(0, ${value}px, 0)`;
  const openness = Math.max(0, Math.min(1, 1 - value / sheetMotion.closedY));
  scrim.style.opacity = String(openness);
};

const cancelSheetAnimation = () => {
  if (sheetMotion.frame) cancelAnimationFrame(sheetMotion.frame);
  sheetMotion.frame = 0;
};

const finishSheetClose = () => {
  sheetMotion.open = false;
  sheet.hidden = true;
  scrim.hidden = true;
  sheet.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  sheetMotion.lastFocus?.focus?.();
};

const springSheetTo = (target, initialVelocity = sheetMotion.velocity, onComplete) => {
  cancelSheetAnimation();
  sheetMotion.target = target;

  if (reduceMotion.matches) {
    applySheetPosition(target);
    sheetMotion.velocity = 0;
    onComplete?.();
    return;
  }

  // Critically damped by default: response 0.38s, damping ratio 1.0.
  const response = 0.38;
  const dampingRatio = 1;
  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const damping = 2 * dampingRatio * omega;
  let lastTime = performance.now();
  sheetMotion.velocity = initialVelocity;

  const step = (now) => {
    const dt = Math.min((now - lastTime) / 1000, 0.032);
    lastTime = now;
    const displacement = sheetMotion.y - target;
    const acceleration = -stiffness * displacement - damping * sheetMotion.velocity;
    sheetMotion.velocity += acceleration * dt;
    applySheetPosition(sheetMotion.y + sheetMotion.velocity * dt);

    if (Math.abs(sheetMotion.y - target) < 0.45 && Math.abs(sheetMotion.velocity) < 4) {
      applySheetPosition(target);
      sheetMotion.velocity = 0;
      sheetMotion.frame = 0;
      onComplete?.();
      return;
    }
    sheetMotion.frame = requestAnimationFrame(step);
  };
  sheetMotion.frame = requestAnimationFrame(step);
};

const openBatchSheet = async (batchId, trigger) => {
  sheetMotion.lastFocus = trigger ?? document.activeElement;
  sheet.hidden = false;
  scrim.hidden = false;
  sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  sheetTitle.textContent = batchId;
  sheetContent.replaceChildren(element('div', 'sheet-loading', 'Loading the projected history…'));

  sheetMotion.closedY = sheet.offsetHeight + 42;
  sheetMotion.open = true;
  applySheetPosition(sheetMotion.closedY);
  requestAnimationFrame(() => springSheetTo(0, 0, () => sheetClose.focus({ preventScroll: true })));

  try {
    const response = await fetchWithin(`${INDEXER}/batch/${encodeURIComponent(batchId)}/history`, 2800);
    if (!response.ok) throw new Error(`History request returned ${response.status}`);
    renderBatchHistory(await response.json(), response.headers.get('X-Query-Time-Ms'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sheetContent.replaceChildren(element('div', 'sheet-error', `History is not available: ${message}`));
  }
};

const closeBatchSheet = (velocity = sheetMotion.velocity) => {
  if (!sheetMotion.open) return;
  springSheetTo(sheetMotion.closedY, Math.max(velocity, 0), finishSheetClose);
};

const eventDetail = (event) => {
  switch (event.eventName) {
    case 'BatchRegistered': return `Producer ${event.producer ?? 'unknown'}`;
    case 'CustodyTransferred': return `${event.from ?? 'unknown'} → ${event.to ?? 'unknown'}`;
    case 'BatchFlagged': return event.reason ?? 'Batch policy flag';
    case 'BatchDelivered': return `Delivered by ${event.holder ?? 'current holder'}`;
    case 'BatchRecalled': return 'Direct regulator recall';
    case 'ComplianceBreach': return `${event.tempC ?? '?'}°C · ${event.consecutive ?? '?'} consecutive`;
    case 'RecallCascaded': return `${Array.isArray(event.recalled) ? event.recalled.length : 0} batches recalled`;
    default: return 'Ledger event';
  }
};

const renderBatchHistory = (history, queryTime) => {
  const statusGrid = element('div', 'batch-status-grid');
  [
    { value: String(history.eventCount ?? 0), label: 'indexed events' },
    { value: history.currentHolder ?? 'Unknown', label: 'current holder' },
    { value: history.recalled ? 'Recalled' : history.delivered ? 'Delivered' : 'Active', label: 'projected state' },
  ].forEach((item) => {
    const card = element('article');
    card.append(element('strong', '', item.value));
    card.append(element('span', '', item.label));
    statusGrid.append(card);
  });

  const sequenceSection = element('section', 'history-section');
  sequenceSection.append(element('h3', '', 'Event sequence'));
  const sequence = element('div', 'event-sequence');
  (history.events ?? []).forEach((event) => sequence.append(element('span', '', event.eventName)));
  sequenceSection.append(sequence);

  const timelineSection = element('section', 'history-section');
  timelineSection.append(element('h3', '', `Ledger order · ${queryTime ?? '—'} ms read`));
  const timeline = element('div', 'history-timeline');
  (history.events ?? []).forEach((event) => {
    const compliance = event.eventName === 'ComplianceBreach' || event.eventName === 'RecallCascaded';
    const row = element('article', `history-event${compliance ? ' compliance' : ''}`);
    row.append(element('strong', '', event.eventName));
    row.append(element('small', '', `${formatTimestamp(event.timestamp)} · block ${event.blockNumber ?? '?'}`));
    row.append(element('code', '', `${eventDetail(event)} · tx ${shortHash(event.transactionId, 18)}`));
    timeline.append(row);
  });
  timelineSection.append(timeline);

  const sections = [statusGrid, sequenceSection, timelineSection];
  const cascades = Array.isArray(history.recallCascades) ? history.recallCascades : [];
  if (cascades.length) {
    const recallSection = element('section', 'history-section recall-blast');
    recallSection.append(element('strong', '', 'Recall blast radius'));
    const list = element('ul');
    cascades.flatMap((item) => Array.isArray(item.recalled) ? item.recalled : []).forEach((batch) => list.append(element('li', '', batch)));
    recallSection.append(list);
    sections.push(recallSection);
  }
  sheetContent.replaceChildren(...sections);
};

sheetClose.addEventListener('click', () => closeBatchSheet(0));
scrim.addEventListener('click', () => closeBatchSheet(0));

let dragStartY = 0;
let dragStartSheetY = 0;
let dragHistory = [];

sheetHandle.addEventListener('pointerdown', (event) => {
  if (!sheetMotion.open) return;
  cancelSheetAnimation();
  sheetMotion.dragging = true;
  dragStartY = event.clientY;
  dragStartSheetY = sheetMotion.y;
  dragHistory = [{ y: event.clientY, time: performance.now() }];
  sheetHandle.setPointerCapture(event.pointerId);
});

sheetHandle.addEventListener('pointermove', (event) => {
  if (!sheetMotion.dragging) return;
  const delta = event.clientY - dragStartY;
  let next = dragStartSheetY + delta;
  if (next < 0) next = rubberband(next, sheet.offsetHeight);
  if (next > sheetMotion.closedY) {
    next = sheetMotion.closedY + rubberband(next - sheetMotion.closedY, sheet.offsetHeight);
  }
  applySheetPosition(next);
  const now = performance.now();
  dragHistory.push({ y: event.clientY, time: now });
  dragHistory = dragHistory.filter((sample) => now - sample.time <= 100);
});

const finishDrag = (event) => {
  if (!sheetMotion.dragging) return;
  sheetMotion.dragging = false;
  if (sheetHandle.hasPointerCapture(event.pointerId)) sheetHandle.releasePointerCapture(event.pointerId);

  const first = dragHistory[0];
  const last = dragHistory[dragHistory.length - 1];
  const elapsed = first && last ? Math.max(last.time - first.time, 1) : 1;
  const velocity = first && last ? ((last.y - first.y) / elapsed) * 1000 : 0;
  const projected = sheetMotion.y + project(velocity);
  const shouldClose = projected > sheetMotion.closedY * 0.43 || velocity > 900;
  if (shouldClose) closeBatchSheet(velocity);
  else springSheetTo(0, velocity);
};

sheetHandle.addEventListener('pointerup', finishDrag);
sheetHandle.addEventListener('pointercancel', finishDrag);

document.addEventListener('keydown', (event) => {
  if (!sheetMotion.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeBatchSheet(0);
  } else if (event.key === 'Tab') {
    // The sheet contains one action; keep keyboard focus in the modal surface.
    event.preventDefault();
    sheetClose.focus();
  }
});

window.addEventListener('resize', () => {
  if (!sheetMotion.open) return;
  sheetMotion.closedY = sheet.offsetHeight + 42;
  if (!sheetMotion.dragging && sheetMotion.target === 0) applySheetPosition(0);
});
