'use strict';

const SUPABASE_URL = 'https://snjexfohyklviarxprvm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_c_1296S0EE8eHZO2EHnTIg_F2v4mov9';

let isCapturing = false;
let cachedHistory = [];

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-toggle').addEventListener('click', onToggle);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('btn-dl-all').addEventListener('click', onDownloadAll);
  document.getElementById('btn-ext-login').addEventListener('click', onExtLogin);
  document.getElementById('btn-ext-logout').addEventListener('click', onExtLogout);

  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  isCapturing = resp.isCapturing;
  updateUI();
  await loadHistory();
  await updateCloudUI();
});

// ── 클라우드 인증 UI ──────────────────────────────────────────────────────────
async function updateCloudUI() {
  const { supabaseSession } = await chrome.storage.local.get('supabaseSession');
  const loggedIn = !!supabaseSession?.user;
  document.getElementById('cloud-logged-in').classList.toggle('hidden', !loggedIn);
  document.getElementById('cloud-login-form').classList.toggle('hidden', loggedIn);
  if (loggedIn) {
    const label = supabaseSession.user.user_metadata?.display_name || supabaseSession.user.email;
    document.getElementById('cloud-user-label').textContent = label;
  }
}

async function onExtLogin() {
  const email = document.getElementById('ext-email').value.trim();
  const password = document.getElementById('ext-password').value;
  const errEl = document.getElementById('ext-auth-error');
  const btn = document.getElementById('btn-ext-login');
  errEl.classList.add('hidden');

  if (!email || !password) return;

  btn.textContent = '로그인 중…';
  btn.disabled = true;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || '로그인 실패');

    await chrome.storage.local.set({
      supabaseSession: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user,
      },
    });
    await updateCloudUI();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.textContent = '로그인';
    btn.disabled = false;
  }
}

async function onExtLogout() {
  await chrome.storage.local.remove('supabaseSession');
  await updateCloudUI();
}

// ── 캡처 토글 ─────────────────────────────────────────────────────────────────
async function onToggle() {
  isCapturing = !isCapturing;
  await chrome.runtime.sendMessage({ type: 'SET_CAPTURING', value: isCapturing });
  updateUI();
  if (!isCapturing) {
    setTimeout(loadHistory, 1200);
  }
}

async function onClear() {
  if (!confirm('캡처 기록을 모두 삭제할까요?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  cachedHistory = [];
  renderList([]);
}

async function onDownloadAll() {
  if (!cachedHistory.length) return;
  cachedHistory.forEach((rec, i) => {
    setTimeout(() => triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp)), i * 400);
  });
}

// ── UI 갱신 ───────────────────────────────────────────────────────────────────
function updateUI() {
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

// ── 히스토리 로드 & 렌더링 ────────────────────────────────────────────────────
async function loadHistory() {
  cachedHistory = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  renderList(cachedHistory);
}

function renderList(history) {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!history || history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = '캡처된 페이지가 없습니다.';
    list.appendChild(empty);
    return;
  }

  history.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'capture-item';

    const header = document.createElement('div');
    header.className = 'item-header';

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const titleEl = document.createElement('div');
    titleEl.className = 'item-title';
    titleEl.textContent = rec.title;
    titleEl.title = rec.title;

    const urlEl = document.createElement('div');
    urlEl.className = 'item-url';
    urlEl.textContent = rec.url;
    urlEl.title = rec.url;

    const infoEl = document.createElement('div');
    infoEl.className = 'item-info';
    infoEl.textContent = rec.timestamp + ' · ' + rec.captureCount + '개 조각';

    // 클라우드 업로드 상태 배지
    const badge = document.createElement('span');
    badge.className = 'cloud-badge';
    if (rec.uploaded === true) {
      badge.className += ' uploaded';
      badge.textContent = '☁ 업로드됨';
    } else if (rec.uploading) {
      badge.className += ' uploading';
      badge.textContent = '↑ 업로드 중';
    } else if (rec.uploadFailed) {
      badge.className += ' failed';
      badge.textContent = '✕ 업로드 실패';
    }
    if (rec.uploaded || rec.uploading || rec.uploadFailed) {
      infoEl.appendChild(badge);
    }

    meta.appendChild(titleEl);
    meta.appendChild(urlEl);
    meta.appendChild(infoEl);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnView = document.createElement('button');
    btnView.textContent = '전체 보기';
    btnView.addEventListener('click', () => openFullView(rec.id));

    const btnDl = document.createElement('button');
    btnDl.textContent = '저장';
    btnDl.addEventListener('click', () => onDownloadOne(rec.id));

    actions.appendChild(btnView);
    actions.appendChild(btnDl);

    header.appendChild(meta);
    header.appendChild(actions);

    const img = document.createElement('img');
    img.src = rec.dataUrl;
    img.className = 'item-thumb';
    img.alt = rec.title;
    img.title = '클릭하면 전체 이미지를 새 탭에서 봅니다';
    img.addEventListener('click', () => openFullView(rec.id));

    item.appendChild(header);
    item.appendChild(img);
    list.appendChild(item);
  });
}

// ── 전체 이미지 보기 ──────────────────────────────────────────────────────────
function openFullView(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  fetch(rec.dataUrl)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url });
    });
}

// ── 다운로드 ──────────────────────────────────────────────────────────────────
function onDownloadOne(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp));
}

function triggerDownload(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = (timestamp || '').replace(/[^0-9]/g, '').slice(0, 14);
  return 'QA_' + safe + '_' + ts + '.png';
}
