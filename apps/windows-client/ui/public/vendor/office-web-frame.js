(function () {
  'use strict';

  const MAX_TREE_NODES = 500;
  const VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  const STRUCTURE_ACTIONS = new Set(['duplicate', 'delete', 'move-up', 'move-down']);
  const INSERT_PRESETS = new Set(['heading', 'text', 'button', 'image', 'section', 'columns']);
  const INSERT_PLACEMENTS = new Set(['after', 'inside']);
  const STYLE_FIELDS = Object.freeze({
    color: 'color',
    backgroundColor: 'background-color',
    fontSize: 'font-size',
    textAlign: 'text-align',
    width: 'width',
    height: 'height',
    padding: 'padding',
    margin: 'margin',
    borderRadius: 'border-radius',
    border: 'border',
    display: 'display',
    flexDirection: 'flex-direction',
    justifyContent: 'justify-content',
    alignItems: 'align-items',
    gap: 'gap',
  });

  let sequence = 0;
  let selected = null;
  let templateDocument = null;
  let history = [];
  let lastCommandId = 0;

  function cleanDocument(documentToClean) {
    documentToClean.querySelectorAll('script,base,iframe,object,embed,meta[http-equiv],link[rel="import"]').forEach((node) => node.remove());
    documentToClean.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'nonce' || name.startsWith('data-agent-cowork-')) node.removeAttribute(attribute.name);
        if (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name) && /^(javascript|vbscript|file):/.test(value)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
  }

  function copyBodyAttributes(sourceBody) {
    Array.from(document.body.attributes).forEach((attribute) => document.body.removeAttribute(attribute.name));
    Array.from(sourceBody.attributes).forEach((attribute) => document.body.setAttribute(attribute.name, attribute.value));
  }

  function ensureId(node) {
    if (!node.dataset.agentCoworkId) node.dataset.agentCoworkId = 'web-' + (++sequence);
    return node.dataset.agentCoworkId;
  }

  function ensureTreeIds() {
    Array.from(document.body.querySelectorAll('*')).forEach((node) => {
      if (node instanceof HTMLElement && !node.hasAttribute('data-agent-cowork-ui')) ensureId(node);
    });
  }

  function nodeLabel(node) {
    const explicit = node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title');
    const text = (explicit || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 36);
    if (node.id) return '#' + node.id;
    const className = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
    return className ? '.' + className : node.tagName.toLowerCase();
  }

  function nodeDepth(node) {
    let depth = 0;
    let parent = node.parentElement;
    while (parent && parent !== document.body) {
      depth += 1;
      parent = parent.parentElement;
    }
    return depth;
  }

  function emitTree() {
    const nodes = Array.from(document.body.querySelectorAll('[data-agent-cowork-id]'))
      .filter((node) => node instanceof HTMLElement && !node.hasAttribute('data-agent-cowork-ui'))
      .slice(0, MAX_TREE_NODES)
      .map((node) => {
        const parent = node.parentElement?.closest('[data-agent-cowork-id]');
        return {
          id: ensureId(node),
          parentId: parent instanceof HTMLElement ? ensureId(parent) : null,
          tag: node.tagName.toLowerCase(),
          label: nodeLabel(node),
          depth: nodeDepth(node),
          childCount: Array.from(node.children).filter((child) => !child.hasAttribute('data-agent-cowork-ui')).length,
        };
      });
    parent.postMessage({ type: 'agent-cowork:web-tree', nodes }, '*');
  }

  function canEditText(node) {
    return Array.from(node.children).every((child) => child.hasAttribute('data-agent-cowork-ui'));
  }

  function selectionPayload(node) {
    const style = getComputedStyle(node);
    return {
      id: ensureId(node),
      tag: node.tagName.toLowerCase(),
      label: nodeLabel(node),
      text: canEditText(node) ? node.textContent || '' : '',
      canEditText: canEditText(node),
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      textAlign: style.textAlign,
      width: style.width,
      height: style.height,
      padding: style.padding,
      margin: style.margin,
      borderRadius: style.borderRadius,
      border: style.border,
      display: style.display,
      flexDirection: style.flexDirection,
      justifyContent: style.justifyContent,
      alignItems: style.alignItems,
      gap: style.gap,
      href: node.getAttribute('href') || '',
      src: node.getAttribute('src') || '',
      alt: node.getAttribute('alt') || '',
      target: node.getAttribute('target') || '_self',
      className: typeof node.className === 'string' ? node.className : '',
    };
  }

  function emitSelection() {
    parent.postMessage({ type: 'agent-cowork:web-select', selection: selected ? selectionPayload(selected) : null }, '*');
  }

  function selectNode(node) {
    document.querySelectorAll('[data-agent-cowork-selected]').forEach((item) => item.removeAttribute('data-agent-cowork-selected'));
    selected = node instanceof HTMLElement ? node : null;
    if (selected) {
      ensureId(selected);
      selected.setAttribute('data-agent-cowork-selected', '');
      selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    emitSelection();
  }

  function snapshot(reason) {
    if (!templateDocument) return;
    const clone = templateDocument.cloneNode(true);
    clone.body.innerHTML = document.body.innerHTML;
    clone.querySelectorAll('[data-agent-cowork-ui]').forEach((node) => node.remove());
    clone.querySelectorAll('[data-agent-cowork-id],[data-agent-cowork-selected]').forEach((node) => {
      node.removeAttribute('data-agent-cowork-id');
      node.removeAttribute('data-agent-cowork-selected');
    });
    cleanDocument(clone);
    parent.postMessage({
      type: 'agent-cowork:web-snapshot',
      reason,
      html: '<!doctype html>' + clone.documentElement.outerHTML,
    }, '*');
  }

  function remember() {
    history = [...history.slice(-29), {
      html: document.body.innerHTML,
      selectedId: selected?.dataset.agentCoworkId || '',
    }];
  }

  function finishMutation(nextSelection) {
    ensureTreeIds();
    emitTree();
    selectNode(nextSelection || selected);
    snapshot('mutation');
  }

  function loadSource(source) {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    cleanDocument(parsed);
    templateDocument = parsed;
    selected = null;
    sequence = 0;
    history = [];
    lastCommandId = 0;
    document.head.querySelectorAll('[data-agent-cowork-imported-style]').forEach((node) => node.remove());
    parsed.querySelectorAll('style').forEach((sourceStyle) => {
      const style = document.createElement('style');
      style.setAttribute('data-agent-cowork-imported-style', '');
      style.textContent = sourceStyle.textContent;
      document.head.append(style);
    });
    copyBodyAttributes(parsed.body);
    document.body.innerHTML = parsed.body.innerHTML;
    ensureTreeIds();
    document.documentElement.setAttribute('data-agent-cowork-bridge-ready', '');
    emitTree();
    selectNode(document.body.querySelector('[data-agent-cowork-id]'));
  }

  function safeUrl(value, attribute) {
    const next = String(value || '').trim().slice(0, 2048);
    if (/^(javascript|vbscript|file):/i.test(next)) return '';
    if (attribute === 'src' && /^data:/i.test(next) && !/^data:image\//i.test(next)) return '';
    return next;
  }

  function setStyle(node, field, value) {
    const property = STYLE_FIELDS[field];
    if (!property) return;
    const next = String(value || '').trim().slice(0, 160);
    if (!next) {
      node.style.removeProperty(property);
      return;
    }
    if (CSS.supports(property, next)) node.style.setProperty(property, next);
  }

  function updateSelected(patch) {
    if (!selected || !patch || typeof patch !== 'object') return;
    remember();
    if (Object.hasOwn(patch, 'text') && canEditText(selected)) selected.textContent = String(patch.text || '').slice(0, 100000);
    if (Object.hasOwn(patch, 'className')) selected.className = String(patch.className || '').slice(0, 240);
    Object.keys(STYLE_FIELDS).forEach((field) => {
      if (Object.hasOwn(patch, field)) setStyle(selected, field, patch[field]);
    });
    if (Object.hasOwn(patch, 'href')) {
      const value = safeUrl(patch.href, 'href');
      value ? selected.setAttribute('href', value) : selected.removeAttribute('href');
    }
    if (Object.hasOwn(patch, 'src')) {
      const value = safeUrl(patch.src, 'src');
      value ? selected.setAttribute('src', value) : selected.removeAttribute('src');
    }
    if (Object.hasOwn(patch, 'alt')) selected.setAttribute('alt', String(patch.alt || '').slice(0, 500));
    if (Object.hasOwn(patch, 'target')) {
      const target = patch.target === '_blank' ? '_blank' : '_self';
      selected.setAttribute('target', target);
      if (target === '_blank') selected.setAttribute('rel', 'noopener noreferrer');
    }
    finishMutation(selected);
  }

  function stripEditorState(node) {
    node.removeAttribute('data-agent-cowork-id');
    node.removeAttribute('data-agent-cowork-selected');
    node.querySelectorAll('[data-agent-cowork-id],[data-agent-cowork-selected]').forEach((child) => {
      child.removeAttribute('data-agent-cowork-id');
      child.removeAttribute('data-agent-cowork-selected');
    });
  }

  function performAction(action) {
    if (!selected) return;
    const parentNode = selected.parentElement;
    if (!parentNode) return;
    if (action === 'move-up' && !selected.previousElementSibling) return;
    if (action === 'move-down' && !selected.nextElementSibling) return;
    remember();
    if (action === 'duplicate') {
      const copy = selected.cloneNode(true);
      stripEditorState(copy);
      parentNode.insertBefore(copy, selected.nextSibling);
      finishMutation(copy);
      return;
    }
    if (action === 'delete') {
      const fallback = selected.nextElementSibling || selected.previousElementSibling || (parentNode === document.body ? null : parentNode);
      selected.remove();
      finishMutation(fallback);
      return;
    }
    if (action === 'move-up') parentNode.insertBefore(selected, selected.previousElementSibling);
    if (action === 'move-down') parentNode.insertBefore(selected.nextElementSibling, selected);
    finishMutation(selected);
  }

  function placeholderImage() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#eef0f5"/><path d="M260 375l135-145 95 88 80-72 130 129z" fill="#a6afc3"/><circle cx="635" cy="170" r="42" fill="#c6ccda"/><text x="480" y="465" text-anchor="middle" font-family="system-ui" font-size="28" fill="#667085">替换图片</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function createPreset(preset) {
    if (preset === 'heading') {
      const node = document.createElement('h2');
      node.textContent = '新的标题';
      return node;
    }
    if (preset === 'text') {
      const node = document.createElement('p');
      node.textContent = '在这里输入正文内容。';
      return node;
    }
    if (preset === 'button') {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = '按钮';
      return node;
    }
    if (preset === 'image') {
      const node = document.createElement('img');
      node.src = placeholderImage();
      node.alt = '图片占位';
      node.style.maxWidth = '100%';
      return node;
    }
    if (preset === 'columns') {
      const node = document.createElement('section');
      node.style.display = 'grid';
      node.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      node.style.gap = '24px';
      const left = document.createElement('div');
      const right = document.createElement('div');
      left.textContent = '左栏内容';
      right.textContent = '右栏内容';
      node.append(left, right);
      return node;
    }
    const node = document.createElement('section');
    node.style.padding = '48px 24px';
    const heading = document.createElement('h2');
    heading.textContent = '新的内容区';
    const text = document.createElement('p');
    text.textContent = '补充这一部分的说明。';
    node.append(heading, text);
    return node;
  }

  function canContainChildren(node) {
    return node && !VOID_TAGS.has(node.tagName);
  }

  function insertPreset(preset, placement) {
    const node = createPreset(preset);
    remember();
    if (placement === 'inside' && canContainChildren(selected)) selected.append(node);
    else if (selected?.parentElement) selected.parentElement.insertBefore(node, selected.nextSibling);
    else document.body.append(node);
    ensureTreeIds();
    finishMutation(node);
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    history = history.slice(0, -1);
    document.body.innerHTML = previous.html;
    ensureTreeIds();
    emitTree();
    const restored = previous.selectedId
      ? document.querySelector('[data-agent-cowork-id="' + CSS.escape(previous.selectedId) + '"]')
      : null;
    selectNode(restored || document.body.querySelector('[data-agent-cowork-id]'));
    snapshot('undo');
  }

  function selectById(targetId) {
    if (typeof targetId !== 'string') return;
    selectNode(document.querySelector('[data-agent-cowork-id="' + CSS.escape(targetId) + '"]'));
  }

  document.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target;
    const node = target instanceof HTMLElement ? target : target instanceof Element ? target.parentElement : null;
    if (node && !node.hasAttribute('data-agent-cowork-ui')) selectNode(node);
  }, true);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      performAction('duplicate');
    } else if (event.key === 'Delete') {
      event.preventDefault();
      performAction('delete');
    } else if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      performAction('move-up');
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      performAction('move-down');
    }
  });

  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'agent-cowork:web-init' && typeof data.html === 'string') {
      loadSource(data.html);
      return;
    }
    if (data.type !== 'agent-cowork:web-command' || !data.command || typeof data.command !== 'object') return;
    const command = data.command;
    if (!Number.isSafeInteger(command.id) || command.id <= lastCommandId) return;
    lastCommandId = command.id;
    if (command.type === 'select') selectById(command.targetId);
    if (command.type === 'update') updateSelected(command.patch);
    if (command.type === 'action' && STRUCTURE_ACTIONS.has(command.action)) performAction(command.action);
    if (command.type === 'insert' && INSERT_PRESETS.has(command.preset) && INSERT_PLACEMENTS.has(command.placement)) {
      insertPreset(command.preset, command.placement);
    }
    if (command.type === 'undo') undo();
  });

  parent.postMessage({ type: 'agent-cowork:web-ready' }, '*');
})();
