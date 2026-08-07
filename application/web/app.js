const $ = (selector) => document.querySelector(selector);

const startButton = $('#start-button');
const simulateButton = $('#simulate-button');
const stopButton = $('#stop-button');
const batchInput = $('#batch-id');
const terminal = $('#terminal');
const statusLabel = $('#run-status');
const activeBatch = $('#active-batch');
const completedCount = $('#completed-count');
const elapsedLabel = $('#elapsed');
const networkStatus = $('#network-status');
const controlHint = $('#control-hint');
const resultCard = $('#result-card');
const resultTitle = $('#result-title');
const resultCopy = $('#result-copy');
const stepNodes = [...document.querySelectorAll('.steps li')];

const stepMatchers = [
  /REGISTER|registration|producer registers|RegisterBatch/i,
  /ACCESS|ABAC|refus|reject|not authorised/i,
  /CUSTODY|transfer|transporter/i,
  /DELIVER|warehouse|clean path/i,
  /ORACLE|temperature|sensor|summar/i,
  /HISTORY|regulator|FLAGGED|breach threshold/i,
  /CASCADE|derived|BFS/i,
];

const simulationLines = [
  ['$ producer register --batch SIM-001', 'Gateway proposal created → transient private details attached → BatchRegistered emitted'],
  ['[peer] requireRole(caller, "producer")', 'Transporter certificate rejected: expected role=producer, received role=transporter'],
  ['$ transporter transfer --batch SIM-001 --to Org2MSP', 'CustodyTransferred: Org1MSP → Org2MSP; state CREATED → IN_TRANSIT'],
  ['$ warehouse deliver --batch SIM-001', 'State machine accepted AT_WAREHOUSE → DELIVERED for the clean-path batch'],
  ['[oracle] store → SHA-256 → summarise four sensor windows', 'Window means: 2.0°C, 8.8°C, 9.1°C, 9.0°C; three consecutive breaches'],
  ['[compliance] invokeChaincode("batch-registry", FlagBatch)', 'Threshold reached → batch status FLAGGED; regulator reads the complete ledger history'],
  ['[recall] BFS(root) → children → descendants', 'RecallCascaded emitted; every derived batch visited exactly once'],
];

let currentStatus = 'idle';
let currentStep = -1;
let startedAt = 0;
let timer;

const setNetwork = (preflight) => {
  const ready = Boolean(preflight?.ready && preflight?.showcase && preflight?.indexerDependencies);
  networkStatus.dataset.state = ready ? 'ready' : 'offline';
  networkStatus.querySelector('span').textContent = ready
    ? 'Fabric network ready'
    : 'Fabric network not ready';
  controlHint.textContent = ready
    ? 'Run live transactions, or play the instant code simulation without changing the ledger.'
    : 'Live mode needs network/network.sh all. The code simulation is available now.';
};

const resetSteps = () => {
  currentStep = -1;
  stepNodes.forEach((node) => {
    node.classList.remove('active', 'done');
    node.querySelector('em').textContent = 'WAITING';
  });
  completedCount.textContent = '0';
};

const activateStep = (index) => {
  if (index < currentStep) return;
  stepNodes.forEach((node, nodeIndex) => {
    node.classList.toggle('done', nodeIndex < index);
    node.classList.toggle('active', nodeIndex === index);
    node.querySelector('em').textContent = nodeIndex < index ? 'DONE' : nodeIndex === index ? 'RUNNING' : 'WAITING';
  });
  currentStep = index;
  completedCount.textContent = String(Math.max(0, index));
};

const completeSteps = () => {
  stepNodes.forEach((node) => {
    node.classList.remove('active');
    node.classList.add('done');
    node.querySelector('em').textContent = 'DONE';
  });
  completedCount.textContent = '7';
};

