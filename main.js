'use strict';

const SUPABASE_URL = 'https://snjexfohyklviarxprvm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_c_1296S0EE8eHZO2EHnTIg_F2v4mov9';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let allCaptures = [];
let realtimeChannel = null;

// ── 초기화 ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  bindAuthEvents();
  bindDashboardEvents();

  const { data: { session } } = await db.auth.getSession();
  if (session) {
    currentUser = session.user;
    showDashboard();
    await loadCaptures();
    subscribeRealtime();
  } else {
    showAuth();
  }

  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && !currentUser) {
      currentUser = session.user;
      showDashboard();
      loadCaptures();
      subscribeRealtime();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      allCaptures = [];
      if (realtimeChannel) { db.removeChannel(realtimeChannel); realtimeChannel = null; }
      showAuth();
    }
  });
});

// ── 인증 ───────────────────────────────────────────────────────────────────
let authMode = 'login';

function bindAuthEvents() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === authMode));
      document.getElementById('auth-submit').textContent = authMode === 'login' ? '로그인' : '회원가입';
      document.getElementById('auth-name-wrap').classList.toggle('hidden', authMode === 'login');
      document.getElementById('auth-error').classList.add('hidden');
      document.getElementById('auth-notice').classList.add('hidden');
    });
  });

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-error');
    const noticeEl = document.getElementById('auth-notice');
    const btn = document.getElementById('auth-submit');

    errEl.classList.add('hidden');
    noticeEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = authMode === 'login' ? '로그인 중…' : '가입 중…';

    try {
      if (authMode === 'login') {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const name = document.getElementById('auth-name').value.trim() || email.split('@')[0];
        const { error } = await db.auth.signUp({
          email, password,
          options: { data: { display_name: name } },
        });
        if (error) throw error;
        noticeEl.textContent = '가입 완료! 이메일 인증 링크를 확인하거나, 이메일 인증이 비활성화된 경우 바로 로그인하세요.';
        noticeEl.classList.remove('hidden');
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === 'login' ? '로그인' : '회원가입';
    }
  });
}

// ── 대시보드 이벤트 ────────────────────────────────────────────────────────
function bindDashboardEvents() {
  document.getElementById('btn-logout').addEventListener('click', () => db.auth.signOut());
  document.getElementById('search').addEventListener('input', renderFiltered);
  document.getElementById('filter-user').addEventListener('change', renderFiltered);
  document.getElementById('btn-dl-zip').addEventListener('click', downloadZip);
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('ext-modal').classList.add('hidden');
  });
}

// ── 캡처 목록 로드 ─────────────────────────────────────────────────────────
async function loadCaptures() {
  setLoading(true);
  try {
    const { data, error } = await db
      .from('captures')
      .select('*')
      .order('captured_at', { ascending: false });

    if (error) throw error;
    allCaptures = data || [];
    buildUserFilter();
    renderFiltered();
  } catch (err) {
    console.error('[QASS]', err.message);
  } finally {
    setLoading(false);
  }
}

function buildUserFilter() {
  const users = [...new Set(allCaptures.map(c => c.user_email).filter(Boolean))];
  const select = document.getElementById('filter-user');
  const prev = select.value;
  select.innerHTML = '<option value="">전체 사용자</option>';
  users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u;
    if (u === prev) opt.selected = true;
    select.appendChild(opt);
  });
}

// ── 실시간 구독 ────────────────────────────────────────────────────────────
function subscribeRealtime() {
  realtimeChannel = db.channel('captures-realtime')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'captures' }, payload => {
      allCaptures.unshift(payload.new);
      buildUserFilter();
      renderFiltered();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'captures' }, payload => {
      allCaptures = allCaptures.filter(c => c.id !== payload.old.id);
      renderFiltered();
    })
    .subscribe(status => {
      document.getElementById('realtime-badge').classList.toggle('hidden', status !== 'SUBSCRIBED');
    });
}

// ── 렌더링 ─────────────────────────────────────────────────────────────────
function renderFiltered() {
  const search = document.getElementById('search').value.toLowerCase();
  const filterUser = document.getElementById('filter-user').value;

  const filtered = allCaptures.filter(c => {
    const matchSearch = !search ||
      (c.title || '').toLowerCase().includes(search) ||
      (c.url || '').toLowerCase().includes(search);
    const matchUser = !filterUser || c.user_email === filterUser;
    return matchSearch && matchUser;
  });

  document.getElementById('count-label').textContent = `${filtered.length}건`;
  renderGrid(filtered);
}

