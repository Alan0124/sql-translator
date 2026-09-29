const WORD = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

function tokens(sql) {
  const pattern = /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|[\p{L}_][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|[^\s]/gu;
  return [...sql.matchAll(pattern)]
    .filter(([value]) => !/^\s|^--|^\/\*/.test(value))
    .map(match => ({ value: match[0], upper: match[0].toUpperCase(), start: match.index, end: match.index + match[0].length }));
}

function closing(ts, open) {
  let depth = 0;
  for (let i = open; i < ts.length; i++) {
    if (ts[i].value === '(') depth++;
    if (ts[i].value === ')' && --depth === 0) return i;
  }
  return -1;
}

function topLevel(ts) {
  let depth = 0;
  return ts.map(token => {
    const level = depth;
    if (token.value === '(') depth++;
    if (token.value === ')') depth--;
    return level;
  });
}

function clause(sql, ts, start, end) {
  return start < 0 || start >= ts.length ? '' : sql.slice(ts[start].start, end < ts.length ? ts[end].start : sql.length).trim();
}

function tableAt(ts, index, sql) {
  if (ts[index]?.value === '(') {
    const end = closing(ts, index);
    if (end < 0) throw new Error('来源子查询的括号没有闭合。');
    const after = ts[end + 1]?.upper === 'AS' ? end + 2 : end + 1;
    const alias = ts[after] && WORD.test(ts[after].value) && !['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'ON', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT'].includes(ts[after].upper) ? ts[after].value : '';
    return { name: '子查询', alias, next: alias ? after + 1 : end + 1, nested: true, query: parseQuery(sql.slice(ts[index].end, ts[end].start)) };
  }
  let i = index;
  if (!ts[i] || !WORD.test(ts[i].value) && !/^["`]/.test(ts[i].value)) return { name: '未知来源', next: i + 1 };
  let name = ts[i++].value;
  while (ts[i]?.value === '.' && ts[i + 1]) {
    name += '.' + ts[i + 1].value;
    i += 2;
  }
  const aliasAt = ts[i]?.upper === 'AS' ? i + 1 : i;
  const alias = ts[aliasAt] && WORD.test(ts[aliasAt].value) && !['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'ON', 'GROUP', 'HAVING', 'QUALIFY', 'ORDER', 'LIMIT', 'PARTITION', 'SELECT', 'LATERAL', 'UNION', 'INTERSECT', 'EXCEPT'].includes(ts[aliasAt].upper)
    ? ts[aliasAt].value : '';
  return { name, alias, next: alias ? aliasAt + 1 : i };
}

function splitPredicates(sql) {
  if (!sql) return [];
  const ts = tokens(sql.replace(/^\s*(ON|USING)\s+/i, ''));
  const levels = topLevel(ts);
  const parts = [];
  let start = 0, between = false;
  for (let i = 0; i < ts.length; i++) {
    if (levels[i] !== 0) continue;
    if (ts[i].upper === 'BETWEEN') between = true;
    if (ts[i].upper !== 'AND') continue;
    if (between) { between = false; continue; }
    parts.push(clause(sql.replace(/^\s*(ON|USING)\s+/i, ''), ts, start, i));
    start = i + 1;
  }
  parts.push(clause(sql.replace(/^\s*(ON|USING)\s+/i, ''), ts, start, ts.length));
  return parts.filter(Boolean).map(part => part.replace(/;\s*$/, ''));
}

function parseColumns(fields) {
  const ts = tokens(fields);
  const levels = topLevel(ts);
  const starts = [0];
  for (let i = 0; i < ts.length; i++) if (levels[i] === 0 && ts[i].value === ',') starts.push(i + 1);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : ts.length;
    const part = ts.slice(start, end);
    const partLevels = topLevel(part);
    const as = part.findLastIndex((t, i) => partLevels[i] === 0 && t.upper === 'AS');
    const expression = as >= 0 ? fields.slice(part[0].start, part[as].start).trim() : fields.slice(part[0].start, part.at(-1).end).trim();
    const name = as >= 0 ? part[as + 1]?.value : part.at(-1)?.value === '*' ? '*' : part.at(-1)?.value;
    const following = index + 1 < starts.length ? ts[starts[index + 1]]?.start ?? fields.length : fields.length;
    const note = fields.slice(as >= 0 ? part[as + 1]?.end ?? following : part.at(-1).end, following).match(/--\s*([^\n]*)/)?.[1].trim();
    return { name: name || expression, expression, note: note || '', calculated: !/^[\w.]+$/.test(expression) && expression !== '*' };
  }).filter(col => col.expression);
}

function metricFor(fields, group, columns) {
  const distinct = fields.match(/^COUNT\s*\(\s*DISTINCT\s+([\w.]+)\s*\)(?:\s+AS\s+\w+)?$/i);
  if (distinct) return { label: `${distinct[1].split('.').at(-1)} 去重数`, kind: 'distinct', field: distinct[1], grain: group ? `按 ${group} 分组` : '整体 1 行' };
  if (/^COUNT\s*\(\s*\*\s*\)(?:\s+AS\s+\w+)?$/i.test(fields)) return { label: '记录数', kind: 'count', grain: group ? `按 ${group} 分组` : '整体 1 行' };
  const label = columns.length === 1 && columns[0].name === '*' ? '输出全部字段' : `输出 ${columns.length} 个字段`;
  return { label, kind: 'fields', grain: group ? `按 ${group} 分组` : '逐行输出' };
}

function parseSelect(sql) {
  const ts = tokens(sql);
  const levels = topLevel(ts);
  // ponytail: 只拆外层 SELECT；复杂方言或嵌套来源需要完整 SQL AST 解析器。
  if (ts[0]?.upper !== 'SELECT') throw new Error('目前只支持 SELECT 查询（可以包含 WITH CTE）。');
  const at = (word, from = 0) => ts.findIndex((t, i) => i >= from && levels[i] === 0 && t.upper === word);
  const select = at('SELECT');
  if (select < 0) throw new Error('目前只支持 SELECT 查询（可以包含 WITH CTE）。');
  const from = at('FROM', select + 1);
  const where = at('WHERE', select + 1);
  const group = at('GROUP', select + 1);
  const having = at('HAVING', select + 1);
  const order = at('ORDER', select + 1);
  const limit = at('LIMIT', select + 1);
  const qualify = at('QUALIFY', select + 1);
  const points = [from, where, group, having, qualify, order, limit].filter(i => i >= 0).sort((a, b) => a - b);
  const next = i => points.find(p => p > i) ?? ts.length;
  const section = (i, skip = 1) => i < 0 ? '' : clause(sql, ts, i + skip, next(i)).replace(/;\s*$/, '');
  const result = {
    fields: clause(sql, ts, select + 1, from >= 0 ? from : next(select)),
    where: section(where), group: section(group, 2), having: section(having),
    qualify: section(qualify), order: section(order, 2), limit: section(limit),
    sources: [], joins: [], warnings: [], whereParts: [], sourceDetails: []
  };
  result.whereParts = splitPredicates(result.where);
  result.outputColumns = parseColumns(result.fields);
  result.metric = metricFor(result.fields, result.group, result.outputColumns);
  if (from >= 0) {
    const first = tableAt(ts, from + 1, sql);
    result.sources.push(first.name);
    result.sourceDetails.push(first);
    const stop = next(from);
    if (ts.some((t, i) => i > from && i < stop && levels[i] === 0 && t.value === ',')) {
      result.warnings.push('FROM 中的逗号连接暂未拆解，来源列表可能不完整。');
    }
    for (let i = from + 1; i < stop; i++) {
      if (levels[i] !== 0 || ts[i].upper !== 'JOIN') continue;
      const source = tableAt(ts, i + 1, sql);
      result.sources.push(source.name);
      result.sourceDetails.push(source);
      const type = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS'].find(x => ts[i - 1]?.upper === x || ts[i - 2]?.upper === x) ?? 'INNER';
      let condition = '';
      let end = stop;
      for (let j = i + 1; j < stop; j++) {
        if (levels[j] === 0 && ts[j].upper === 'JOIN') { end = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS'].includes(ts[j - 1]?.upper) ? j - 1 : j; break; }
      }
      const on = ts.findIndex((t, j) => j >= source.next && j < end && levels[j] === 0 && ['ON', 'USING'].includes(t.upper));
      if (on >= 0) {
        condition = clause(sql, ts, on, end);
      }
      result.joins.push({ type, source: source.name, alias: source.alias, condition, predicates: splitPredicates(condition) });
    }
    const lateral = ts.findIndex((token, i) => i > from && i < stop && levels[i] === 0 && token.upper === 'LATERAL' && ts[i + 1]?.upper === 'VIEW');
    if (lateral >= 0 && ts[lateral + 3]?.value === '(') {
      const end = closing(ts, lateral + 3);
      const as = ts.findIndex((token, i) => i > end && i < stop && levels[i] === 0 && token.upper === 'AS');
      const expression = sql.slice(ts[lateral + 2].start, ts[end].end);
      result.lateral = {
        expression,
        columns: as < 0 ? [] : ts.slice(as + 1, stop).filter(token => WORD.test(token.value)).map(token => token.value),
        mapField: expression.match(/map_filter\s*\(\s*([\w.]+)/i)?.[1] || ''
      };
    }
  }
  if (/\bSELECT\s+\*/i.test(sql)) result.warnings.push('SELECT * 会随上游字段变化，输出字段无法仅凭这段 SQL 固定。');
  if (result.joins.length) {
    result.warnings.push(result.metric.kind === 'distinct' && !result.group
      ? '关联表若有多条匹配记录，会放大中间行数；本查询的整体 COUNT(DISTINCT) 不会因同一用户的重复匹配而增加。'
      : '关联表若有多条匹配记录，会放大中间行数；需核对关联键或有效期是否唯一。');
    if (result.metric.kind === 'distinct' && !result.metric.field.includes('.')) {
      result.warnings.push(`输出列 ${result.metric.field} 未加表别名；如果两张表都有此列，查询可能报字段歧义。`);
    }
  }
  return result;
}

function parseSetQuery(sql) {
  const ts = tokens(sql);
  const levels = topLevel(ts);
  const positions = ts.flatMap((token, i) => levels[i] === 0 && ['UNION', 'INTERSECT', 'EXCEPT'].includes(token.upper) ? [i] : []);
  if (!positions.length) return parseSelect(sql);
  const branches = [], setOps = [];
  let start = 0;
  for (const pos of positions) {
    branches.push(parseSelect(sql.slice(ts[start].start, ts[pos].start).trim()));
    const modifier = ['ALL', 'DISTINCT'].includes(ts[pos + 1]?.upper) ? ` ${ts[pos + 1].upper}` : '';
    setOps.push(ts[pos].upper + modifier);
    start = pos + (modifier ? 2 : 1);
  }
  branches.push(parseSelect(sql.slice(ts[start].start).trim()));
  const first = branches[0];
  const warnings = branches.flatMap(branch => branch.warnings);
  if (branches.some(branch => branch.outputColumns.length !== first.outputColumns.length)) warnings.push('集合运算各分支输出字段数不一致，请核对 SQL。');
  const nodes = branches.map((_, index) => ({ index }));
  const operations = [...setOps];
  for (let i = 0; i < operations.length;) {
    if (!operations[i].startsWith('INTERSECT')) { i++; continue; }
    nodes.splice(i, 2, { op: operations[i], left: nodes[i], right: nodes[i + 1] });
    operations.splice(i, 1);
  }
  let setTree = nodes[0];
  operations.forEach((op, i) => { setTree = { op, left: setTree, right: nodes[i + 1] }; });
  return {
    branches, setOps, setTree, fields: first.fields, outputColumns: first.outputColumns.map(column => ({ ...column })),
    metric: { label: `输出 ${first.outputColumns.length} 个字段`, kind: 'fields', grain: '集合结果' },
    sources: branches.flatMap(branch => branch.sources), sourceDetails: branches.flatMap(branch => branch.sourceDetails),
    joins: [], whereParts: [], where: '', group: '', having: '', qualify: '', order: '', limit: '', warnings
  };
}

function parseQuery(sql) {
  const ts = tokens(sql);
  const ctes = [];
  let pos = 0;
  if (ts[pos]?.upper === 'WITH') {
    pos++;
    if (ts[pos]?.upper === 'RECURSIVE') throw new Error('暂不支持递归 CTE。');
    while (pos < ts.length) {
      const nameStart = ts[pos]?.start ?? 0;
      const name = ts[pos++]?.value;
      if (!name || !WORD.test(name)) throw new Error('CTE 名称无法识别。');
      if (ts[pos]?.value === '(') pos = closing(ts, pos) + 1; // optional column names
      if (ts[pos++]?.upper !== 'AS' || ts[pos]?.value !== '(') throw new Error(`CTE ${name} 的 AS (...) 结构无法识别。`);
      const end = closing(ts, pos);
      if (end < 0) throw new Error(`CTE ${name} 的括号没有闭合。`);
      const inner = parseQuery(sql.slice(ts[pos].end, ts[end].start));
      if (!inner.main || inner.write) throw new Error(`CTE ${name} 内还缺少 SELECT 查询。`);
      ctes.push(...inner.ctes.map(stage => ({ ...stage, scope: stage.scope || name })),
        { name, ...inner.main, sourceSql: sql.slice(nameStart, ts[end].end).trim() });
      pos = end + 1;
      if (ts[pos]?.value !== ',') break;
      pos++;
    }
  }
  const cteOnly = ctes.length && (pos === ts.length || pos === ts.length - 1 && ts[pos].value === ';');
  let main = null, write = null;
  if (!cteOnly && ts[pos]?.upper === 'INSERT') {
    const mode = ts[pos + 1]?.upper;
    if (!['OVERWRITE', 'INTO'].includes(mode)) throw new Error('目前只支持 INSERT OVERWRITE / INTO ... SELECT 的静态解读。');
    let i = pos + 2;
    if (ts[i]?.upper === 'TABLE') i++;
    const target = tableAt(ts, i, sql);
    if (target.name === '未知来源') throw new Error('写入目标表无法识别。');
    i = target.next;
    let partition = '';
    if (ts[i]?.upper === 'PARTITION' && ts[i + 1]?.value === '(') {
      const end = closing(ts, i + 1);
      if (end < 0) throw new Error('PARTITION 括号没有闭合。');
      partition = sql.slice(ts[i + 1].end, ts[end].start).trim();
      i = end + 1;
    }
    const levels = topLevel(ts);
    const select = ts.findIndex((t, j) => j >= i && levels[j] === 0 && t.upper === 'SELECT');
    if (select < 0) throw new Error('INSERT 后缺少 SELECT。');
    main = parseSetQuery(sql.slice(ts[select].start));
    write = { mode, target: target.name, partition };
  } else if (!cteOnly) main = parseSetQuery(sql.slice(ts[pos]?.start ?? 0));
  return { ctes, main, write };
}

function inputStatements(sql) {
  const first = tokens(sql)[0];
  let magic = '';
  if (first?.value === '%') {
    const line = sql.slice(first.start).match(/^%(trino|sql)\b([^\r\n]*)(?:\r?\n|$)/i);
    if (!line) throw new Error('目前只识别开头的 %trino 或 %sql。');
    magic = line[1].toLowerCase();
    sql = sql.slice(0, first.start) + line[2].trimStart() + '\n' + sql.slice(first.start + line[0].length);
  }
  const ts = tokens(sql);
  const levels = topLevel(ts);
  const statements = [];
  let start = 0;
  ts.forEach((token, i) => {
    if (levels[i] !== 0 || token.value !== ';') return;
    const part = sql.slice(start, token.start).trim();
    if (tokens(part).length) statements.push(part);
    start = token.end;
  });
  const last = sql.slice(start).trim();
  if (tokens(last).length) statements.push(last);
  return { magic, statements };
}

function parseSetup(sql) {
  const ts = tokens(sql);
  if (ts[0]?.upper !== 'ALTER' || ts[1]?.upper !== 'TABLE') throw new Error('请一次只粘贴一条查询 SQL；前置语句目前仅支持 ALTER TABLE ... SET TBLPROPERTIES。');
  const set = ts.findIndex(t => t.upper === 'SET');
  if (set < 3 || ts[set + 1]?.upper !== 'TBLPROPERTIES' || ts[set + 2]?.value !== '(' || closing(ts, set + 2) !== ts.length - 1) {
    throw new Error('前置 ALTER 语句目前仅支持 SET TBLPROPERTIES(...)。');
  }
  const target = sql.slice(ts[2].start, ts[set].start).trim();
  if (!/^[\w.`"]+(?:\.[\w.`"]+)*$/u.test(target)) throw new Error('ALTER TABLE 的目标表无法识别。');
  return { target, properties: sql.slice(ts[set + 2].end, ts.at(-1).start).trim() };
}

function analyze(sql) {
  if (!sql.trim()) throw new Error('先粘贴一段 SQL。');
  const { magic, statements } = inputStatements(sql);
  if (!statements.length) throw new Error('先粘贴一段 SQL。');
  const setup = statements.slice(0, -1).map(parseSetup);
  const query = statements.at(-1);
  if (tokens(query)[0]?.upper === 'ALTER') throw new Error('ALTER TABLE 后还需要一条 SELECT 或 WITH ... INSERT 查询。');
  const { ctes, main, write } = parseQuery(query);
  const known = new Map();
  for (const stage of [...ctes, ...(main ? [main] : [])]) {
    const expand = current => {
      if (current.branches) {
        current.branches.forEach(expand);
        current.outputColumns = current.branches[0].outputColumns.map(column => ({ ...column }));
        current.metric.label = `输出 ${current.outputColumns.length} 个字段`;
        return;
      }
      current.outputColumns = current.outputColumns.flatMap(column => {
        const match = column.expression.match(/^(?:(\w+)\.)?\*$/);
        if (!match) return [column];
        const source = match[1]
          ? current.sourceDetails.find(item => [item.alias, item.name, item.name.split('.').at(-1)].some(name => name?.toLowerCase() === match[1].toLowerCase()))
          : current.sourceDetails.length === 1 ? current.sourceDetails[0] : null;
        const upstream = source?.query?.main?.outputColumns || known.get(source?.name.toLowerCase());
        return upstream?.length ? upstream.map(item => ({ name: item.name, expression: `${source.alias || source.name}.${item.name}`, note: '', calculated: false })) : [column];
      });
      if (current.metric.kind === 'fields') current.metric.label = `输出 ${current.outputColumns.length} 个字段`;
      if (!current.outputColumns.some(column => column.name === '*')) current.warnings = current.warnings.filter(message => !message.startsWith('SELECT *'));
    };
    expand(stage);
    if (stage.name) known.set(stage.name.toLowerCase(), stage.outputColumns);
  }
  const names = new Set(ctes.map(x => x.name.toLowerCase()));
  const all = [...ctes, ...(main ? [main] : [])];
  const tables = new Set();
  const collect = stage => {
    if (stage.branches) return stage.branches.forEach(collect);
    stage.sourceDetails.forEach(source => {
      if (source.query) {
        source.query.ctes.forEach(collect);
        if (source.query.main) collect(source.query.main);
      } else if (!names.has(source.name.toLowerCase()) && source.name !== '子查询') tables.add(source.name);
    });
  };
  all.forEach(collect);
  return { ctes, main, write, magic, setup, tables: [...tables], hasFinalQuery: !!main };
}

function resolveCte(data, owner, name) {
  const index = data.ctes.indexOf(owner);
  return data.ctes.slice(0, index < 0 ? data.ctes.length : index)
    .findLast(stage => stage.name.toLowerCase() === name.toLowerCase());
}

const SQL_WORDS = new Set('AS CASE WHEN THEN ELSE END NULL TRUE FALSE DISTINCT ALL AND OR IS NOT IN LIKE BETWEEN CAST ARRAY STRING VARCHAR CHAR BOOLEAN INT INTEGER BIGINT DOUBLE DECIMAL DATE TIMESTAMP INTERVAL DAY DAYS MONTH YEAR CURRENT_TIMESTAMP CURRENT_DATE CURRENT_TIME'.split(' '));

function fieldReferences(expression) {
  const ts = tokens(expression);
  const refs = [];
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i];
    if (!WORD.test(token.value) || SQL_WORDS.has(token.upper) || ts[i + 1]?.value === '(') continue;
    let ref = token.value;
    if (ts[i + 1]?.value === '.' && WORD.test(ts[i + 2]?.value || '')) {
      ref += `.${ts[i + 2].value}`;
      i += 2;
    } else if (ts[i - 1]?.value === '.') continue;
    if (ts[i + 1]?.value === '[' && /^['"`]/.test(ts[i + 2]?.value || '') && ts[i + 3]?.value === ']') {
      ref += `[${ts[i + 2].value}]`;
      i += 3;
    }
    refs.push(ref);
  }
  return [...new Set(refs)];
}

function traceColumn(data, stage, column) {
  const paths = [];
  const visit = (current, selected, path, seen, owner) => {
    if (current.branches) {
      const index = current.outputColumns.findIndex(item => item.name.toLowerCase() === selected.name.toLowerCase());
      const valueBranches = node => node.index !== undefined ? [node.index]
        : node.op.startsWith('UNION') ? [...valueBranches(node.left), ...valueBranches(node.right)] : valueBranches(node.left);
      valueBranches(current.setTree).forEach(i => {
        const branch = current.branches[i];
        const next = branch.outputColumns[index];
        const label = `分支 ${i + 1}${i ? `（${current.setOps[i - 1]}）` : ''}`;
        if (next) visit(branch, next, [...path, `${label}.${next.name}`], seen, owner);
        else paths.push([...path, `${label}：缺少对应位置的输出字段`]);
      });
      return;
    }
    const refs = fieldReferences(selected.expression);
    if (!refs.length) {
      const expression = selected.expression;
      const label = expression === '*' ? 'SELECT *：上游字段未在这段 SQL 中列明'
        : /^('(?:''|[^'])*'|\d+(?:\.\d+)?|NULL|TRUE|FALSE)$/i.test(expression) ? `常量：${expression}`
        : `基于来源记录的计算：${expression}`;
      paths.push([...path, label]);
      return;
    }
    for (const ref of refs) {
      const bare = ref.replace(/\[.*$/, '');
      const suffix = ref.slice(bare.length);
      const [qualifier, field] = bare.includes('.') ? bare.split('.') : ['', bare];
      const lateralIndex = qualifier ? -1 : current.lateral?.columns.findIndex(name => name.toLowerCase() === field.toLowerCase()) ?? -1;
      if (lateralIndex >= 0) {
        const label = `LATERAL VIEW ${field}（Map ${lateralIndex === 0 ? '键' : '值'}）`;
        if (lateralIndex === 0 || !current.lateral.mapField) {
          paths.push([...path, label]);
          continue;
        }
        const source = current.sourceDetails[0];
        const upstream = source?.query?.main || source && resolveCte(data, owner, source.name);
        const next = upstream?.outputColumns.find(item => item.name.toLowerCase() === current.lateral.mapField.toLowerCase());
        if (next) visit(upstream, next, [...path, label, `${source.query ? '子查询' : `CTE ${upstream.name}`}.${next.name}`], seen, source.query ? owner : upstream);
        else paths.push([...path, `${label}（上游 Map 字段未找到）`]);
        continue;
      }
      let sources = current.sourceDetails;
      if (qualifier) sources = sources.filter(source => [source.alias, source.name, source.name.split('.').at(-1)].some(name => name?.toLowerCase() === qualifier.toLowerCase()));
      else if (sources.length > 1) sources = [];
      if (sources.length !== 1) {
        paths.push([...path, `${ref}：${sources.length ? '多个来源匹配' : '来源无法确定'}（需核对表结构或补充别名）`]);
        continue;
      }
      const source = sources[0];
      if (source.query?.main) {
        const next = source.query.main.outputColumns.find(item => item.name.toLowerCase() === field.toLowerCase());
        const label = `子查询${source.alias ? ` ${source.alias}` : ''}.${field}`;
        if (next) visit(source.query.main, next, [...path, label], seen, owner);
        else paths.push([...path, `${label}（未找到字段定义）`]);
        continue;
      }
      const cte = resolveCte(data, owner, source.name);
      if (!cte) {
        paths.push([...path, `${source.name}.${field}${suffix}`]);
        continue;
      }
      const next = cte.outputColumns.find(item => item.name.toLowerCase() === field.toLowerCase());
      const label = `CTE ${cte.name}${cte.scope ? `（${cte.scope} 内）` : ''}.${field}`;
      const key = `${data.ctes.indexOf(cte)}:${field.toLowerCase()}`;
      if (!next || seen.has(key)) paths.push([...path, `${label}（${next ? '循环引用' : '未找到字段定义'}）`]);
      else visit(cte, next, [...path, label], new Set([...seen, key]), cte);
    }
  };
  visit(stage, column, [`${stage.name ? `CTE ${stage.name}` : '最终输出'}.${column.name}`], new Set(), stage);
  const expression = stage.branches
    ? stage.branches.map((branch, i) => `分支 ${i + 1}：${branch.outputColumns[stage.outputColumns.findIndex(item => item.name === column.name)]?.expression || '未找到字段'}`).join('\n')
    : column.expression;
  return { expression, paths: [...new Map(paths.map(path => [path.join(' → '), path])).values()] };
}

globalThis.analyze = analyze;
globalThis.traceColumn = traceColumn;
globalThis.resolveCte = resolveCte;
