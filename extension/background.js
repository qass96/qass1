// ── 상태 ──────────────────────────────────────────────────────────────────────
let isCapturing = false;
const tabCaptures = new Map(); // tabId → { windowId, url, title, captures[] }
let prevTabId = null;

// 서비스 워커 재시작 시 캡처 상태 복원
chrome.storage.local.get('isCapturing').then(({ isCapturing: v }) => {
  isCapturing = !!v;
});

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
    // 이미 열린 탭에 content script 재주입
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  } else {
    await finalizeAll();
  }
}

// ── 스크롤 시 새 영역 캡처 ────────────────────────────────────────────────────
async function handleScrollCapture(tabId, windowId, msg) {
  if (!isCapturing) return;

  const state = tabCaptures.get(tabId);
  if (!state) return;

  const { scrollY, scrollHeight, viewportH, viewportW, dpr } = msg;
  const last = state.captures[state.captures.length - 1];

  // 이전 캡처 하단에서 50px 이상 새 영역이 보일 때만 캡처
  if (last && scrollY + viewportH <= last.scrollY + last.viewportH + 50) return;

  await doCapture(tabId, windowId || state.windowId, scrollY, scrollHeight, viewportH, viewportW, dpr);
}

// ── 스크린샷 촬영 ─────────────────────────────────────────────────────────────
async function doCapture(tabId, windowId, scrollY, scrollHeight, viewportH, viewportW, dpr) {
  try {
    const tab = await chrome.tabs.get(tabId);

    // 해당 탭이 현재 활성 탭인지 확인 (다른 탭으로 이미 이동했으면 캡처 불가)
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!activeTab || activeTab.id !== tabId) {
      console.log(`[QA] skip: tab ${tabId} is no longer active`);
      return;
    }

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

// ── 탭 완료 처리 (캡처 조각 → 합성 → 저장) ───────────────────────────────────
async function finalizeTab(tabId) {
  const state = tabCaptures.get(tabId);
  tabCaptures.delete(tabId);

  if (!state || state.captures.length === 0) return;

  console.log(`[QA] finalizing tab=${tabId} pieces=${state.captures.length}`);

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
  console.log(`[QA] saved record for "${record.title}"`);
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

  const first = captures[0];
  const dpr = first.dpr || 1;

  const totalCssH = captures.reduce((m, c) => Math.max(m, c.scrollY + c.viewportH), 0);
  const scale = Math.min(dpr, 32000 / totalCssH);

  const canvasW = Math.round(first.viewportW * scale);
  const canvasH = Math.round(totalCssH * scale);

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

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── 탭 이벤트 ─────────────────────────────────────────────────────────────────

// 탭 전환: 이전 탭 완료, 새 탭 캡처 시작
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // 이전 탭 finalize
  if (prevTabId && prevTabId !== tabId && tabCaptures.has(prevTabId)) {
    await finalizeTab(prevTabId);
  }
  prevTabId = tabId;

  if (!isCapturing) return;

  // 새 탭 상태 초기화
  tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });

  // 탭 렌더링 대기 후 캡처
  setTimeout(async () => {
    const scrollInfo = await getScrollInfo(tabId);
    await doCapture(tabId, windowId, scrollInfo.scrollY, scrollInfo.scrollHeight, scrollInfo.viewportH, scrollInfo.viewportW, scrollInfo.dpr);
  }, 400);
});

// 페이지 이동(URL 변경): 기존 캡처 완료 후 새로 시작
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  if (tabCaptures.has(tabId)) {
    await finalizeTab(tabId);
  }

  if (!isCapturing) return;

  tabCaptures.set(tabId, { windowId: tab.windowId, url: tab.url, title: tab.title, captures: [] });

  setTimeout(async () => {
    const scrollInfo = await getScrollInfo(tabId);
    await doCapture(tabId, tab.windowId, scrollInfo.scrollY, scrollInfo.scrollHeight, scrollInfo.viewportH, scrollInfo.viewportW, scrollInfo.dpr);
  }, 600);
});

// 탭 닫힘
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabCaptures.has(tabId)) {
    await finalizeTab(tabId);
  }
});

// ── content script에서 스크롤 정보 가져오기 ──────────────────────────────────
function getScrollInfo(tabId) {
  return new Promise(resolve => {
    const fallback = { scrollY: 0, scrollHeight: 0, viewportH: 900, viewportW: 1440, dpr: 1 };
    chrome.tabs.sendMessage(tabId, { type: 'GET_SCROLL_INFO' }, resp => {
      if (chrome.runtime.lastError || !resp) {
        resolve(fallback);
      } else {
        resolve(resp);
      }
    });
  });
}
