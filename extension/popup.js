'use strict';

let isCapturing = false;
let cachedHistory = [];

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 모든 버튼 이벤트는 여기서만 등록 (HTML에 onclick 없음 — MV3 CSP 준수)
  document.getElementById('btn-toggle').addEventListener('click', onToggle);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('btn-dl-all').addEventListener('click', onDownloadAll);

  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  isCapturing = resp.isCapturing;
  updateUI();
  await loadHistory();
});

// ── 버튼 핸들러 ───────────────────────────────────────────────────────────────
async function onToggle() {
  isCapturing = !isCapturing;
  await chrome.runtime.sendMessage({ type: 'SET_CAPTURING', value: isCapturing });
  updateUI();
  if (!isCapturing) {
    setTimeout(loadHistory, 1200);
  }
}

async function onClear() {
  if (!confirm('캡처 기록을 모두 삭제할까요?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  cachedHistory = [];
  renderList([]);
}

async function onDownloadAll() {
  if (!cachedHistory.length) return;
  cachedHistory.forEach((rec, i) => {
    setTimeout(() => triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp)), i * 400);
  });
}

// ── UI 갱신 ───────────────────────────────────────────────────────────────────
function updateUI() {
  const btn = document.getElementById('btn-toggle');
  const bar = document.getElementById('status-bar');
  const txt = document.getElementById('status-text');

  if (isCapturing) {
    btn.textContent = '■ 종료';
    btn.className = 'btn-stop';
    bar.className = 'status-bar running';
    txt.textContent = '캡처 중 — 탭 이동 및 스크롤 시 자동 캡처됩니다';
  } else {
    btn.textContent = '▶ 시작';
    btn.className = 'btn-start';
    bar.className = 'status-bar stopped';
    txt.textContent = '대기 중 — 시작 버튼을 누르면 탭 이동 시 자동 캡처됩니다';
  }
}

// ── 히스토리 로드 & 렌더링 ────────────────────────────────────────────────────
async function loadHistory() {
  cachedHistory = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  renderList(cachedHistory);
}

function renderList(history) {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!history || history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = '캡처된 페이지가 없습니다.';
    list.appendChild(empty);
    return;
  }

  history.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'capture-item';

    // 헤더
    const header = document.createElement('div');
    header.className = 'item-header';

    // 메타 정보 (innerHTML 대신 textContent 사용)
    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const titleEl = document.createElement('div');
    titleEl.className = 'item-title';
    titleEl.textContent = rec.title;
    titleEl.title = rec.title;

    const urlEl = document.createElement('div');
    urlEl.className = 'item-url';
    urlEl.textContent = rec.url;
    urlEl.title = rec.url;

    const infoEl = document.createElement('div');
    infoEl.className = 'item-info';
    infoEl.textContent = rec.timestamp + ' · ' + rec.captureCount + '개 조각 합성';

    meta.appendChild(titleEl);
    meta.appendChild(urlEl);
    meta.appendChild(infoEl);

    // 액션 버튼
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnView = document.createElement('button');
    btnView.textContent = '전체 보기';
    btnView.addEventListener('click', () => openFullView(rec.id));

    const btnDl = document.createElement('button');
    btnDl.textContent = '저장';
    btnDl.addEventListener('click', () => onDownloadOne(rec.id));

    actions.appendChild(btnView);
    actions.appendChild(btnDl);

    header.appendChild(meta);
    header.appendChild(actions);

    // 썸네일
    const img = document.createElement('img');
    img.src = rec.dataUrl;
    img.className = 'item-thumb';
    img.alt = rec.title;
    img.title = '클릭하면 전체 이미지를 새 탭에서 봅니다';
    img.addEventListener('click', () => openFullView(rec.id));

    item.appendChild(header);
    item.appendChild(img);
    list.appendChild(item);
  });
}

// ── 전체 이미지 보기 ──────────────────────────────────────────────────────────
function openFullView(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;

  // data URL을 Blob URL로 변환해서 새 탭에 표시 (document.write 미사용)
  fetch(rec.dataUrl)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url });
    });
}

// ── 다운로드 ──────────────────────────────────────────────────────────────────
function onDownloadOne(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp));
}

function triggerDownload(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = (timestamp || '').replace(/[^0-9]/g, '').slice(0, 14);
  return 'QA_' + safe + '_' + ts + '.png';
}
