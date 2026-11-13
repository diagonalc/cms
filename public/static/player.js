(function () {
  const wrap = document.querySelector('.player-wrap');
  if (!wrap) return;

  const src = wrap.getAttribute('data-src') || '';
  const video = document.getElementById('player-video');
  const frame = document.getElementById('player-frame');
  if (!src || !video || !frame) return;

  // m3u8：优先用 hls.js；Safari 等原生支持的浏览器直接给 video.src
  if (/\.m3u8(\?|$)/i.test(src)) {
    video.style.display = 'block';
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }
  } else {
    // 非 m3u8（通常是资源站的外链播放页）用 iframe
    frame.style.display = 'block';
    frame.src = src;
  }
})();
