// Build the diagram from parsed SQL only; edges describe dependencies, not an execution plan.
function buildFlowGraph(data) {
  const nodes = [], edges = [], tables = new Map(), stages = new Map();
  const add = (kind, label, detail, stage = null) => {
    const node = { id: `n${nodes.length}`, kind, label, detail, stage };
    nodes.push(node);
    return node;
  };
  const describe = stage => [
    stage.branches && stage.setOps.join(' / '),
    stage.joins.length && `${stage.joins.length} 次关联`,
    stage.whereParts.length && `${stage.whereParts.length} 个筛选`,
    stage.group && '分组', stage.distinct && '去重', stage.lateral && '展开',
    `${stage.outputColumns.length} 个字段`
  ].filter(Boolean).join(' · ');
  data.ctes.forEach(stage => stages.set(stage, add('cte', stage.name, `${stage.scope ? `${stage.scope} 内 · ` : ''}${describe(stage)}`, stage)));
  if (data.main) stages.set(data.main, add('output', '最终输出', describe(data.main), data.main));
  const connect = (from, to, label = '') => {
    const existing = edges.find(edge => edge.from === from.id && edge.to === to.id);
    if (existing) existing.label += ` / ${label}`;
    else edges.push({ from: from.id, to: to.id, label });
  };
  const wire = (stage, target) => {
    if (stage.branches) {
      stage.branches.forEach((branch, i) => {
        const node = add('branch', `分支 ${i + 1}`, describe(branch), branch);
        wire(branch, node);
        connect(node, target, i ? stage.setOps[i - 1] : '集合输入');
      });
      return;
    }
    const queryNode = (query, label) => {
      const node = add('cte', label, '内部查询', query.main);
      query.ctes.forEach(cte => stages.set(cte, add('cte', cte.name, describe(cte), cte)));
      query.ctes.forEach(cte => wire(cte, stages.get(cte)));
      if (query.main) wire(query.main, node);
      return node;
    };
    stage.sourceDetails.forEach((source, i) => {
      let node;
      if (source.query) {
        node = queryNode(source.query, `子查询${source.alias ? ` ${source.alias}` : ''}`);
      } else {
        const cte = resolveCte(data, stage, source.name);
        node = stages.get(cte);
        if (!node) {
          const key = source.name.toLowerCase();
          if (!tables.has(key)) tables.set(key, add('table', source.name, '源表'));
          node = tables.get(key);
        }
      }
      const join = i > 0 ? stage.joins[i - 1] : null;
      connect(node, target, join ? `${join.type} JOIN${source.alias ? ` · ${source.alias}` : ''}` : source.alias ? `读取 · ${source.alias}` : '读取');
    });
    stage.subqueries.forEach((source, i) => connect(queryNode(source.query, `${source.label}子查询 ${i + 1}`), target, source.label));
  };
  [...data.ctes, ...(data.main ? [data.main] : [])].forEach(stage => wire(stage, stages.get(stage)));
  if (data.write && data.main) {
    const target = add('target', data.write.target, `INSERT ${data.write.mode}`);
    connect(stages.get(data.main), target, '写入');
  }
  return { nodes, edges };
}

function buildFieldGraph(paths) {
  const nodes = [], edges = [], prefixes = new Map();
  paths.forEach(path => {
    let previous;
    path.forEach((label, i) => {
      const key = JSON.stringify(path.slice(0, i + 1));
      if (!prefixes.has(key)) {
        const kind = i === 0 ? 'output' : /^CTE |^子查询/.test(label) ? 'cte' : /^分支 /.test(label) ? 'branch' : i === path.length - 1 ? 'table' : 'cte';
        const node = { id: `f${nodes.length}`, label, kind, selectable: /^CTE /.test(label), detail: i === 0 ? '所选字段' : label.includes('.') ? label.slice(0, label.lastIndexOf('.')) : label };
        nodes.push(node);
        prefixes.set(key, node);
        if (previous) edges.push({ from: node.id, to: previous.id, label: '' });
      }
      previous = prefixes.get(key);
    });
  });
  return { nodes, edges };
}

function layoutGraph(graph) {
  const incoming = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from)]));
  const ranks = new Map();
  const rank = (id, visited = new Set()) => {
    if (ranks.has(id)) return ranks.get(id);
    if (visited.has(id)) return 0;
    const parents = incoming.get(id) || [];
    const value = parents.length ? 1 + Math.max(...parents.map(parent => rank(parent, new Set([...visited, id])))) : 0;
    ranks.set(id, value);
    return value;
  };
  const columns = [];
  graph.nodes.forEach(node => (columns[rank(node.id)] ||= []).push(node));
  const height = Math.max(260, Math.max(...columns.map(column => column.length)) * 112 + 60);
  const positions = new Map();
  columns.forEach((column, i) => {
    // ponytail: one barycenter pass for readable small DAGs; use a layout engine if crossing minimization becomes essential.
    const center = node => {
      const parents = incoming.get(node.id).map(id => positions.get(id)).filter(Boolean);
      return parents.length ? parents.reduce((sum, point) => sum + point.y, 0) / parents.length : height / 2;
    };
    column.sort((a, b) => center(a) - center(b));
    column.forEach((node, j) => positions.set(node.id, { x: 24 + i * 280, y: (height - column.length * 112) / 2 + j * 112 + 14 }));
  });
  return { positions, width: Math.max(280, columns.length * 280), height };
}

