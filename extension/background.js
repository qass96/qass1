// 탭별 진행 중인 캡처 상태 (메모리)
const tabCaptures = new Map();
// Map<tabId, { url, title, captures: [{scrollY, scrollHeight, viewportH, viewportW, dpr, dataUrl}] }>

let isCapturing = false;
let prevTabId = null;

// ── 메시지 핸들러 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'SCROLL_CHANGED' && tabId) {
    handleScrollCapture(tabId, msg);
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ isCapturing });
    return true;
  }

  if (msg.type === 'SET_CAPTURING') {
    isCapturing = msg.value;
    if (!isCapturing) finalizeAll();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_HISTORY') {
    getHistory().then(sendResponse);
    return true;
  }

  if (msg.type === 'CLEAR_HISTORY') {
    chrome.storage.local.set({ history: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── 스크롤 시 새 영역 캡처 ────────────────────────────────────────────────────
async function handleScrollCapture(tabId, msg) {
  if (!isCapturing) return;

  const state = tabCaptures.get(tabId);
  if (!state) return;

  const { scrollY, scrollHeight, viewportH, viewportW, dpr } = msg;
  const last = state.captures[state.captures.length - 1];

  // 이전 캡처의 하단보다 새로운 영역이 보일 때만 캡처
  if (last && scrollY + viewportH <= last.scrollY + last.viewportH + 50) return;

  await doCapture(tabId, scrollY, scrollHeight, viewportH, viewportW, dpr);
}

// ── 실제 스크린샷 촬영 ────────────────────────────────────────────────────────
async function doCapture(tabId, scrollY, scrollHeight, viewportH, viewportW, dpr) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;

    if (!tabCaptures.has(tabId)) {
      tabCaptures.set(tabId, { url: tab.url, title: tab.title, captures: [] });
    }
    const state = tabCaptures.get(tabId);
    state.url = tab.url;
    state.title = tab.title;
    state.captures.push({ scrollY, scrollHeight, viewportH, viewportW, dpr, dataUrl });

  } catch (e) {
    // 캡처 불가 탭(chrome:// 등) 무시
  }
}

// ── 탭 캡처 완료 → 이어붙이기 → 저장 ─────────────────────────────────────────
async function finalizeTab(tabId) {
  const state = tabCaptures.get(tabId);
  if (!state || state.captures.length === 0) {
    tabCaptures.delete(tabId);
    return;
  }
  tabCaptures.delete(tabId);

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
  if (history.length > 50) history.splice(50);
  await chrome.storage.local.set({ history });
}

async function finalizeAll() {
  for (const tabId of [...tabCaptures.keys()]) {
    await finalizeTab(tabId);
  }
}

// ── 이미지 이어붙이기 (OffscreenCanvas) ───────────────────────────────────────
async function stitchCaptures(captures) {
  if (captures.length === 0) return null;
  if (captures.length === 1) return captures[0].dataUrl;

  const { viewportW, viewportH, dpr } = captures[0];

  const totalCssH = captures.reduce((m, c) => Math.max(m, c.scrollY + c.viewportH), 0);
  const maxCssH = Math.max(totalCssH, captures[0].scrollHeight || 0);

  // canvas 최대 높이 32000px 초과 시 비율 축소
  const scale = Math.min(dpr || 1, 32000 / maxCssH);
  const canvasW = Math.round(viewportW * scale);
  const canvasH = Math.round(maxCssH * scale);

  const offscreen = new OffscreenCanvas(canvasW, canvasH);
  const ctx = offscreen.getContext('2d');

  for (const cap of captures) {
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

// ── 저장소 조회 ───────────────────────────────────────────────────────────────
async function getHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  return history;
}

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── 탭 이벤트 ────────────────────────────────────────────────────────────────

// 탭 전환: 이전 탭 완료 처리 + 새 탭 첫 캡처
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // 이전 탭 finalize
  if (prevTabId && prevTabId !== tabId) {
    await finalizeTab(prevTabId);
  }
  prevTabId = tabId;

  if (!isCapturing) return;

  tabCaptures.set(tabId, { url: '', title: '', captures: [] });

  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_SCROLL_INFO' }, async (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      await doCapture(tabId, resp.scrollY, resp.scrollHeight, resp.viewportH, resp.viewportW, resp.dpr);
    });
  }, 700);
});

// 페이지 이동(URL 변경): 기존 캡처 완료 후 새로 시작
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  if (tabCaptures.has(tabId)) {
    await finalizeTab(tabId);
  }

  if (!isCapturing) return;

  tabCaptures.set(tabId, { url: '', title: '', captures: [] });

  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_SCROLL_INFO' }, async (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      await doCapture(tabId, resp.scrollY, resp.scrollHeight, resp.viewportH, resp.viewportW, resp.dpr);
    });
  }, 900);
});

// 탭 닫힘: finalize
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabCaptures.has(tabId)) {
    await finalizeTab(tabId);
  }
});
