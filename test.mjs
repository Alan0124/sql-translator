import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './parser.js';
import './visual.js';
const { analyze, traceColumn, locateSql } = globalThis;

const sql = `WITH recent AS (
  SELECT user_code, veh_model FROM dws.clicks
  WHERE datetime = 'latest' AND click_time >= current_timestamp - INTERVAL '30' DAY
)
SELECT r.veh_model, COUNT(DISTINCT r.user_code) AS users
FROM recent r LEFT JOIN dim.models m ON r.veh_model = m.code
GROUP BY r.veh_model ORDER BY users DESC LIMIT 10`;
const result = analyze(sql);
assert.deepEqual(result.tables, ['dws.clicks', 'dim.models']);
assert.equal(result.ctes[0].where, "datetime = 'latest' AND click_time >= current_timestamp - INTERVAL '30' DAY");
assert.match(result.ctes[0].sourceSql, /^recent AS \(\s*SELECT user_code, veh_model/s);
assert.match(result.ctes[0].sourceSql, /INTERVAL '30' DAY\s*\)$/);
assert.equal(result.main.joins[0].condition, 'ON r.veh_model = m.code');
assert.equal(result.main.group, 'r.veh_model');
assert.equal(result.main.limit, '10');
assert.deepEqual(traceColumn(result, result.main, result.main.outputColumns[0]).paths,
  [['最终输出.veh_model', 'CTE recent.veh_model', 'dws.clicks.veh_model']]);
