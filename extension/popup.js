let isCapturing = false;

// 팝업 열릴 때 초기화
document.addEventListener('DOMContentLoaded', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  isCapturing = resp.isCapturing;
  updateToggleBtn();
  await loadHistory();
});

// 시작 / 종료 토글
async function toggleCapture() {
  isCapturing = !isCapturing;
  await chrome.runtime.sendMessage({ type: 'SET_CAPTURING', value: isCapturing });
  updateToggleBtn();
  if (!isCapturing) {
    // 종료 시 잠시 후 새로 저장된 항목 반영
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

// 저장된 캡처 목록 로드
async function loadHistory() {
  const history = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  renderList(history);
}

function renderList(history) {
  const list = document.getElementById('list');

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="empty-msg">캡처된 페이지가 없습니다.</div>';
    return;
  }

  list.innerHTML = '';
  history.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'capture-item';
    item.innerHTML = `
      <div class="item-header">
        <div class="item-meta">
          <div class="item-title" title="${esc(rec.title)}">${esc(rec.title)}</div>
          <div class="item-url" title="${esc(rec.url)}">${esc(rec.url)}</div>
          <div class="item-info">${esc(rec.timestamp)} · ${rec.captureCount}개 조각 합성</div>
        </div>
        <div class="item-actions">
          <button onclick="viewFull('${rec.id}')">전체 보기</button>
          <button onclick="download('${rec.id}')">저장</button>
        </div>
      </div>
      <img src="${rec.dataUrl}" class="item-thumb" onclick="viewFull('${rec.id}')" title="클릭하면 전체 이미지를 새 탭에서 봅니다" />
    `;
    item.dataset.id = rec.id;
    item.dataset.dataUrl = rec.dataUrl;
    item.dataset.title = rec.title;
    list.appendChild(item);
  });
}

async function viewFull(id) {
  const history = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const rec = history.find(r => String(r.id) === String(id));
  if (!rec) return;
  const w = window.open();
  w.document.write(`
    <html><head><title>${esc(rec.title)}</title></head>
    <body style="margin:0;background:#111;">
      <img src="${rec.dataUrl}" style="display:block;max-width:100%;height:auto;" />
    </body></html>
  `);
}

async function download(id) {
  const history = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const rec = history.find(r => String(r.id) === String(id));
  if (!rec) return;
  triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp));
}

async function downloadAll() {
  const history = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  if (!history || history.length === 0) return;
  history.forEach((rec, i) => {
    setTimeout(() => triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp)), i * 400);
  });
}

async function clearAll() {
  if (!confirm('캡처 기록을 모두 삭제할까요?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  await loadHistory();
}

function triggerDownload(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  a.click();
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = timestamp.replace(/[. :]/g, '').slice(0, 14);
  return `QA_${safe}_${ts}.png`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
