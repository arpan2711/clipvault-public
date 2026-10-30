// Virtual clips play as a range of their match's full recording (item.virtual = { path, from, to },
// item.url = the full recording). RangeVideo.load(video, item) sets the source and, for a virtual
// clip, makes that <video> behave like the clip's own file: currentTime and duration are clip time
// (0 = the range's start), seeks stay inside the range, and it stops and fires 'ended' at the
// range's end. Everything that drives the player, timeline, markers, minimap sync and key presses
// keeps working in clip time, unchanged. A normal item takes the range off again.
(function (root) {
  // The element's own accessors, wherever they live on its prototype chain.
  function nativeOf(v, name) {
    for (let o = Object.getPrototypeOf(v); o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  }

  function clear(v) {
    const r = v.__range;
    if (!r) return;
    r.stop();
    delete v.currentTime;
    delete v.duration;
    delete v.ended;
    delete v.__range;
  }

  function attach(v, { from, to }) {
    const CT = nativeOf(v, 'currentTime');
    const DUR = nativeOf(v, 'duration');
    const ENDED = nativeOf(v, 'ended');
    const getT = () => CT.get.call(v);
    const setT = (t) => CT.set.call(v, t);
    const len = Math.max(0, to - from);
    const r = { from, to, done: false, timers: [] };
    const clamp = (t) => Math.min(len, Math.max(0, Number(t) || 0));
    const length = () => {
      const d = DUR.get.call(v);
      return Number.isFinite(d) ? Math.min(len, Math.max(0, d - from)) : d;
    };
    Object.defineProperty(v, 'currentTime', {
      configurable: true,
      get: () => clamp(getT() - from),
      set: (t) => { r.done = false; setT(from + clamp(t)); },
    });
    Object.defineProperty(v, 'duration', { configurable: true, get: length });
    Object.defineProperty(v, 'ended', { configurable: true, get: () => r.done || ENDED.get.call(v) });

    const finish = () => {
      if (r.done) return;
      r.done = true;
      v.pause();
      setT(from + len);
      v.dispatchEvent(new Event('ended'));
    };
    // Keeps the playhead inside the range: before it (a fresh load), jump to its start; at its
    // end, stop like a file would.
    const check = () => {
      const t = getT();
      if (t < from - 0.05) setT(from);
      else if (!v.paused && t >= to - 0.01) finish();
    };
    const onMeta = () => { if (getT() < from - 0.01) setT(from); };
    const onPlay = () => {
      if (r.done || getT() >= to - 0.05) { r.done = false; setT(from); }
      watch();
    };
    // Every frame while playing (timeupdate alone comes only every quarter second).
    const watch = () => {
      if (v.__range !== r || v.paused) return;
      check();
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(watch);
      else r.timers.push(setTimeout(watch, 30));
    };
    // Chromium itself pauses at the end of the URL's #t=from,to the first time through.
    const onPause = () => { if (getT() >= to - 0.05) finish(); };
    const handlers = [['loadedmetadata', onMeta], ['play', onPlay], ['pause', onPause], ['timeupdate', check], ['seeked', check]];
    for (const [ev, fn] of handlers) v.addEventListener(ev, fn, true); // before the page's own listeners
    r.stop = () => {
      for (const [ev, fn] of handlers) v.removeEventListener(ev, fn, true);
      r.timers.forEach(clearTimeout);
    };
    v.__range = r;
  }

  // Sets `video` to play `item` (a library item): its file, or its range of the full recording.
  function load(video, item) {
    clear(video);
    if (item && item.virtual && Number.isFinite(item.virtual.from) && item.virtual.to > item.virtual.from) {
      attach(video, item.virtual);
    }
    video.src = item ? item.url : '';
  }

  const api = { load, clear, attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RangeVideo = api;
})(typeof window !== 'undefined' ? window : globalThis);
