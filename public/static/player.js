(function () {
  const wrap = document.querySelector('.player-wrap');
  if (!wrap) return;

  const src = wrap.getAttribute('data-src') || '';
  const video = document.getElementById('player-video');
  const frame = document.getElementById('player-frame');
  if (!src || !video || !frame) return;

  const isHls = /\.m3u8(\?|$)/i.test(src);
  const isVideo = /\.(mp4|webm|ogg|mov)(\?|$)/i.test(src);

  if (isHls) {
    // m3u8：优先用 hls.js；Safari 等原生支持的浏览器直接给 video.src
    video.style.display = 'block';
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }
  } else if (isVideo) {
    // mp4/webm 等直链：直接用 <video> 播放
    video.style.display = 'block';
    video.src = src;
  } else {
    // 分享页/外链播放页：用 iframe
    frame.style.display = 'block';
    frame.src = src;
  }
})();
