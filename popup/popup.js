// popup/popup.js
// 插件弹窗：嗅探视图（候选流） + 缓存视图（已缓存视频，可重新打开 / 删除）
(() => {
  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
  const listEl = document.getElementById('list');
  const subtitle = document.getElementById('subtitle');
  const mainNav = document.getElementById('mainNav');
  const mainFooter = document.getElementById('mainFooter');
  const settingsView = document.getElementById('settingsView');
  const clearBtn = document.getElementById('clearBtn');
  const DEFAULTS = { sniffEnabled: true, maxConcurrent: 16, timeoutMs: 30000, maxRetry: 5, downloadProxyEnabled: false, downloadProxyUrl: '', downloadRelayUrl: 'http://127.0.0.1:17891' };
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
    clearBtn.title = activeView === 'sniff' ? '清空当前页嗅探结果' : '清空所有缓存';
    if (activeView === 'sniff') await renderSniff();
    else await renderCache();
  }

  // ── 嗅探视图 ──
  async function renderSniff() {
    subtitle.textContent = '当前页嗅探结果';
    const tab = await getActiveTab();
    if (!tab) { showEmpty('未获取到当前标签页'); return; }
    const resp = await chrome.runtime.sendMessage({ type: 'LIST_STREAMS', tabId: tab.id, pageUrl: tab.url || '' });
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
        try {
          const result = await chrome.runtime.sendMessage({
            type: 'OPEN_PLAYER', tabId: tab.id, stream: { url: s.url, domain: s.domain, live: s.live }, title: tab.title || '',
          });
          if (!result?.ok) throw new Error(result?.error || '打开播放页失败');
          window.close();
        } catch (error) { alert('打开播放页失败：' + (error?.message || error)); }
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
        <div class="row"><span class="url" title="${escapeHtml(v.title)}">${escapeHtml(v.title || '未命名')}</span><button class="delete-btn" type="button" title="删除此缓存" aria-label="删除此缓存">删除</button></div>
        <div class="meta">${meta.join('<span>·</span>')}</div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
        <div class="play">重新打开并继续缓存 →</div>`;
      item.querySelector('.delete-btn').addEventListener('click', async (event) => {
        event.stopPropagation();
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const result = await chrome.runtime.sendMessage({ type: 'DELETE_CACHE', videoId: v.videoId });
          if (!result?.ok) throw new Error(result?.error || '删除失败');
          await renderCache();
        } catch (error) {
          button.disabled = false;
          alert('删除缓存失败：' + (error?.message || error));
        }
      });
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
  document.querySelectorAll('.tab[data-view]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-view]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeView = tab.dataset.view;
      render();
    });
  });

  clearBtn.addEventListener('click', async () => {
    const sniff = activeView === 'sniff';
    clearBtn.disabled = true;
    try {
      let message = { type: 'CLEAR_CACHE' };
      if (sniff) {
        const tab = await getActiveTab();
        if (!tab) throw new Error('未获取到当前标签页');
        message = { type: 'CLEAR_SNIFF', tabId: tab.id };
      }
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || '清空失败');
      await render();
    } catch (error) {
      alert('清空失败：' + (error?.message || error));
    } finally {
      clearBtn.disabled = false;
    }
  });

  function setSettingsVisible(visible) {
    mainNav.hidden = visible;
    listEl.hidden = visible;
    mainFooter.hidden = visible;
    settingsView.hidden = !visible;
    subtitle.textContent = visible ? '扩展设置' : '当前页嗅探结果';
  }

  async function loadSettingsView() {
    const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const s = { ...DEFAULTS, ...((r && r.ok && r.settings) || {}) };
    document.getElementById('sniffEnabled').checked = s.sniffEnabled !== false;
    document.getElementById('maxConcurrent').value = s.maxConcurrent;
    document.getElementById('timeoutMs').value = Math.round(s.timeoutMs / 1000);
    document.getElementById('maxRetry').value = s.maxRetry;
    document.getElementById('downloadProxyEnabled').checked = s.downloadProxyEnabled === true;
    document.getElementById('downloadProxyUrl').value = s.downloadProxyUrl || '';
    document.getElementById('downloadRelayUrl').value = s.downloadRelayUrl;
    updateProxyInput();
    showSettingsError('');
  }

  function collectSettings() {
    const maxConcurrent = Math.min(64, Math.max(1, Number(document.getElementById('maxConcurrent').value) || DEFAULTS.maxConcurrent));
    const timeoutMs = Math.min(120, Math.max(1, Number(document.getElementById('timeoutMs').value) || DEFAULTS.timeoutMs / 1000)) * 1000;
    const maxRetry = Math.min(10, Math.max(0, Number(document.getElementById('maxRetry').value) || 0));
    return {
      sniffEnabled: document.getElementById('sniffEnabled').checked,
      maxConcurrent, timeoutMs, maxRetry,
      downloadProxyEnabled: document.getElementById('downloadProxyEnabled').checked,
      downloadProxyUrl: document.getElementById('downloadProxyUrl').value.trim(),
      downloadRelayUrl: document.getElementById('downloadRelayUrl').value.trim(),
    };
  }

  function updateProxyInput() {
    const enabled = document.getElementById('downloadProxyEnabled').checked;
    document.getElementById('downloadProxyUrl').disabled = !enabled;
    document.getElementById('relaySettings').hidden = !enabled;
  }

  function showSettingsError(message) {
    const error = document.getElementById('settingsError');
    error.textContent = message;
    error.hidden = !message;
  }

  document.getElementById('downloadProxyEnabled').addEventListener('change', updateProxyInput);

  document.getElementById('settingsBtn').addEventListener('click', async () => {
    setSettingsVisible(true);
    await loadSettingsView();
  });
  document.getElementById('backBtn').addEventListener('click', () => {
    setSettingsVisible(false);
    render();
  });
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const btn = document.getElementById('saveSettings');
    btn.disabled = true;
    showSettingsError('');
    try {
      const settings = collectSettings();
      const r = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
      if (!r?.ok) throw new Error(r?.error || '保存设置失败');
      const old = btn.textContent;
      btn.textContent = '已保存';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (error) {
      showSettingsError(error?.message || '保存设置失败');
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('resetSettings').addEventListener('click', async () => {
    const btn = document.getElementById('resetSettings');
    btn.disabled = true;
    showSettingsError('');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: DEFAULTS });
      if (!r?.ok) throw new Error(r?.error || '恢复默认失败');
      document.getElementById('sniffEnabled').checked = DEFAULTS.sniffEnabled;
      document.getElementById('maxConcurrent').value = DEFAULTS.maxConcurrent;
      document.getElementById('timeoutMs').value = DEFAULTS.timeoutMs / 1000;
      document.getElementById('maxRetry').value = DEFAULTS.maxRetry;
      document.getElementById('downloadProxyEnabled').checked = DEFAULTS.downloadProxyEnabled;
      document.getElementById('downloadProxyUrl').value = DEFAULTS.downloadProxyUrl;
      document.getElementById('downloadRelayUrl').value = DEFAULTS.downloadRelayUrl;
      updateProxyInput();
      const old = btn.textContent;
      btn.textContent = '已恢复';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (error) {
      showSettingsError(error?.message || '恢复默认失败');
    } finally {
      btn.disabled = false;
    }
  });

  render();
})();
