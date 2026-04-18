let isCapturing = false;
let cachedHistory = [];

document.addEventListener('DOMContentLoaded', async () => {
  // 버튼 이벤트 (onclick 속성 대신 addEventListener 사용 — MV3 CSP 정책)
  document.getElementById('btn-toggle').addEventListener('click', toggleCapture);
  document.getElementById('btn-clear').addEventListener('click', clearAll);
  document.getElementById('btn-dl-all').addEventListener('click', downloadAll);

  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  isCapturing = resp.isCapturing;
  updateToggleBtn();
  await loadHistory();
});

async function toggleCapture() {
  isCapturing = !isCapturing;
  await chrome.runtime.sendMessage({ type: 'SET_CAPTURING', value: isCapturing });
  updateToggleBtn();
  if (!isCapturing) {
    setTimeout(loadHistory, 1200);
  }
}

function updateToggleBtn() {
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

async function loadHistory() {
  cachedHistory = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  renderList(cachedHistory);
}

function renderList(history) {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="empty-msg">캡처된 페이지가 없습니다.</div>';
    return;
  }

  history.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'capture-item';

    const header = document.createElement('div');
    header.className = 'item-header';

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.innerHTML = `
      <div class="item-title" title="${esc(rec.title)}">${esc(rec.title)}</div>
      <div class="item-url" title="${esc(rec.url)}">${esc(rec.url)}</div>
      <div class="item-info">${esc(rec.timestamp)} · ${rec.captureCount}개 조각 합성</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnView = document.createElement('button');
    btnView.textContent = '전체 보기';
    btnView.addEventListener('click', () => viewFull(rec.id));

    const btnDl = document.createElement('button');
    btnDl.textContent = '저장';
    btnDl.addEventListener('click', () => downloadOne(rec.id));

    actions.appendChild(btnView);
    actions.appendChild(btnDl);
    header.appendChild(meta);
    header.appendChild(actions);

    const img = document.createElement('img');
    img.src = rec.dataUrl;
    img.className = 'item-thumb';
    img.title = '클릭하면 전체 이미지를 새 탭에서 봅니다';
    img.addEventListener('click', () => viewFull(rec.id));

    item.appendChild(header);
    item.appendChild(img);
    list.appendChild(item);
  });
}

function viewFull(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  const w = window.open('', '_blank');
  w.document.write(
    `<html><head><title>${esc(rec.title)}</title></head>` +
    `<body style="margin:0;background:#111;">` +
    `<img src="${rec.dataUrl}" style="display:block;max-width:100%;height:auto;" />` +
    `</body></html>`
  );
}

function downloadOne(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp));
}

async function downloadAll() {
  if (!cachedHistory || cachedHistory.length === 0) return;
  cachedHistory.forEach((rec, i) => {
    setTimeout(() => triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp)), i * 400);
  });
}

async function clearAll() {
  if (!confirm('캡처 기록을 모두 삭제할까요?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  cachedHistory = [];
  renderList([]);
}

function triggerDownload(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  a.click();
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = (timestamp || '').replace(/[. :]/g, '').slice(0, 14);
  return `QA_${safe}_${ts}.png`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
