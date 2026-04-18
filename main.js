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

// BroadcastChannel: 같은 origin의 다른 탭과 통신
const channel = new BroadcastChannel('qa_capture');

// 다른 탭에서 전달된 풀페이지 이미지 수신
channel.addEventListener('message', e => {
  if (e.data.type === 'full_page_image') {
    saveCapture(e.data.dataUrl, e.data.label);
  }
  if (e.data.type === 'capture_request') {
    // 이 탭이 캡처 요청을 받으면 풀페이지 캡처 후 전송
    doFullPageAndBroadcast(e.data.label);
  }
});

// 탭 전환 감지: 다른 탭으로 이동할 때 해당 탭에 캡처 요청 전송
document.addEventListener('visibilitychange', () => {
  if (!capturing) return;

  if (document.hidden) {
    // 다른 탭에 캡처 요청 (페이지 로딩 대기 후)
    setTimeout(() => {
      channel.postMessage({ type: 'capture_request', label: '탭전환' });
    }, 1500);
  }
});

// 현재 탭 내 메뉴 이동
function navigate(pageId) {
  if (pageId === currentPage) return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');
  currentPage = pageId;

  if (!capturing) return;

  window.scrollTo(0, 0);
  // 렌더링 완료 대기 후 풀페이지 캡처
  requestAnimationFrame(() => requestAnimationFrame(() => {
    setTimeout(() => captureFullPage(PAGE_NAMES[pageId]), 300);
  }));
}

// 풀페이지 캡처 → 로그에 저장
function captureFullPage(label) {
  window.scrollTo(0, 0);
  setTimeout(() => {
    const fullH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const fullW = document.documentElement.offsetWidth;

    html2canvas(document.documentElement, {
      scale: window.devicePixelRatio || 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#f4f6fb',
      scrollX: 0,
      scrollY: 0,
      width: fullW,
      height: fullH,
      windowWidth: fullW,
      windowHeight: fullH,
    }).then(canvas => {
      saveCapture(canvas.toDataURL('image/png'), label);
    });
  }, 300);
}

// 풀페이지 캡처 → BroadcastChannel로 컨트롤 탭에 전송
function doFullPageAndBroadcast(label) {
  window.scrollTo(0, 0);
  setTimeout(() => {
    const fullH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const fullW = document.documentElement.offsetWidth;

    html2canvas(document.documentElement, {
      scale: window.devicePixelRatio || 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#f4f6fb',
      scrollX: 0,
      scrollY: 0,
      width: fullW,
      height: fullH,
      windowWidth: fullW,
      windowHeight: fullH,
    }).then(canvas => {
      channel.postMessage({
        type: 'full_page_image',
        dataUrl: canvas.toDataURL('image/png'),
        label,
      });
    });
  }, 300);
}

function startCapture() {
  capturing = true;
  setUICapturing(true);
  showToast('캡처 시작 — 페이지 이동 시 전체 페이지가 자동 캡처됩니다.');
  // 현재 페이지 즉시 캡처
  captureFullPage(PAGE_NAMES[currentPage] || '시작');
}

function stopCapture() {
  capturing = false;
  setUICapturing(false);
  showToast(`캡처 종료 — 총 ${captureLog.length}개 저장됨`);
}

function snapNow() {
  captureFullPage('수동');
  // 다른 탭에도 동시에 캡처 요청
  channel.postMessage({ type: 'capture_request', label: '수동' });
}

function saveCapture(dataUrl, label) {
  const now = new Date();
  const timeStr = now.toLocaleString('ko-KR');
  const seq = String(captureLog.length + 1).padStart(3, '0');
  const fileName = `QA_${seq}_${label}_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;

  captureLog.push({ pageName: label, dataUrl, timeStr, fileName });
  updateCount();
  renderLogItem(captureLog[captureLog.length - 1]);
  showToast(`[${label}] 전체 페이지 캡처 완료 (${captureLog.length}번째)`);
}

function setUICapturing(on) {
  document.getElementById('btn-start').disabled = on;
  document.getElementById('btn-stop').disabled = !on;
  document.getElementById('btn-snap').disabled = !on;
  const status = document.getElementById('capture-status');
  status.textContent = on ? '캡처 중' : '대기 중';
  status.className = 'capture-status ' + (on ? 'running' : 'stopped');
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
  if (captureLog.length === 0) { showToast('다운로드할 캡처가 없습니다.'); return; }
  captureLog.forEach((item, i) => setTimeout(() => downloadOne(item.fileName, item.dataUrl), i * 300));
  showToast(`${captureLog.length}개 캡처 다운로드 시작`);
}

function clearLog() {
  captureLog = [];
  updateCount();
  document.getElementById('log-list').innerHTML = '<p class="empty-msg">아직 캡처된 페이지가 없습니다.</p>';
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
