// 페이지 정보 반환 및 스크롤 감지

let scrollDebounceTimer = null;
let lastReportedScrollY = -1;

function getScrollInfo() {
  return {
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  };
}

// 스크롤 멈춘 후 200ms 뒤 background에 보고
window.addEventListener('scroll', () => {
  clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(() => {
    const info = getScrollInfo();
    if (info.scrollY !== lastReportedScrollY) {
      lastReportedScrollY = info.scrollY;
      try {
        chrome.runtime.sendMessage({ type: 'SCROLL_CHANGED', ...info }).catch(() => {});
      } catch (_) {}
    }
  }, 200);
}, { passive: true });

// background의 요청에 응답
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_SCROLL_INFO') {
    sendResponse(getScrollInfo());
  }
});