function renderGrid(captures) {
  const grid = document.getElementById('captures-grid');
  grid.innerHTML = '';

  if (captures.length === 0) {
    grid.innerHTML = '<div class="empty-state">캡처된 증적이 없습니다.</div>';
    return;
  }

  captures.forEach(cap => {
    const card = document.createElement('div');
    card.className = 'capture-card';

    const imgUrl = getPublicUrl(cap.image_path);
    const isMe = cap.user_id === currentUser?.id;
    const displayName = cap.user_display_name || cap.user_email || '—';
    const time = cap.captured_at ? new Date(cap.captured_at).toLocaleString('ko-KR') : '—';

    card.innerHTML = `
      <div class="card-thumb" style="background-image:url('${esc(imgUrl)}')" title="클릭하면 원본 이미지 열기"></div>
      <div class="card-body">
        <div class="card-title" title="${esc(cap.title || '')}">${esc(cap.title || '—')}</div>
        <div class="card-url" title="${esc(cap.url || '')}">${esc(cap.url || '—')}</div>
        <div class="card-meta">
          <span class="badge-user${isMe ? ' me' : ''}">${esc(displayName)}</span>
          <span class="card-time">${time}</span>
          ${cap.capture_count > 1 ? `<span class="card-pieces">${cap.capture_count}조각</span>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-sm" data-action="view">보기</button>
        <button class="btn-sm btn-primary" data-action="dl">저장</button>
        ${isMe ? '<button class="btn-sm btn-danger" data-action="del">삭제</button>' : ''}
      </div>
    `;

    card.querySelector('.card-thumb').addEventListener('click', () => openCapture(imgUrl));
    card.querySelector('[data-action="view"]').addEventListener('click', () => openCapture(imgUrl));
    card.querySelector('[data-action="dl"]').addEventListener('click', () => downloadCapture(cap));
    card.querySelector('[data-action="del"]')?.addEventListener('click', () => deleteCapture(cap));

    grid.appendChild(card);
  });
}

// ── 이미지 URL ─────────────────────────────────────────────────────────────
function getPublicUrl(path) {
  if (!path) return '';
  const { data } = db.storage.from('qa-captures').getPublicUrl(path);
  return data.publicUrl;
}

// ── 액션 ───────────────────────────────────────────────────────────────────
function openCapture(url) {
  window.open(url, '_blank');
}

async function downloadCapture(cap) {
  const url = getPublicUrl(cap.image_path);
  const res = await fetch(url);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = makeFileName(cap.title, cap.captured_at);
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadZip() {
  const search = document.getElementById('search').value.toLowerCase();
  const filterUser = document.getElementById('filter-user').value;
  const filtered = allCaptures.filter(c => {
    const matchSearch = !search ||
      (c.title || '').toLowerCase().includes(search) ||
      (c.url || '').toLowerCase().includes(search);
    return matchSearch && (!filterUser || c.user_email === filterUser);
  });

  if (!filtered.length) return;
  setLoading(true);

  try {
    const zip = new JSZip();
    for (const cap of filtered) {
      const res = await fetch(getPublicUrl(cap.image_path));
      const blob = await res.blob();
      zip.file(makeFileName(cap.title, cap.captured_at), blob);
    }
    const content = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content);
    a.download = `QASS_증적_${new Date().toLocaleDateString('ko-KR').replace(/\.\s*/g, '-').replace(/-$/, '')}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert('ZIP 생성 실패: ' + err.message);
  } finally {
    setLoading(false);
  }
}

async function deleteCapture(cap) {
  if (!confirm(`"${cap.title || cap.url}" 캡처를 삭제할까요?`)) return;
  setLoading(true);
  try {
    if (cap.image_path) {
      await db.storage.from('qa-captures').remove([cap.image_path]);
    }
    const { error } = await db.from('captures').delete().eq('id', cap.id);
    if (error) throw error;
    allCaptures = allCaptures.filter(c => c.id !== cap.id);
    renderFiltered();
  } catch (err) {
    alert('삭제 실패: ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ── 유틸 ───────────────────────────────────────────────────────────────────
function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  const name = currentUser?.user_metadata?.display_name || currentUser?.email || '';
  document.getElementById('user-email').textContent = name;
}

function setLoading(v) {
  document.getElementById('loading').classList.toggle('hidden', !v);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = new Date(timestamp || Date.now())
    .toLocaleString('ko-KR').replace(/[^0-9]/g, '').slice(0, 14);
  return `QA_${safe}_${ts}.png`;
}