assert.equal(locateSql(sql, result, sql.indexOf('recent AS') + 2).stage.name, 'recent');
assert.equal(locateSql(sql, result, sql.indexOf('FROM recent') + 7).stage.name, 'recent');
const clickedField = locateSql(sql, result, sql.indexOf('r.veh_model') + 4);
assert.equal(clickedField.type, 'field');
assert.equal(locateSql(sql, result, sql.indexOf('r.veh_model') + 2).column.name, 'veh_model');
assert.deepEqual(traceColumn(result, clickedField.stage, clickedField.column).paths.at(0).at(-1), 'dws.clicks.veh_model');
assert.equal(locateSql(sql, result, sql.indexOf('dws.clicks') + 5), null);
assert.throws(() => analyze('DELETE FROM dws.clicks'), /只支持 SELECT/);
const sets = analyze('SELECT id FROM a UNION ALL SELECT id FROM b INTERSECT SELECT id FROM c EXCEPT SELECT id FROM d');
assert.deepEqual(sets.main.setOps, ['UNION ALL', 'INTERSECT', 'EXCEPT']);
assert.deepEqual(sets.tables, ['a', 'b', 'c', 'd']);
assert.deepEqual(traceColumn(sets, sets.main, sets.main.outputColumns[0]).paths.map(path => path.at(-1)), ['a.id', 'b.id']);
assert.throws(() => analyze('SELECT 1; SELECT 2'), /一条查询/);
const sparkScript = `-- Spark SQL
ALTER TABLE dwd.ue_user_nio_new_car_eatv_pred_1d_i
SET TBLPROPERTIES('write.distribution-mode'='none','write.spark.fanout.enabled'='true');
WITH nio_trust_score_info AS (
  SELECT user_code, pred_trust_score FROM dwd.ue_user_nio_new_car_eatv_pred_purchase_trust_1d_i
  WHERE datetime = '\${datetime}'
), join_info AS (
  SELECT d.one_id, d.nio_user_code, nts.pred_trust_score
  FROM dim.ue_user_oneid_info_1h_f d
  LEFT JOIN nio_trust_score_info nts ON d.nio_user_code = nts.user_code
  WHERE d.datetime = 'latest'
), add_prob AS (
  SELECT *, ROUND(1 / (1 + exp(-(3.56 * (LEAST(COALESCE(pred_trust_score, 0), 100)/100.0) - 3.54))), 6) AS eatv_prob
  FROM join_info
), finaltb AS (
  SELECT one_id, nio_user_code AS user_code, eatv_prob FROM add_prob
)
INSERT OVERWRITE TABLE dwd.ue_user_nio_new_car_eatv_pred_1d_i PARTITION(datetime='\${datetime}')
SELECT one_id, user_code, eatv_prob FROM finaltb`;
const spark = analyze(sparkScript);
assert.equal(spark.setup.length, 1);
assert.equal(spark.setup[0].target, 'dwd.ue_user_nio_new_car_eatv_pred_1d_i');
assert.match(spark.setup[0].properties, /write.spark.fanout.enabled/);
assert.equal(spark.write.mode, 'OVERWRITE');
assert.equal(spark.ctes.length, 4);
assert.match(spark.ctes[2].sourceSql, /^add_prob AS \(\s*SELECT \*, ROUND/s);
assert.deepEqual(spark.main.outputColumns.map(column => column.name), ['one_id', 'user_code', 'eatv_prob']);
assert.equal(analyze(`%trino\n${sparkScript}`).magic, 'trino');
assert.equal(analyze(`-- note\n%sql SELECT 'a;b' AS value FROM t;`).main.outputColumns[0].name, 'value');
assert.equal(analyze('%sql SELECT id FROM t').magic, 'sql');
assert.throws(() => analyze('%python\nSELECT id FROM t'), /%trino 或 %sql/);
assert.throws(() => analyze("ALTER TABLE t SET TBLPROPERTIES('x'='y'); SELECT 1; SELECT 2"), /一条查询/);
assert.match(analyze('SELECT a.id FROM a, b').main.warnings.join(''), /逗号连接/);
const example = `SELECT count(distinct user_code)
FROM dwm.ue_sales_activity_wide_1h_f a
INNER JOIN dim.ue_all_brand_fellow_info_zip_history_1h_f b
ON b.datetime = 'latest'
AND a.fl_ad_account = b.fellow_ad_account
AND b.effective_start_time <= a.activity_time
AND a.activity_time < b.effective_end_time
AND b.fellow_brand = 'onvo'
AND b.fellow_emp_position = 'UD'
AND b.fellow_emp_status = '1'
WHERE a.datetime = 'latest'
AND a.activity_type IN ('onvo_call_interaction')
AND a.call_duration > 0
AND a.activity_level = 'F'
AND DATE(a.activity_time) BETWEEN DATE '2026-06-25' AND DATE '2026-09-22'`;
const explained = analyze(example);
assert.equal(explained.main.metric.label, 'user_code 去重数');
assert.equal(explained.main.metric.grain, '整体 1 行');
assert.equal(explained.main.whereParts.length, 5);
assert.equal(explained.main.joins[0].predicates.length, 7);
assert.match(explained.main.whereParts[4], /BETWEEN.*AND/i);
assert.equal(explained.main.sourceDetails[0].alias, 'a');
assert.equal(explained.main.joins[0].alias, 'b');
const chat = `SELECT
  date(msgtime) AS dt, msgtime, from_type, from_send, tolist_user_code, content,
  CASE WHEN from_type = '内部联系人' THEN COALESCE(from_user_code, from_send)
       ELSE COALESCE(tolist_user_code, tolist) END AS wx_fl, -- 聊天的内部员工
  CASE WHEN from_type = '内部联系人' THEN COALESCE(tolist_user_code, tolist)
       ELSE COALESCE(from_user_code, from_send) END AS wx_user -- 聊天对应的用户
FROM dwm.ue_sales_wecom_chat_record_wide_1h_f
WHERE datetime = 'latest'
  AND content NOT LIKE '%现在我们可以开始聊天了%'
  AND content NOT LIKE '%请添加你为联系人%'
  AND content IS NOT NULL
  AND roomid IS NULL`;
const chatResult = analyze(chat);
assert.equal(chatResult.main.metric.label, '输出 8 个字段');
assert.deepEqual(chatResult.main.outputColumns.map(x => x.name), ['dt', 'msgtime', 'from_type', 'from_send', 'tolist_user_code', 'content', 'wx_fl', 'wx_user']);
assert.equal(chatResult.main.outputColumns[6].note, '聊天的内部员工');
assert.equal(chatResult.main.outputColumns[7].note, '聊天对应的用户');
assert.equal(chatResult.main.whereParts.length, 5);
const commented = analyze('SELECT id, value -- 末列说明\nFROM source_table');
assert.equal(commented.main.outputColumns[1].expression, 'value');
assert.equal(commented.main.outputColumns[1].note, '末列说明');
assert.equal(commented.main.outputColumns[1].calculated, false);

const nested = `WITH result AS (
WITH oneid AS (
  SELECT nio_user_code, max(one_id) AS one_id
  FROM hive.dim.ue_user_oneid_info_1h_f
  WHERE datetime = 'latest' AND nio_user_code IS NOT NULL
  GROUP BY 1 HAVING count(DISTINCT one_id) = 1
)
SELECT
  r.id_for_wukong AS id,
  u.one_id AS source_key,
  r.wecom_fl_ad_account AS target_key,
  r.relation_type_name,
  cast(r.first_relation_create_time AS varchar) AS relation_start_time,
  CASE WHEN r.relation_is_delete = 0 AND coalesce(r.is_deleted_friend, false) = false THEN NULL
       ELSE cast(r.relation_delete_time AS varchar) END AS relation_end_time,
  CASE WHEN r.relation_is_delete = 0 AND coalesce(r.is_deleted_friend, false) = false
       THEN '好友中' ELSE '已删除' END AS friendship_status
FROM hive.dwm.ue_wecom_user_fl_relation_wide_1h_f r
LEFT JOIN oneid u ON r.user_code = u.nio_user_code
WHERE r.datetime = 'latest' AND r.sale_tenant = 'nio'
  AND r.id_for_wukong IS NOT NULL AND r.wecom_fl_ad_account IS NOT NULL
) SELECT * FROM result LIMIT 30`;
const nestedResult = analyze(nested);
assert.deepEqual(nestedResult.ctes.map(x => x.name), ['oneid', 'result']);
assert.match(nestedResult.ctes[0].sourceSql, /^oneid AS \(/);
assert.match(nestedResult.ctes[1].sourceSql, /^result AS \(\s*WITH oneid AS \(/s);
assert.equal(nestedResult.ctes[0].group, '1');
assert.equal(nestedResult.ctes[0].having, 'count(DISTINCT one_id) = 1');
assert.equal(nestedResult.ctes[1].joins[0].source, 'oneid');
assert.equal(nestedResult.main.metric.label, '输出 7 个字段');
assert.equal(nestedResult.main.limit, '30');
assert.deepEqual(nestedResult.tables, ['hive.dim.ue_user_oneid_info_1h_f', 'hive.dwm.ue_wecom_user_fl_relation_wide_1h_f']);
assert.deepEqual(traceColumn(nestedResult, nestedResult.main, nestedResult.main.outputColumns[1]).paths,
  [['最终输出.source_key', 'CTE result.source_key', 'CTE oneid（result 内）.one_id', 'hive.dim.ue_user_oneid_info_1h_f.one_id']]);
const cteOnly = `WITH leads AS (
  SELECT leads_id, user_code FROM dim.leads WHERE datetime = 'latest'
), actions_90d AS (
  SELECT user_code, user_action_ext_info['car_model'] AS car_model
  FROM dws.actions
  WHERE datetime BETWEEN date_format(date_sub(to_date('\${datetime}', 'yyyyMMdd'), 89), 'yyyyMMdd')
    AND date_format(to_date('\${datetime}', 'yyyyMMdd'), 'yyyyMMdd')
), user_actions AS (
  SELECT user_code,
    collect_set(CASE WHEN user_action_name_en = 'view_configurator_hp_nioapp'
      AND datetime >= date_format(date_sub(to_date('\${datetime}', 'yyyyMMdd'), 29), 'yyyyMMdd')
      THEN car_model END) AS have_tab_click_30d
  FROM actions_90d GROUP BY user_code
)`;
const fragment = analyze(cteOnly);
assert.equal(fragment.main, null);
assert.equal(fragment.hasFinalQuery, false);
assert.deepEqual(fragment.ctes.map(x => x.name), ['leads', 'actions_90d', 'user_actions']);
assert.equal(fragment.ctes[1].whereParts.length, 1);
assert.equal(fragment.ctes[2].outputColumns[1].name, 'have_tab_click_30d');
assert.ok(traceColumn(fragment, fragment.ctes[2], fragment.ctes[2].outputColumns[1]).paths.some(path =>
  path.at(-1) === "dws.actions.user_action_ext_info['car_model']"));
const ambiguous = analyze('SELECT user_code FROM dim.a a JOIN dim.b b ON a.id = b.id');
assert.match(traceColumn(ambiguous, ambiguous.main, ambiguous.main.outputColumns[0]).paths[0].at(-1), /来源无法确定/);
const insert = analyze(`WITH user_actions AS (SELECT user_code FROM dws.actions)
INSERT OVERWRITE TABLE dwm.profile PARTITION (datetime)
SELECT l.user_code, a.user_code AS action_user, '20260929' AS datetime
FROM dim.leads l LEFT JOIN user_actions a ON l.user_code = a.user_code`);
assert.deepEqual(insert.write, { mode: 'OVERWRITE', target: 'dwm.profile', partition: 'datetime' });
assert.equal(insert.main.outputColumns.length, 3);
assert.equal(insert.main.joins[0].source, 'user_actions');
const complex = analyze(`WITH combined AS (
  SELECT id, val FROM t1 UNION ALL SELECT id, val FROM t2
), first AS (
  WITH tmp AS (SELECT id, val FROM combined)
  SELECT t.*, 'first' AS label FROM tmp t
), second AS (
  WITH tmp AS (SELECT id, val FROM t3)
  SELECT t.*, 'second' AS label FROM tmp t
), exploded AS (
  SELECT id, v AS value FROM (SELECT id, map('x', val) AS m FROM first) s
  LATERAL VIEW explode(map_filter(m, (k, v) -> v is not null)) e AS k, v
), merged AS (
  SELECT id FROM first UNION ALL SELECT id FROM second UNION ALL SELECT id FROM exploded
), counted AS (
  SELECT id FROM (SELECT id FROM merged UNION ALL SELECT id FROM t4)
)
INSERT OVERWRITE TABLE out PARTITION (datetime='20260929') SELECT id FROM counted`);
assert.equal(complex.write.target, 'out');
assert.deepEqual(complex.ctes.filter(stage => stage.name === 'tmp').map(stage => stage.scope), ['first', 'second']);
assert.equal(complex.ctes.find(stage => stage.name === 'combined').branches.length, 2);
assert.equal(complex.ctes.find(stage => stage.name === 'merged').branches.length, 3);
assert.equal(complex.ctes.find(stage => stage.name === 'exploded').lateral.columns[1], 'v');
assert.deepEqual(complex.tables, ['t1', 't2', 't3', 't4']);
assert.deepEqual(complex.ctes.find(stage => stage.name === 'first').outputColumns.map(column => column.name), ['id', 'val', 'label']);
assert.deepEqual(complex.ctes.find(stage => stage.name === 'second').outputColumns.map(column => column.name), ['id', 'val', 'label']);
assert.deepEqual(traceColumn(complex, complex.ctes.find(stage => stage.name === 'second'), complex.ctes.find(stage => stage.name === 'second').outputColumns[1]).paths[0].at(-1), 't3.val');
assert.ok(traceColumn(complex, complex.ctes.find(stage => stage.name === 'exploded'), complex.ctes.find(stage => stage.name === 'exploded').outputColumns[1]).paths.some(path => path.at(-1) === 't1.val'));
assert.ok(traceColumn(complex, complex.main, complex.main.outputColumns[0]).paths.some(path => path.at(-1) === 't4.id'));
const repeatedCtes = `WITH first AS (WITH tmp AS (SELECT id FROM t) SELECT id FROM tmp),
second AS (WITH tmp AS (SELECT id FROM t) SELECT id FROM tmp)
SELECT id FROM second`;
const repeated = analyze(repeatedCtes);
assert.equal(locateSql(repeatedCtes, repeated, repeatedCtes.lastIndexOf('tmp AS (') + 1).stage.scope, 'second');
const fellowSql = readFileSync(new URL('./fixtures/fellow-eatv.sql', import.meta.url), 'utf8');
const fellowEatv = analyze(fellowSql);
assert.equal(fellowEatv.ctes.length, 19);
assert.equal(fellowEatv.write.target, 'ads.ue_fellow_eatv_analysis_for_mate_1d_f');
assert.equal(fellowEatv.main.outputColumns.length, 11);
assert.deepEqual(fellowEatv.ctes.filter(stage => stage.name === 'tmp').map(stage => stage.scope), ['car_owner_and_purchase_demand', 'total_detail']);
assert.equal(fellowEatv.ctes.find(stage => stage.name === 'top20_fl').branches.length, 2);
assert.equal(fellowEatv.ctes.find(stage => stage.name === 'union_info').branches.length, 3);
const top20 = fellowEatv.ctes.find(stage => stage.name === 'top20_fl');
assert.deepEqual(traceColumn(fellowEatv, top20, top20.outputColumns[0]).paths.map(path => path.at(-1)),
  ['ads.uo_con_gmve_profit_rank_rpt_1h_f.fl_ad_account', 'alps_dws.onvo_dws_cmve_fellow_rank_1d_a.fellow_ad_account']);
const sourceField = locateSql(fellowSql, fellowEatv, fellowSql.indexOf('fl_ad_account AS fellow_ad_account') + 2);
assert.equal(sourceField.column.name, 'fellow_ad_account');
assert.equal(fellowEatv.ctes.find(stage => stage.name === 'total_detail').outputColumns.length, 8);
assert.equal(fellowEatv.ctes.find(stage => stage.name === 'explode_info').lateral.columns[1], 'fellow_ad_account');
const fellowSources = traceColumn(fellowEatv, fellowEatv.main, fellowEatv.main.outputColumns[0]).paths;
assert.equal(fellowSources.length, 8);
assert.equal(new Set(fellowSources.map(path => path.find(node => node.startsWith('分支 ')))).size, 3);
assert.ok(fellowSources.some(path =>
  path.at(-1) === 'dwm.ue_sales_build_connection_record_single_1h_f.fellow_ad_account'));
assert.equal(locateSql(fellowSql, fellowEatv, fellowSql.indexOf('tmp_mappng AS') + 3).stage.name, 'tmp_mappng');
const clickedFellow = locateSql(fellowSql, fellowEatv, fellowSql.lastIndexOf('SELECT fellow_ad_account') + 10);
assert.equal(clickedFellow.type, 'field');
assert.equal(traceColumn(fellowEatv, clickedFellow.stage, clickedFellow.column).paths.length, 8);
const { buildFlowGraph, buildFieldGraph, layoutGraph } = globalThis;
const flow = buildFlowGraph(result);
assert.equal(flow.nodes.filter(node => node.kind === 'table').length, 2);
const recentNode = flow.nodes.find(node => node.stage === result.ctes[0]);
const outputNode = flow.nodes.find(node => node.kind === 'output');
assert.ok(flow.edges.some(edge => edge.from === recentNode.id && edge.to === outputNode.id));
assert.ok(flow.edges.some(edge => edge.to === outputNode.id && edge.label === 'LEFT JOIN · m'));
const fullFlow = buildFlowGraph(fellowEatv);
assert.equal(fullFlow.nodes.filter(node => node.kind === 'cte' && node.label === 'tmp').length, 2);
const targetNode = fullFlow.nodes.find(node => node.kind === 'target');
assert.equal(targetNode.label, fellowEatv.write.target);
assert.ok(fullFlow.edges.some(edge => edge.to === targetNode.id && edge.label === '写入'));
assert.ok(fullFlow.nodes.some(node => node.kind === 'branch'));
const positions = layoutGraph(fullFlow).positions;
fullFlow.edges.forEach(edge => assert.ok(positions.get(edge.from).x < positions.get(edge.to).x, `依赖应从左到右：${edge.from} → ${edge.to}`));
const scopedFlow = buildFlowGraph(complex);
const secondNode = scopedFlow.nodes.find(node => node.stage === complex.ctes.find(stage => stage.name === 'second'));
const secondTmp = scopedFlow.nodes.find(node => node.stage === complex.ctes.find(stage => stage.name === 'tmp' && stage.scope === 'second'));
assert.ok(scopedFlow.edges.some(edge => edge.from === secondTmp.id && edge.to === secondNode.id));
const fieldFlow = buildFieldGraph(traceColumn(result, result.main, result.main.outputColumns[0]).paths);
assert.equal(fieldFlow.nodes.length, 3);
assert.equal(fieldFlow.edges.length, 2);
const fieldPositions = layoutGraph(fieldFlow).positions;
fieldFlow.edges.forEach(edge => assert.ok(fieldPositions.get(edge.from).x < fieldPositions.get(edge.to).x));
const sharedPaths = buildFieldGraph([['输出.x', 'CTE a.x', 't1.x'], ['输出.x', 'CTE a.x', 't2.x']]);
assert.equal(sharedPaths.nodes.length, 4);
assert.equal(sharedPaths.edges.length, 3);
assert.equal(buildFlowGraph(analyze('SELECT 1 AS value')).nodes.length, 1);
assert.equal(buildFlowGraph(fragment).nodes.some(node => node.kind === 'output'), false);
const selfJoin = buildFlowGraph(analyze('SELECT a.id FROM t a LEFT JOIN t b ON a.id = b.id'));
assert.equal(selfJoin.edges.length, 1);
assert.equal(selfJoin.edges[0].label, '读取 · a / LEFT JOIN · b');
console.log('SQL 解读器与可视化检查通过');
