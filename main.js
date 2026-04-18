const PAGE_NAMES = {
  home: '홈',
  product: '제품 소개',
  service: '서비스',
  contact: '문의',
};

let currentPage = 'home';
let captureLog = [];
let toastTimer = null;
let capturing = false;

function startCapture() {
  capturing = true;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled = false;
  const status = document.getElementById('capture-status');
  status.textContent = '캡처 중';
  status.className = 'capture-status running';
  showToast('캡처를 시작합니다.');
  captureCurrentPage(currentPage);
}

function stopCapture() {
  capturing = false;
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;
  const status = document.getElementById('capture-status');
  status.textContent = '대기 중';
  status.className = 'capture-status stopped';
  showToast('캡처를 종료했습니다.');
}

function navigate(pageId) {
  if (pageId === currentPage) return;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');
  currentPage = pageId;

  if (!capturing) return;

  requestAnimationFrame(() => {
    setTimeout(() => captureCurrentPage(pageId), 150);
  });
}

function captureCurrentPage(pageId) {
  const target = document.getElementById('main-content');

  html2canvas(target, {
    scale: 1.5,
    useCORS: true,
    backgroundColor: '#f4f6fb',
  }).then(canvas => {
    const dataUrl = canvas.toDataURL('image/png');
    const now = new Date();
    const timeStr = now.toLocaleString('ko-KR');
    const fileName = `QA_${PAGE_NAMES[pageId]}_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;

    captureLog.push({ pageId, pageName: PAGE_NAMES[pageId], dataUrl, timeStr, fileName });
    updateCount();
    renderLogItem(captureLog[captureLog.length - 1]);
    showToast(`[${PAGE_NAMES[pageId]}] 페이지 캡처 완료`);
  });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function updateCount() {
  document.getElementById('capture-count').textContent = captureLog.length;
}

function renderLogItem(item) {
  const list = document.getElementById('log-list');
  const empty = list.querySelector('.empty-msg');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'capture-item';
  div.innerHTML = `
    <div class="capture-item-header">
      <span class="capture-item-title">${item.pageName}</span>
      <span class="capture-item-time">${item.timeStr}</span>
    </div>
    <img src="${item.dataUrl}" alt="${item.pageName}" title="클릭 시 전체 보기" onclick="openFull('${item.dataUrl}')" />
    <div class="capture-item-footer">
      <button class="btn-dl" onclick="downloadOne('${item.fileName}', '${item.dataUrl}')">다운로드</button>
    </div>
  `;
  list.appendChild(div);
}

function openFull(dataUrl) {
  const w = window.open();
  w.document.write(`<img src="${dataUrl}" style="max-width:100%;display:block;margin:auto;" />`);
}

function downloadOne(fileName, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  a.click();
}

function downloadAll() {
  if (captureLog.length === 0) {
    showToast('다운로드할 캡처가 없습니다.');
    return;
  }
  captureLog.forEach((item, i) => {
    setTimeout(() => downloadOne(item.fileName, item.dataUrl), i * 300);
  });
  showToast(`${captureLog.length}개 캡처 다운로드 시작`);
}

function clearLog() {
  captureLog = [];
  updateCount();
  const list = document.getElementById('log-list');
  list.innerHTML = '<p class="empty-msg">아직 캡처된 페이지가 없습니다.</p>';
  showToast('캡처 로그가 초기화되었습니다.');
}

function toggleLog() {
  document.getElementById('capture-log').classList.toggle('hidden');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