const appendLine = (line, className = '') => {
  const row = document.createElement('p');
  row.className = className;
  row.textContent = line === '' ? ' ' : line;
  if (/^#{4,}|^={6,}/.test(line)) row.classList.add('heading');
  terminal.append(row);
  while (terminal.children.length > 800) terminal.firstElementChild.remove();
  terminal.scrollTop = terminal.scrollHeight;

  const matched = stepMatchers.findIndex((pattern) => pattern.test(line));
  if (matched >= 0 && matched >= currentStep) activateStep(matched);
};

const renderState = (state) => {
  currentStatus = state.status;
  statusLabel.textContent = state.status.toUpperCase();
  activeBatch.textContent = state.batchId || '—';
  startButton.disabled = state.status === 'running';
  simulateButton.disabled = state.status === 'running';
  stopButton.disabled = state.status !== 'running';
  batchInput.disabled = state.status === 'running';
  resultCard.dataset.state = state.status;

  if (state.status === 'running') {
    if (!startedAt) startedAt = Date.now();
    resultTitle.textContent = 'Live transactions running';
    resultCopy.textContent = 'Receiving the real showcase.sh, Fabric Gateway and Indexer output stream.';
  } else if (state.status === 'passed') {
    completeSteps();
    resultTitle.textContent = 'End-to-end verification passed';
    resultCopy.textContent = `Batch ${state.batchId} completed the real code path with process exit code 0.`;
  } else if (state.status === 'failed') {
    resultTitle.textContent = 'Execution failed';
    resultCopy.textContent = `Process exit code: ${state.exitCode ?? 'unknown'}. Inspect the red terminal output for the failed block.`;
  } else if (state.status === 'stopped') {
    resultTitle.textContent = 'Execution stopped';
    resultCopy.textContent = 'The background process received a termination signal.';
  }
};

const refreshState = async () => {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const state = await response.json();
    setNetwork(state.preflight);
    renderState(state);
  } catch (error) {
    networkStatus.dataset.state = 'offline';
    networkStatus.querySelector('span').textContent = 'Control service disconnected';
  }
};

startButton.addEventListener('click', async () => {
  resetSteps();
  terminal.replaceChildren();
  resultCard.dataset.state = 'running';
  startedAt = Date.now();
  const response = await fetch('/api/demo/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: batchInput.value.trim() }),
  });
  const body = await response.json();
  if (!response.ok) {
    appendLine(`Start failed: ${body.error}`, 'stderr');
    await refreshState();
    return;
  }
  activeBatch.textContent = body.batchId;
  renderState({ status: 'running', batchId: body.batchId });
});

simulateButton.addEventListener('click', async () => {
  resetSteps();
  terminal.replaceChildren();
  currentStatus = 'running';
  startedAt = Date.now();
  statusLabel.textContent = 'SIMULATING';
  activeBatch.textContent = 'SIM-001';
  startButton.disabled = true;
  simulateButton.disabled = true;
  batchInput.disabled = true;
  resultCard.dataset.state = 'running';
  resultTitle.textContent = 'Code walkthrough in progress';
  resultCopy.textContent = 'Each block below is taken from the project implementation and paired with a realistic runtime event.';
  appendLine('Simulation started — no ledger state will be changed.', 'system');

  for (const [index, lines] of simulationLines.entries()) {
    activateStep(index);
    stepNodes[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
    appendLine(`\n[BLOCK ${index + 1}/7] ${stepNodes[index].querySelector('strong').textContent}`, 'heading');
    appendLine(lines[0]);
    appendLine(`  ✓ ${lines[1]}`);
    await new Promise((resolve) => window.setTimeout(resolve, 1050));
  }

  completeSteps();
  currentStatus = 'passed';
  statusLabel.textContent = 'SIMULATED';
  startButton.disabled = false;
  simulateButton.disabled = false;
  batchInput.disabled = false;
  resultCard.dataset.state = 'passed';
  resultTitle.textContent = 'Code walkthrough complete';
  resultCopy.textContent = 'Seven implementation blocks were executed as a realistic visual simulation. Use “Run live demo” to submit the same flow to Fabric.';
  appendLine('\nSimulation complete — 7/7 code blocks explained.', 'system');
});

stopButton.addEventListener('click', async () => {
  await fetch('/api/demo/stop', { method: 'POST' });
});

$('#clear-button').addEventListener('click', () => terminal.replaceChildren());

const events = new EventSource('/api/events');
events.addEventListener('output', (message) => {
  const event = JSON.parse(message.data);
  appendLine(event.line ?? '', event.stream === 'stderr' ? 'stderr' : '');
});
events.addEventListener('system', (message) => {
  const event = JSON.parse(message.data);
  appendLine(event.line ?? '', 'system');
});
events.addEventListener('state', (message) => renderState(JSON.parse(message.data)));

timer = window.setInterval(() => {
  if (currentStatus !== 'running' || !startedAt) return;
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  elapsedLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}, 1000);

window.addEventListener('beforeunload', () => window.clearInterval(timer));
refreshState();
