// ── 상태 ──────────────────────────────────────────────────────────────────────
let isCapturing = false;
const tabCaptures = new Map(); // tabId → { windowId, url, title, captures[], scanning }
let prevTabId = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 서비스 워커 재시작 시 캡처 상태 복원
chrome.storage.local.get('isCapturing').then(({ isCapturing: v }) => {
  isCapturing = !!v;
});

// ── 메시지 핸들러 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  if (msg.type === 'SCROLL_CHANGED' && tabId) {
    chrome.storage.local.get('isCapturing').then(({ isCapturing: v }) => {
      if (v) handleScrollCapture(tabId, windowId, msg);
    });
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

// ── 수동 스크롤 감지 → 캡처 ───────────────────────────────────────────────────
async function handleScrollCapture(tabId, windowId, msg) {
  if (!tabCaptures.has(tabId)) {
    tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });
  }
  const state = tabCaptures.get(tabId);
  if (state.scanning) return; // 자동 스캔 중에는 수동 스크롤 무시

  const { scrollY, scrollHeight, viewportH, viewportW, dpr } = msg;
  await doCapture(tabId, windowId || state.windowId, scrollY, scrollHeight, viewportH, viewportW, dpr);
}

// ── 페이지 전체 자동 스캔 (윈도우 + 내부 스크롤) ──────────────────────────────
async function fullPageScan(tabId, windowId) {
  if (!tabCaptures.has(tabId)) {
    tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });
  }
  const state = tabCaptures.get(tabId);
  state.scanning = true;

  try {
    // 1. 윈도우 스크롤 전체 스캔
    await windowScan(tabId, windowId);

    // 2. 내부 스크롤 요소 스캔
    await innerScan(tabId, windowId);

    // 3. 맨 위로 복귀
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.scrollTo(0, 0),
      args: [],
    }).catch(() => {});
  } finally {
    state.scanning = false;
  }
}

// 윈도우 스크롤 전체 스캔
async function windowScan(tabId, windowId) {
  const info = await getScrollInfo(tabId);
  const { scrollHeight, viewportH, viewportW, dpr } = info;

  const positions = [];
  for (let y = 0; y + viewportH <= scrollHeight; y += viewportH) {
    positions.push(y);
  }
  const bottom = Math.max(0, scrollHeight - viewportH);
  if (positions.length === 0 || positions[positions.length - 1] < bottom) {
    positions.push(bottom);
  }

  for (const y of positions) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sy) => window.scrollTo(0, sy),
      args: [y],
    }).catch(() => {});
    await sleep(200);
    const actual = await getScrollInfo(tabId);
    await doCapture(tabId, windowId, actual.scrollY, actual.scrollHeight, viewportH, viewportW, dpr);
  }
}

// 내부 스크롤 요소 스캔
async function innerScan(tabId, windowId) {
  // 스크롤 가능한 내부 요소 탐색 및 임시 인덱스 부여
  let elements = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let i = 0;
        const list = [];
        for (const el of document.querySelectorAll('*')) {
          if (el === document.body || el === document.documentElement) continue;
          const s = getComputedStyle(el);
          const canScroll = (s.overflowY === 'scroll' || s.overflowY === 'auto')
            && el.scrollHeight > el.clientHeight + 5
            && el.clientHeight > 50;
          if (canScroll) {
            el.setAttribute('data-qa-scan', i);
            list.push({ idx: i++, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
          }
        }
        return list;
      },
    });
    elements = res?.result ?? [];
  } catch (e) { return; }

  if (elements.length === 0) return;

  const { viewportH, viewportW, dpr, scrollHeight: pageScrollHeight } = await getScrollInfo(tabId);

  for (const { idx, scrollHeight, clientHeight } of elements) {
    const positions = [];
    for (let y = 0; y + clientHeight <= scrollHeight; y += clientHeight) {
      positions.push(y);
    }
    const bottom = Math.max(0, scrollHeight - clientHeight);
    if (positions.length === 0 || positions[positions.length - 1] < bottom) {
      positions.push(bottom);
    }

    for (const y of positions) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (i, top) => {
          const el = document.querySelector(`[data-qa-scan="${i}"]`);
          if (el) el.scrollTop = top;
        },
        args: [idx, y],
      }).catch(() => {});
      await sleep(200);
      const actual = await getScrollInfo(tabId);
      await doCapture(tabId, windowId, actual.scrollY, pageScrollHeight, viewportH, viewportW, dpr);
    }

    // 요소 맨 위로 복귀
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (i) => { const el = document.querySelector(`[data-qa-scan="${i}"]`); if (el) el.scrollTop = 0; },
      args: [idx],
    }).catch(() => {});
  }

  // 임시 마킹 제거
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.querySelectorAll('[data-qa-scan]').forEach(el => el.removeAttribute('data-qa-scan')),
  }).catch(() => {});
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
    const last = state.captures[state.captures.length - 1];

    // scrollY가 같으면 내부 스크롤로 간주 → 직전 캡처 아래에 이어붙이기
    const stitchY = (last && scrollY === last.scrollY)
      ? last.stitchY + last.viewportH
      : scrollY;

    // 직전과 완전히 동일한 위치면 중복 스킵
    if (last && last.scrollY === scrollY && last.stitchY === stitchY) return;

    state.url = tab.url;
    state.title = tab.title;
    state.windowId = tab.windowId;
    state.captures.push({ scrollY, stitchY, scrollHeight, viewportH, viewportW, dpr, dataUrl });

    console.log(`[QA] captured tab=${tabId} scrollY=${scrollY} stitchY=${stitchY} total=${state.captures.length}`);
  } catch (e) {
    console.warn('[QA] captureVisibleTab error:', e.message);
  }
}

// ── 탭 완료 처리 (캡처 조각 → 합성 → 저장) ───────────────────────────────────
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
  const existingIdx = history.findIndex(h => h.url === record.url);
  if (existingIdx !== -1) history.splice(existingIdx, 1);
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

  const { viewportW, dpr } = captures[0];
  const totalCssH = captures.reduce((m, c) => Math.max(m, c.stitchY + c.viewportH), 0);
  const scale = Math.min(dpr || 1, 32000 / totalCssH);

  const canvasW = Math.round(viewportW * scale);
  const canvasH = Math.round(totalCssH * scale);

  const offscreen = new OffscreenCanvas(canvasW, canvasH);
  const ctx = offscreen.getContext('2d');

  const sorted = [...captures].sort((a, b) => a.stitchY - b.stitchY);
  for (const cap of sorted) {
    const resp = await fetch(cap.dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, Math.round(cap.stitchY * scale));
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
  await fullPageScan(tabId, windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (tabCaptures.has(tabId)) await finalizeTab(tabId);
  if (!isCapturing) return;

  tabCaptures.set(tabId, { windowId: tab.windowId, url: tab.url, title: tab.title, captures: [] });

  await sleep(600);
  await fullPageScan(tabId, tab.windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabCaptures.has(tabId)) await finalizeTab(tabId);
});
