// popup/popup.js
// 插件弹窗：嗅探视图（候选流） + 缓存视图（已缓存视频，可重新打开 / 清空）
(() => {
  const listEl = document.getElementById('list');
  const subtitle = document.getElementById('subtitle');
  let activeView = 'sniff';

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function fmtDuration(s) {
    if (!s || s <= 0) return '';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.round(s % 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function render() {
    listEl.innerHTML = '<div class="loading-msg">加载中…</div>';
    if (activeView === 'sniff') await renderSniff();
    else await renderCache();
  }

  // ── 嗅探视图 ──
  async function renderSniff() {
    subtitle.textContent = '当前页嗅探结果';
    const tab = await getActiveTab();
    if (!tab) { showEmpty('未获取到当前标签页'); return; }
    const resp = await chrome.runtime.sendMessage({ type: 'LIST_STREAMS', tabId: tab.id });
    const streams = (resp && resp.ok && resp.streams) || [];
    if (!streams.length) { showEmpty('未检测到视频流', '播放网页中的 HLS 视频后，列表会实时出现候选流'); return; }

    listEl.innerHTML = '';
    streams.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'item';
      const badges = [];
      if (s.live) badges.push('<span class="badge live">直播</span>');
      else if (!s.isMaster) badges.push('<span class="badge">点播</span>');
      if (s.isMaster) badges.push('<span class="badge master">多码率</span>');
      if (s.encrypted) badges.push('<span class="badge">加密</span>');
      const meta = [];
      if (s.totalDuration) meta.push(`时长 ${fmtDuration(s.totalDuration)}`);
      if (s.domain) meta.push(s.domain);
      item.innerHTML = `
        <div class="row">${badges.join('')}<span class="url" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</span></div>
        <div class="meta">${meta.join('<span>·</span>')}</div>
        <div class="play">在独立标签页播放 →</div>`;
      item.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({
          type: 'OPEN_PLAYER', stream: { url: s.url, domain: s.domain, live: s.live }, title: tab.title || '',
        });
        window.close();
      });
      listEl.append(item);
    });
  }

  // ── 缓存视图 ──
  async function renderCache() {
    subtitle.textContent = '已缓存视频（关闭播放页即清理）';
    const resp = await chrome.runtime.sendMessage({ type: 'LIST_CACHED' });
    const videos = (resp && resp.ok && resp.videos) || [];
    if (!videos.length) { showEmpty('暂无缓存', '在独立标签页播放视频后，分片会写入会话缓存'); return; }

    listEl.innerHTML = '';
    videos.forEach((v) => {
      const item = document.createElement('div');
      item.className = 'item';
      const pct = v.segmentCount ? Math.round(v.done / v.segmentCount * 100) : 0;
      const meta = [`${v.done}/${v.segmentCount} 分片 · ${pct}%`, v.domain || '—'];
      if (v.totalDuration) meta.unshift(`时长 ${fmtDuration(v.totalDuration)}`);
      item.innerHTML = `
        <div class="row"><span class="url" title="${escapeHtml(v.title)}">${escapeHtml(v.title || '未命名')}</span></div>
        <div class="meta">${meta.join('<span>·</span>')}</div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
        <div class="play">重新打开并继续缓存 →</div>`;
      item.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({
          type: 'OPEN_PLAYER', stream: { url: v.m3u8Url, domain: v.domain, live: v.live }, title: v.title || '',
        });
        window.close();
      });
      listEl.append(item);
    });
  }

  function showEmpty(p, sub) {
    listEl.innerHTML = `<div class="empty"><p>${escapeHtml(p)}</p><span>${escapeHtml(sub || '')}</span></div>`;
  }

  // ── 事件 ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      if (tab.dataset.clear) {
        if (!confirm('确定清空所有缓存分片？')) return;
        await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
        activeView = 'cache';
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        render(); return;
      }
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeView = tab.dataset.view;
      render();
    });
  });

  document.getElementById('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  render();
})();
