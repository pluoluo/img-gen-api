(() => {
  const tabs = Array.from(document.querySelectorAll('[data-workspace]'));
  const legacy = document.getElementById('legacyWorkspace');
  const canvas = document.getElementById('canvasWorkspace');
  let frame;
  let ready = false;
  const pending = [];
  let editorFullscreen = false;
  let previousFrameStyle = '';
  let previousOverflow = '';
  function setEditorFullscreen(active) {
    if (!frame || active === editorFullscreen) return;
    editorFullscreen = active;
    if (active) {
      previousFrameStyle = frame.getAttribute('style') || '';
      previousOverflow = document.body.style.overflow;
      frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100dvh;z-index:10000;border:0;border-radius:0';
      document.body.style.overflow = 'hidden';
    } else {
      frame.setAttribute('style', previousFrameStyle);
      document.body.style.overflow = previousOverflow;
    }
  }
  function select(name) {
    const active = name === 'canvas';
    legacy.hidden = active;
    canvas.hidden = !active;
    tabs.forEach(tab => {
      const selected = tab.dataset.workspace === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    if (active && !frame) {
      frame = document.createElement('iframe');
      frame.title = '画布工作区';
      frame.addEventListener('load', () => setEditorFullscreen(false));
      frame.src = '/infinite/canvas' + (window.__INFINITE_REVISION__ ? '?v=' + encodeURIComponent(window.__INFINITE_REVISION__) : '');
      frame.addEventListener('error', () => { document.getElementById('canvasLoading').textContent = '画布加载失败，请刷新重试。'; });
      canvas.appendChild(frame);
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.dataset.workspace));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[next].dataset.workspace);
      tabs[next].focus();
    });
  });
  window.insertIntoCanvas = url => {
    select('canvas');
    if (ready) frame.contentWindow.postMessage({type:'canvas-import', url}, location.origin);
    else pending.push(url);
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type === 'canvas-editor-fullscreen' && typeof event.data.active === 'boolean') setEditorFullscreen(event.data.active);
    if (event.data?.type === 'canvas-legacy') select('legacy');
    if (event.data?.type === 'canvas-ready') {
      ready = true;
      document.getElementById('canvasLoading').hidden = true;
      pending.splice(0).forEach(url => frame.contentWindow.postMessage({type:'canvas-import', url}, location.origin));
    }
    if (event.data?.type === 'canvas-imported') {
      const index = pending.indexOf(event.data.url);
      if (index >= 0) pending.splice(index, 1);
    }
    if (event.data?.type === 'canvas-reference' && typeof event.data.url === 'string') {
      quoteAsReference(event.data.url).then(() => select('legacy'));
    }
  });
  select('legacy');
})();
