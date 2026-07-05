const $ = (selector, root = document) => root.querySelector(selector);

const cookiesMeta = $('#cookiesMeta');
const cookiesInput = $('#cookiesInput');
const cacheTable = $('#cacheTable');
const pageInfo = $('#pageInfo');
const prevPageBtn = $('#prevPageBtn');
const nextPageBtn = $('#nextPageBtn');
const pageSizeSelect = $('#pageSizeSelect');
const previewModal = $('#previewModal');
const previewVideo = $('#previewVideo');
const previewTitle = $('#previewTitle');
const previewMeta = $('#previewMeta');
const historySummary = $('#historySummary');
const historyList = $('#historyList');
const elderIdInput = $('#elderIdInput');
const toastEl = $('#toast');
let adminStream = null;
const cachePager = {
  page: 1,
  pageSize: Number(localStorage.getItem('adminCachePageSize') || 10),
  total: 0,
  totalPages: 1
};

$('#saveCookiesBtn').addEventListener('click', saveCookies);
$('#refreshCacheBtn').addEventListener('click', loadCacheVideos);
$('#discoverBtn').addEventListener('click', discoverVideos);
$('#loadHistoryBtn').addEventListener('click', loadHistory);
$('#addVideoForm').addEventListener('submit', addVideo);
prevPageBtn.addEventListener('click', () => changeCachePage(cachePager.page - 1));
nextPageBtn.addEventListener('click', () => changeCachePage(cachePager.page + 1));
pageSizeSelect.addEventListener('change', () => {
  cachePager.pageSize = Number(pageSizeSelect.value || 10);
  localStorage.setItem('adminCachePageSize', String(cachePager.pageSize));
  changeCachePage(1);
});
$('#closePreviewBtn').addEventListener('click', closePreview);
previewModal.addEventListener('click', (event) => {
  if (event.target === previewModal) closePreview();
});

init().catch((err) => {
  console.error(err);
  toast(`后台初始化失败：${err.message}`);
});

async function init() {
  pageSizeSelect.value = String(cachePager.pageSize);
  await Promise.all([loadCookiesMeta(), loadCacheVideos(), loadHistory()]);
  startAdminStream();
}

async function loadCookiesMeta() {
  const data = await api('/api/admin/cookies');
  const item = data.item;
  cookiesMeta.textContent = item.exists
    ? `已保存：${item.relativePath}，${formatBytes(item.bytes)}，更新于 ${formatTime(item.updatedAt)}`
    : `尚未保存，将写入 ${item.relativePath}`;
}

async function saveCookies() {
  const cookies = cookiesInput.value.trim();
  if (!cookies) return toast('请先粘贴 cookies 内容');
  await api('/api/admin/cookies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies })
  });
  cookiesInput.value = '';
  await loadCookiesMeta();
  toast('cookies 已保存');
}

