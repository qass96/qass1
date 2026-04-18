// ── 상태 ──────────────────────────────────────────────────────────────────────
let isCapturing = false;
const tabCaptures = new Map(); // tabId → { windowId, url, title, captures[] }
let prevTabId = null;

// 서비스 워커 재시작 시 캡처 상태 복원
chrome.storage.local.get('isCapturing').then(({ isCapturing: v }) => {
  isCapturing = !!v;
});

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 메시지 핸들러 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  if (msg.type === 'SCROLL_CHANGED' && tabId) {
    handleScrollCapture(tabId, windowId, msg);
    return;
  }
  if (msg.type === 'GET_STATUS') {
    sendResponse({ isCapturing });
    return true;
  }
  if (msg.type === 'SET_CAPTURING') {
    setCapturing(msg.value).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_HISTORY') {
    chrome.storage.local.get('history').then(({ history = [] }) => sendResponse(history));
    return true;
  }
  if (msg.type === 'CLEAR_HISTORY') {
    chrome.storage.local.set({ history: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── 캡처 시작/종료 ────────────────────────────────────────────────────────────
async function setCapturing(value) {
  isCapturing = value;
  await chrome.storage.local.set({ isCapturing: value });

  if (value) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  } else {
    await finalizeAll();
  }
}

// ── 수동 스크롤 시 새 영역 추가 캡처 ─────────────────────────────────────────
async function handleScrollCapture(tabId, windowId, msg) {
  if (!isCapturing) return;
  const state = tabCaptures.get(tabId);
  if (!state) return;

  const { scrollY, scrollHeight, viewportH, viewportW, dpr } = msg;
  const last = state.captures[state.captures.length - 1];
  if (last && scrollY + viewportH <= last.scrollY + last.viewportH + 50) return;

  await doCapture(tabId, windowId || state.windowId, scrollY, scrollHeight, viewportH, viewportW, dpr);
}

// ── 스크린샷 촬영 ─────────────────────────────────────────────────────────────
async function doCapture(tabId, windowId, scrollY, scrollHeight, viewportH, viewportW, dpr) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!activeTab || activeTab.id !== tabId) return;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    if (!tabCaptures.has(tabId)) {
      tabCaptures.set(tabId, { windowId: tab.windowId, url: tab.url, title: tab.title, captures: [] });
    }
    const state = tabCaptures.get(tabId);
    state.url = tab.url;
    state.title = tab.title;
    state.windowId = tab.windowId;
    state.captures.push({ scrollY, scrollHeight, viewportH, viewportW, dpr, dataUrl });

    console.log(`[QA] captured tab=${tabId} scrollY=${scrollY} total=${state.captures.length}`);
  } catch (e) {
    console.warn('[QA] captureVisibleTab error:', e.message);
  }
}

// ── 자동 페이지 전체 스캔 ─────────────────────────────────────────────────────
// 탭 진입 후 스크롤 없이도 페이지 하단까지 자동 캡처
async function autoScanPage(tabId, windowId) {
  const state = tabCaptures.get(tabId);
  if (!state) return;

  const info = await getScrollInfo(tabId);
  const { scrollHeight, viewportH, viewportW, dpr } = info;

  // 페이지가 뷰포트보다 크지 않으면 스캔 불필요
  if (scrollHeight <= viewportH + 10) return;

  const OVERLAP = 60; // 조각 간 겹치는 픽셀 (이음새 방지)
  let scanY = viewportH - OVERLAP;

  while (scanY < scrollHeight) {
    // 탭이 여전히 활성 상태인지 확인
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (!active || active.id !== tabId) break;

    // 이미 커버된 영역이면 건너뜀
    const covered = state.captures.some(c =>
      c.scrollY <= scanY && c.scrollY + c.viewportH >= scanY + viewportH - OVERLAP
    );
    if (!covered) {
      // 해당 위치로 즉시 스크롤
      await chrome.scripting.executeScript({
        target: { tabId },
        func: y => window.scrollTo({ top: y, behavior: 'instant' }),
        args: [scanY],
      }).catch(() => {});

      await sleep(180); // 렌더링 대기
      const cur = await getScrollInfo(tabId);
      await doCapture(tabId, windowId, scanY, cur.scrollHeight, cur.viewportH, cur.viewportW, cur.dpr);
    }

    scanY += viewportH - OVERLAP;
  }

  // 페이지 맨 아래가 확실히 포함되도록 마지막 캡처
  const bottomY = Math.max(0, scrollHeight - viewportH);
  const lastCap = state.captures[state.captures.length - 1];
  if (!lastCap || lastCap.scrollY + lastCap.viewportH < scrollHeight - 10) {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active && active.id === tabId) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: y => window.scrollTo({ top: y, behavior: 'instant' }),
        args: [bottomY],
      }).catch(() => {});
      await sleep(180);
      const cur = await getScrollInfo(tabId);
      await doCapture(tabId, windowId, bottomY, cur.scrollHeight, cur.viewportH, cur.viewportW, cur.dpr);
    }
  }

  // 스캔 완료 후 맨 위로 복원
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo({ top: 0, behavior: 'instant' }),
    args: [],
  }).catch(() => {});
}