function renderGraph(graph, onSelect, label = 'SQL 数据流图') {
  const svgEl = (name, attrs = {}, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const { positions, width, height } = layoutGraph(graph);
  const box = document.createElement('div');
  box.className = 'graph-shell';
  const controls = document.createElement('div');
  controls.className = 'graph-controls';
  const dialog = document.createElement('dialog');
  dialog.className = 'graph-dialog';
  dialog.setAttribute('aria-label', `${label}，全屏画布`);
  const zoomLabel = document.createElement('span');
  const viewport = document.createElement('div');
  viewport.className = 'graph-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', `${label}，可横向和纵向滚动`);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': label });
  const markerId = `arrow-${renderGraph.serial = (renderGraph.serial || 0) + 1}`;
  const defs = svgEl('defs');
  const marker = svgEl('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#91ada9' }));
  defs.append(marker);
  svg.append(defs);
  const edgeElements = [];
  graph.edges.forEach(edge => {
    const a = positions.get(edge.from), b = positions.get(edge.to);
    const x1 = a.x + 216, y1 = a.y + 39, x2 = b.x - 3, y2 = b.y + 39;
    const mid = (x1 + x2) / 2;
    const group = svgEl('g', { class: 'graph-edge' });
    group.append(svgEl('path', { d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, 'marker-end': `url(#${markerId})` }));
    if (edge.label) {
      const label = svgEl('text', { x: mid, y: (y1 + y2) / 2 - 9, 'text-anchor': 'middle' }, edge.label.length > 15 ? `${edge.label.slice(0, 13)}…` : edge.label);
      label.append(svgEl('title', {}, edge.label));
      group.append(label);
    }
    svg.append(group);
    edgeElements.push([edge, group]);
  });
  const nodeElements = new Map();
  let closingFromSelection = false;
  const select = node => {
    const related = new Set([node.id]);
    const visit = (id, direction) => graph.edges.filter(edge => edge[direction === 'up' ? 'to' : 'from'] === id).forEach(edge => {
      const next = edge[direction === 'up' ? 'from' : 'to'];
      if (!related.has(next)) { related.add(next); visit(next, direction); }
    });
    visit(node.id, 'up'); visit(node.id, 'down');
    nodeElements.forEach((element, id) => {
      element.classList.toggle('dimmed', !related.has(id));
      element.classList.toggle('selected', id === node.id);
      element.setAttribute('aria-pressed', String(id === node.id));
    });
    edgeElements.forEach(([edge, element]) => element.classList.toggle('dimmed', !(related.has(edge.from) && related.has(edge.to))));
    if (dialog.open) { closingFromSelection = true; dialog.close(); }
    onSelect?.(node);
  };
  const kinds = { table: '源表', cte: 'CTE / 子查询', branch: '集合分支', output: '最终输出', target: '写入目标' };
  graph.nodes.forEach(node => {
    const { x, y } = positions.get(node.id);
    const interactive = onSelect && node.selectable !== false;
    const group = svgEl('g', { transform: `translate(${x},${y})`, class: `graph-node ${node.kind}`, tabindex: interactive ? 0 : -1, role: interactive ? 'button' : 'group', 'aria-label': `${kinds[node.kind]} ${node.label}，${node.detail}`, 'data-node': node.id });
    group.append(svgEl('title', {}, `${node.label}\n${node.detail}`), svgEl('rect', { width: 216, height: 78, rx: 12 }),
      svgEl('text', { x: 14, y: 20, class: 'node-kind' }, kinds[node.kind]));
    const name = node.label.split('.').at(-1);
    const display = name.length > 24 ? `${name.slice(0, 22)}…` : name;
    group.append(svgEl('text', { x: 14, y: 42, class: 'node-name' }, display));
    const detail = node.kind === 'table' || node.kind === 'target' ? node.label.split('.').slice(0, -1).join('.') || node.detail : node.detail;
    group.append(svgEl('text', { x: 14, y: 62, class: 'node-detail' }, detail.length > 31 ? `${detail.slice(0, 29)}…` : detail));
    if (interactive) {
      group.addEventListener('click', () => select(node));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node); }
      });
    }
    svg.append(group);
    nodeElements.set(node.id, group);
  });
  let zoom = 1, previousZoom = 1;
  const resize = value => {
    zoom = Math.max(.1, Math.min(1.6, value));
    svg.style.width = `${width * zoom}px`;
    svg.style.height = `${height * zoom}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };
  const fit = () => resize(Math.min(1, (viewport.clientWidth - 8) / width));
  [['−', '缩小图形', () => resize(zoom - .15)], ['+', '放大图形', () => resize(zoom + .15)], ['适应', '适应画布', fit]].forEach(([text, name, action]) => {
    const button = document.createElement('button');
    button.textContent = text;
    button.setAttribute('aria-label', name);
    button.addEventListener('click', action);
    controls.append(button);
  });
  controls.append(zoomLabel);
  const expand = document.createElement('button');
  expand.textContent = '全屏';
  expand.setAttribute('aria-label', '展开全屏画布');
  expand.addEventListener('click', () => {
    if (dialog.open) { dialog.close(); return; }
    previousZoom = zoom;
    dialog.append(controls, viewport);
    expand.textContent = '退出全屏';
    expand.setAttribute('aria-label', '退出全屏画布');
    dialog.showModal();
    fit();
  });
  dialog.addEventListener('close', () => {
    box.prepend(controls, viewport);
    expand.textContent = '全屏';
    expand.setAttribute('aria-label', '展开全屏画布');
    resize(previousZoom);
    if (!closingFromSelection) expand.focus();
    closingFromSelection = false;
  });
  controls.append(expand);
  viewport.append(svg);
  box.append(controls, viewport, dialog);
  requestAnimationFrame(() => resize(Math.max(.7, Math.min(1, (viewport.clientWidth - 8) / width))));
  return box;
}

globalThis.buildFlowGraph = buildFlowGraph;
globalThis.buildFieldGraph = buildFieldGraph;
globalThis.layoutGraph = layoutGraph;
globalThis.renderGraph = renderGraph;
