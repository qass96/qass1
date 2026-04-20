// 페이지 정보 반환 및 스크롤 감지

let scrollDebounceTimer = null;

function getScrollInfo() {
  return {
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  };
}

// capture: true → window 및 내부 div 등 모든 스크롤 영역 감지
document.addEventListener('scroll', (event) => {
  // window/document 스크롤이 아닌 내부 요소 스크롤 여부 판별
  const isInner = event.target !== document && event.target !== document.documentElement;
  clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(() => {
    const info = getScrollInfo();
    try {
      chrome.runtime.sendMessage({ type: 'SCROLL_CHANGED', ...info, isInner }).catch(() => {});
    } catch (_) {}
  }, 200);
}, { passive: true, capture: true });

// background의 요청에 응답
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_SCROLL_INFO') {
    sendResponse(getScrollInfo());
  }
});