// ── 탭 완료 처리 ──────────────────────────────────────────────────────────────
async function finalizeTab(tabId) {
  const state = tabCaptures.get(tabId);
  tabCaptures.delete(tabId);
  if (!state || state.captures.length === 0) return;

  const stitchedDataUrl = await stitchCaptures(state.captures);
  if (!stitchedDataUrl) return;

  const record = {
    id: Date.now(),
    url: state.url,
    title: state.title || extractHostname(state.url),
    dataUrl: stitchedDataUrl,
    captureCount: state.captures.length,
    timestamp: new Date().toLocaleString('ko-KR'),
  };

  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(record);
  if (history.length > 30) history.splice(30);
  await chrome.storage.local.set({ history });
  console.log(`[QA] saved "${record.title}" (${record.captureCount} pieces)`);
}

async function finalizeAll() {
  for (const tabId of [...tabCaptures.keys()]) {
    await finalizeTab(tabId);
  }
}

// ── 이미지 이어붙이기 ─────────────────────────────────────────────────────────
async function stitchCaptures(captures) {
  if (captures.length === 0) return null;
  if (captures.length === 1) return captures[0].dataUrl;

  const { viewportW, viewportH, dpr } = captures[0];

  // 전체 페이지 높이 = 캡처 중 가장 아래쪽 끝
  const totalCssH = captures.reduce((m, c) => Math.max(m, c.scrollY + c.viewportH), 0);
  const scale = Math.min(dpr || 1, 32000 / totalCssH);

  const canvasW = Math.round(viewportW * scale);
  const canvasH = Math.round(totalCssH * scale);

  const offscreen = new OffscreenCanvas(canvasW, canvasH);
  const ctx = offscreen.getContext('2d');

  // scrollY 오름차순으로 정렬하여 순서대로 그리기
  const sorted = [...captures].sort((a, b) => a.scrollY - b.scrollY);
  for (const cap of sorted) {
    const resp = await fetch(cap.dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, Math.round(cap.scrollY * scale));
    bitmap.close();
  }

  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return 'data:image/png;base64,' + btoa(binary);
}

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── content script 스크롤 정보 요청 ──────────────────────────────────────────
function getScrollInfo(tabId) {
  return new Promise(resolve => {
    const fallback = { scrollY: 0, scrollHeight: 0, viewportH: 900, viewportW: 1440, dpr: 1 };
    chrome.tabs.sendMessage(tabId, { type: 'GET_SCROLL_INFO' }, resp => {
      resolve(chrome.runtime.lastError || !resp ? fallback : resp);
    });
  });
}

// ── 탭 이벤트 ─────────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (prevTabId && prevTabId !== tabId && tabCaptures.has(prevTabId)) {
    await finalizeTab(prevTabId);
  }
  prevTabId = tabId;
  if (!isCapturing) return;

  tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });

  await sleep(400);
  const info = await getScrollInfo(tabId);
  await doCapture(tabId, windowId, info.scrollY, info.scrollHeight, info.viewportH, info.viewportW, info.dpr);

  // 초기 캡처 후 페이지 전체 자동 스캔
  await autoScanPage(tabId, windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  if (tabCaptures.has(tabId)) {
    await finalizeTab(tabId);
  }
  if (!isCapturing) return;

  tabCaptures.set(tabId, { windowId: tab.windowId, url: tab.url, title: tab.title, captures: [] });

  await sleep(600);
  const info = await getScrollInfo(tabId);
  await doCapture(tabId, tab.windowId, info.scrollY, info.scrollHeight, info.viewportH, info.viewportW, info.dpr);

  // 페이지 로드 후 전체 자동 스캔
  await autoScanPage(tabId, tab.windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabCaptures.has(tabId)) await finalizeTab(tabId);
});