async function loadCacheVideos() {
  const data = await api(`/api/admin/cache/videos?page=${cachePager.page}&pageSize=${cachePager.pageSize}`);
  cachePager.page = data.page || 1;
  cachePager.pageSize = data.pageSize || cachePager.pageSize;
  cachePager.total = data.total || 0;
  cachePager.totalPages = data.totalPages || 1;
  renderPager();
  cacheTable.innerHTML = (data.items || []).map((item) => `
    <tr>
      <td>
        <div class="video-title">${escapeHtml(item.title || item.id)}</div>
        <div class="small">${escapeHtml(item.id)}</div>
        ${item.sourceUrl ? `<div class="small">${escapeHtml(item.sourceUrl)}</div>` : ''}
      </td>
      <td>
        <span class="badge ${escapeHtml(item.cacheState)}">${escapeHtml(item.cacheState)}</span>
        <span class="badge ${escapeHtml(item.audienceState || 'active')}">${escapeHtml(item.audienceState || 'active')}</span>
        ${item.cacheError ? `<div class="small">${escapeHtml(item.cacheError)}</div>` : ''}
      </td>
      <td>
        <div>${Math.round(Number(item.viewedRatio || 0) * 100)}%</div>
        <div class="small">${Number(item.viewedByCount || 0)} 人看过</div>
      </td>
      <td>
        <div>${item.fileExists ? '存在' : '无文件'} · ${formatBytes(item.bytes)}</div>
        <div class="small">${escapeHtml(item.fileName)}</div>
      </td>
      <td>${renderJob(item.latestJob)}</td>
      <td class="actions-cell">
        <button class="secondary" data-action="preview" data-url="${escapeAttr(item.url || '')}" data-title="${escapeAttr(item.title || item.id)}" data-meta="${escapeAttr(`${item.id} · ${formatBytes(item.bytes)} · ${item.cacheState}`)}" ${item.url ? '' : 'disabled'}>预览</button>
        <button class="secondary" data-action="prefetch" data-id="${escapeAttr(item.id)}">缓存</button>
        <button class="danger" data-action="delete" data-id="${escapeAttr(item.id)}">删除缓存</button>
        <button class="danger" data-action="delete-video" data-id="${escapeAttr(item.id)}" data-title="${escapeAttr(item.title || item.id)}">完全删除</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6">暂无视频</td></tr>';
}

function renderPager() {
  pageInfo.textContent = `第 ${cachePager.page} / ${cachePager.totalPages} 页，共 ${cachePager.total} 条，按最新更新倒序`;
  prevPageBtn.disabled = cachePager.page <= 1;
  nextPageBtn.disabled = cachePager.page >= cachePager.totalPages;
}

async function changeCachePage(page) {
  cachePager.page = Math.max(1, Math.min(cachePager.totalPages || 1, page));
  await loadCacheVideos();
  startAdminStream();
}

async function addVideo(event) {
  event.preventDefault();
  const sourceUrl = $('#newVideoUrl').value.trim();
  const title = $('#newVideoTitle').value.trim();
  if (!sourceUrl) return toast('请先粘贴视频链接');
  await api('/api/admin/cache/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUrl, title })
  });
  $('#newVideoUrl').value = '';
  $('#newVideoTitle').value = '';
  toast('已添加并加入缓存队列');
  await loadCacheVideos();
}

async function discoverVideos() {
  $('#discoverBtn').disabled = true;
  try {
    const data = await api('/api/admin/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elderId: elderIdInput.value.trim() || 'default', limit: 5 })
    });
    toast(`自动发现完成：新增 ${data.result?.added || 0}，入队 ${data.result?.queued || 0}`);
    await loadCacheVideos();
  } finally {
    $('#discoverBtn').disabled = false;
  }
}

cacheTable.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === 'preview') {
    openPreview(button.dataset.url, button.dataset.title, button.dataset.meta);
    return;
  }
  if (button.dataset.action === 'prefetch') {
    await api(`/api/admin/cache/videos/${encodeURIComponent(id)}/prefetch`, { method: 'POST' });
    toast('已加入缓存队列');
    await loadCacheVideos();
  }
  if (button.dataset.action === 'delete') {
    if (!confirm(`确定删除 ${id} 的服务器缓存文件吗？`)) return;
    await api(`/api/admin/cache/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('缓存已删除');
    await loadCacheVideos();
  }
  if (button.dataset.action === 'delete-video') {
    const title = button.dataset.title || id;
    if (!confirm(`确定完全删除这个视频吗？\n\n${title}\n\n会删除视频记录、缓存文件和相关缓存任务。`)) return;
    await api(`/api/admin/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('视频已完全删除');
    await loadCacheVideos();
  }
});

function openPreview(url, title, meta) {
  if (!url) return toast('这个视频还没有可预览的缓存文件');
  previewTitle.textContent = title || '视频预览';
  previewMeta.textContent = meta || url;
  previewVideo.src = url;
  previewModal.classList.remove('hidden');
  previewVideo.play().catch(() => {});
}

function closePreview() {
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewVideo.load();
  previewModal.classList.add('hidden');
}

async function loadHistory() {
  const elderId = elderIdInput.value.trim() || 'default';
  const data = await api(`/api/admin/history?elderId=${encodeURIComponent(elderId)}`);
  const summary = data.summary || {};
  historySummary.innerHTML = `
    <span class="badge">观看 ${summary.watchCount || 0}</span>
    <span class="badge">喜欢 ${summary.likedCount || 0}</span>
    <span class="badge">收藏 ${summary.favoritesCount || 0}</span>
    ${(summary.topTags || []).map((item) => `<span class="badge">#${escapeHtml(item.tag)} ${item.score}</span>`).join('')}
  `;
  historyList.innerHTML = (data.events || []).slice(0, 80).map((event) => `
    <div class="history-item">
      <div><span class="badge">${escapeHtml(event.type)}</span> ${escapeHtml(event.title)}</div>
      <div class="history-meta">${formatTime(event.at)} · value=${escapeHtml(event.value)} · ${escapeHtml((event.tags || []).join(', '))}</div>
    </div>
  `).join('') || '<p class="muted">暂无浏览事件。</p>';
}

async function api(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

function renderJob(job) {
  if (!job) return '<span class="small">暂无任务</span>';
  return `
    <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
    <div class="small">${Math.round(Number(job.progress || 0) * 100)}% · ${escapeHtml(job.message || '')}</div>
    <div class="small">${formatTime(job.updatedAt || job.createdAt)}</div>
  `;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(input) {
  if (!input) return '-';
  return new Date(input).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.add('hidden'), 1800);
}

function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

function escapeAttr(input) {
  return escapeHtml(input).replace(/`/g, '&#96;');
}

function startAdminStream() {
  if (!('EventSource' in window)) return;
  if (adminStream) adminStream.close();

  let refreshing = false;
  adminStream = new EventSource(`/api/admin/stream?page=${cachePager.page}&pageSize=${cachePager.pageSize}`);
  adminStream.addEventListener('cache', async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await loadCacheVideos();
    } catch (err) {
      console.warn('admin auto refresh failed', err);
    } finally {
      refreshing = false;
    }
  });
  adminStream.onerror = () => {
    console.warn('admin stream disconnected; browser will retry');
  };
}
