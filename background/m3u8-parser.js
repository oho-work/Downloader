// background/m3u8-parser.js
// 解析 HLS 清单：分片索引 / 总时长 / DISCONTINUITY / 加密 / 多码率 / VOD vs LIVE
import { absolutize } from '../utils/id.js';

/**
 * @returns {{
 *   isMaster: boolean,      // 是否多码率主清单
 *   variants: Array,        // 主清单子流
 *   segments: Array,        // 分片：{idx,url,duration,start,key?}
 *   totalDuration: number,
 *   live: boolean,          // 是否有 ENDLIST
 *   encrypted: boolean,
 *   targetDuration: number,
 * }}
 */
export function parsePlaylist(text, baseUrl) {
  const out = {
    isMaster: false, variants: [], segments: [], mediaSequence: 0,
    totalDuration: 0, live: false, encrypted: false, targetDuration: 0,
  };
  const lines = String(text).split(/\r?\n/);
  let cur = { dur: 0 };
  let curKey = null;
  let discontinuity = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.isMaster = true;
      // 下一行是子清单 URL
      continue;
    }
    if (out.isMaster && !line.startsWith('#') && line.length) {
      out.variants.push({ url: absolutize(line, baseUrl), raw: line });
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      // METHOD=NONE clears encryption for following segments. Treating this
      // marker as a key would make export attempt to fetch a non-existent key.
      const method = (line.match(/METHOD=([^,]+)/i) || [])[1];
      if (String(method || '').toUpperCase() === 'NONE') curKey = null;
      else { out.encrypted = true; curKey = line; }
      continue;
    }
    if (line.startsWith('#EXTINF')) { cur.dur = parseFloat(line.split(':')[1]) || 0; continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { out.mediaSequence = Number(line.slice(22)) || 0; continue; }
    if (line.startsWith('#EXT-X-TARGETDURATION')) { out.targetDuration = parseInt(line.split(':')[1], 10) || 0; continue; }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) { discontinuity = true; continue; }
    if (line.startsWith('#EXT-X-ENDLIST')) { out.live = false; continue; }
    if (!line.startsWith('#') && line.length) {
      out.segments.push({
        idx: out.segments.length,
        sequence: out.mediaSequence + out.segments.length,
        url: absolutize(line, baseUrl),
        duration: cur.dur,
        start: out.totalDuration,
        discontinuity,
        key: curKey,
      });
      out.totalDuration += cur.dur;
      cur = { dur: 0 };
      discontinuity = false;
    }
  }
  // 无 ENDLIST 视为直播流
  if (!/EXT-X-ENDLIST/.test(text)) out.live = true;
  return out;
}
