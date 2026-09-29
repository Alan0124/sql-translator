WITH top20_fl AS (
  SELECT fl_ad_account AS fellow_ad_account, me_city_company_name AS city_company_name,
    city_company_level, 'nio' AS sale_tenant
  FROM ads.uo_con_gmve_profit_rank_rpt_1h_f
  WHERE datetime = 'latest'
    AND cal_month = DATE_TRUNC('month', date('${datetime_date}'))
    AND city_company_level_rank_pct <= 20
  UNION ALL
  SELECT fellow_ad_account, last_fellow_city_company_name AS city_company_name,
    last_city_company_level AS city_company_level, 'alps' AS sale_tenant
  FROM alps_dws.onvo_dws_cmve_fellow_rank_1d_a
  WHERE datetime = 'latest'
    AND cal_month = DATE_TRUNC('month', date('${datetime_date}'))
    AND city_company_level_profit_percent <= 20
),
latest_eatv_info AS (
  SELECT one_id, brand, user_code, floor(eatv) AS eatv
  FROM dwm.atv_user_core_lifetime_results_1d_i
  WHERE datetime = '${datetime}'
),
add_tenant_info AS (
  SELECT l.*, CASE WHEN l.brand = 'nio' THEN o.nio_leads_user_code
    ELSE l.user_code END AS leads_user_code
  FROM latest_eatv_info l
  LEFT JOIN dim.ue_user_oneid_info_1h_f o
    ON o.datetime = 'latest' AND l.one_id = o.one_id
),
add_fellow_info AS (
  SELECT a.*, s.leads_curr_ur_fl_ad_account, s.leads_et9_fellow_ad_account,
    s.leads_curr_uo_fl_ad_account, s.leads_user_identity
  FROM add_tenant_info a
  LEFT JOIN dim.ue_sales_leads_basic_1h_f s
    ON s.datetime = '${datetime_hour}' AND a.leads_user_code = s.user_code
),
city_company_info AS (
  SELECT fellow_ad_account, fellow_city_company_name, fellow_city_company_level,
    CASE WHEN fellow_brand = 'nio' THEN 'nio' ELSE 'alps' END AS sale_tenant
  FROM dim.ue_employee_fellow_info_1h_f
  WHERE datetime = 'latest' AND fellow_brand IN ('nio', 'onvo')
),
explode_fellow_info AS (
  WITH tmp_mappng AS (
    SELECT one_id, brand AS sale_tenant, leads_user_code, eatv, leads_user_identity,
      map('ur_fl', leads_curr_ur_fl_ad_account,
          'et9_fellow', leads_et9_fellow_ad_account,
          'uo_fl', leads_curr_uo_fl_ad_account) AS fellow_ad_account_map
    FROM add_fellow_info
  ),
  explode_info AS (
    SELECT one_id, sale_tenant, leads_user_code, eatv, leads_user_identity,
      role, fellow_ad_account
    FROM tmp_mappng
    LATERAL VIEW explode(map_filter(fellow_ad_account_map, (k, v) -> v IS NOT NULL))
      exploded AS role, fellow_ad_account
  )
  SELECT e.*, cc.fellow_city_company_name AS fl_city_company_name,
    cc.fellow_city_company_level
  FROM explode_info e
  INNER JOIN city_company_info cc
    ON e.fellow_ad_account = cc.fellow_ad_account
    AND e.sale_tenant = cc.sale_tenant
),
car_owner_and_purchase_demand AS (
  WITH tmp AS (
    SELECT DISTINCT e.sale_tenant, e.fellow_ad_account, e.fl_city_company_name,
      e.fellow_city_company_level,
      CASE WHEN e.role IN ('ur_fl', 'et9_fellow') THEN 'car_owner_user'
        WHEN e.role = 'uo_fl' THEN 'purchase_demand_user' END AS relationship_type,
      e.eatv, e.leads_user_code,
      CASE WHEN e.role IN ('ur_fl', 'et9_fellow') THEN
        CASE WHEN e.eatv < 20000 THEN 'less_than_2w'
          WHEN e.eatv >= 20000 AND e.eatv < 30000 THEN 'between_2w_3w'
          WHEN e.eatv >= 30000 THEN 'more_than_3w' END
        WHEN e.role = 'uo_fl' THEN
        CASE WHEN e.eatv < 6000 THEN 'less_than_6k'
          WHEN e.eatv >= 6000 AND e.eatv < 10000 THEN 'between_6k_1w'
          WHEN e.eatv >= 10000 THEN 'more_than_1w' END
      END AS eatv_bucket_code
    FROM explode_fellow_info e
  )
  SELECT fellow_ad_account, fl_city_company_name, fellow_city_company_level,
    sale_tenant, relationship_type, eatv_bucket_code,
    count(DISTINCT leads_user_code) AS user_cnt, sum(eatv) AS eatv_amt
  FROM tmp GROUP BY 1,2,3,4,5,6
),
build_conn_record AS (
  SELECT DISTINCT bc.fellow_ad_account, bc.user_code AS leads_user_code,
    bc.sale_tenant, cc.fellow_city_company_name AS fl_city_company_name,
    cc.fellow_city_company_level, 'build_trust_user' AS relationship_type,
    fi.eatv,
    CASE WHEN fi.eatv < 6000 THEN 'less_than_6k'
      WHEN fi.eatv >= 6000 AND fi.eatv < 10000 THEN 'between_6k_1w'
      WHEN fi.eatv >= 10000 THEN 'more_than_1w' END AS eatv_bucket_code
  FROM dwm.ue_sales_build_connection_record_single_1h_f bc
  LEFT JOIN add_fellow_info fi ON bc.user_code = fi.leads_user_code
  INNER JOIN city_company_info cc ON bc.fellow_ad_account = cc.fellow_ad_account
    AND bc.sale_tenant = cc.sale_tenant
  WHERE bc.datetime = '${datetime_hour}'
    AND bc.connection_status = 1
    AND fi.leads_user_identity NOT IN (4, 5)
),
build_trust_user AS (
  SELECT fellow_ad_account, fl_city_company_name, fellow_city_company_level,
    sale_tenant, relationship_type, eatv_bucket_code,
    count(DISTINCT leads_user_code) AS user_cnt, sum(eatv) AS eatv_amt
  FROM build_conn_record GROUP BY 1,2,3,4,5,6
),
total_detail AS (
  WITH tmp AS (
    SELECT fellow_ad_account, leads_user_code, sale_tenant, fl_city_company_name,
      fellow_city_company_level, eatv, 'all_user' AS relationship_type,
      CASE WHEN eatv > 0 THEN 'all' END AS eatv_bucket_code
    FROM (
      SELECT fellow_ad_account, leads_user_code, sale_tenant,
        fl_city_company_name, fellow_city_company_level, eatv
      FROM build_conn_record
      UNION ALL
      SELECT fellow_ad_account, leads_user_code, sale_tenant,
        fl_city_company_name, fellow_city_company_level, eatv
      FROM explode_fellow_info
    )
  )
  SELECT fellow_ad_account, fl_city_company_name, fellow_city_company_level,
    sale_tenant, relationship_type, eatv_bucket_code,
    count(DISTINCT leads_user_code) AS user_cnt, sum(eatv) AS eatv_amt
  FROM tmp GROUP BY 1,2,3,4,5,6
),
union_info AS (
  SELECT fellow_ad_account, fl_city_company_name, fellow_city_company_level,
    sale_tenant, relationship_type, eatv_bucket_code, user_cnt, eatv_amt
  FROM car_owner_and_purchase_demand
  UNION ALL
  SELECT fellow_ad_account, fl_city_company_name, fellow_city_company_level,
    sale_tenant, relationship_type, eatv_bucket_code, user_cnt, eatv_amt
  FROM build_trust_user
  UNION ALL
  SELECT fellow_ad_account, fl_city_company_name, fellow_city_company_level,
    sale_tenant, relationship_type, eatv_bucket_code, user_cnt, eatv_amt
  FROM total_detail
),
add_user_cnt_diff_7d AS (
  SELECT u.*, coalesce(a.user_cnt, 0) AS user_cnt_7d,
    coalesce(a.eatv_amt, 0) AS eatv_7d
  FROM union_info u
  LEFT JOIN ads.ue_fellow_eatv_analysis_for_mate_1d_f a
    ON a.datetime = '${datetime_7d}'
    AND u.fellow_ad_account = a.fellow_ad_account
    AND coalesce(u.fl_city_company_name, '') = coalesce(a.fl_city_company_name, '')
    AND u.sale_tenant = a.sale_tenant
    AND u.relationship_type = a.relationship_type
    AND u.eatv_bucket_code = a.eatv_bucket_code
),
benchmark20 AS (
  SELECT t.sale_tenant, t.city_company_name AS fl_city_company_name,
    t.city_company_level, b.relationship_type, b.eatv_bucket_code,
    coalesce(u.user_cnt, 0) AS user_cnt,
    coalesce(u.user_cnt_7d, 0) AS user_cnt_7d
  FROM top20_fl t
  CROSS JOIN (
    SELECT DISTINCT relationship_type, eatv_bucket_code
    FROM add_user_cnt_diff_7d
  ) b
  LEFT JOIN add_user_cnt_diff_7d u
    ON u.sale_tenant = t.sale_tenant
    AND t.fellow_ad_account = u.fellow_ad_account
    AND coalesce(t.city_company_name, '') = coalesce(u.fl_city_company_name, '')
    AND u.relationship_type = b.relationship_type
    AND u.eatv_bucket_code = b.eatv_bucket_code
),
benchmark20_agg AS (
  SELECT sale_tenant, city_company_level, relationship_type, eatv_bucket_code,
    floor(AVG(user_cnt)) AS benchmark20_avg_user_cnt,
    floor(AVG(user_cnt_7d)) AS benchmark20_avg_user_cnt_7d
  FROM benchmark20 GROUP BY 1,2,3,4
),
finaltb AS (
  SELECT a.fellow_ad_account, a.fl_city_company_name, a.sale_tenant,
    a.relationship_type, a.eatv_bucket_code, a.user_cnt, a.user_cnt_7d,
    a.eatv_amt, a.eatv_7d,
    coalesce(b.benchmark20_avg_user_cnt, 0) AS benchmark20_avg_user_cnt,
    coalesce(b.benchmark20_avg_user_cnt_7d, 0) AS benchmark20_avg_user_cnt_7d
  FROM add_user_cnt_diff_7d a
  LEFT JOIN benchmark20_agg b
    ON a.sale_tenant = b.sale_tenant
    AND coalesce(a.fellow_city_company_level, '') = coalesce(b.city_company_level, '')
    AND a.relationship_type = b.relationship_type
    AND a.eatv_bucket_code = b.eatv_bucket_code
)
INSERT OVERWRITE TABLE ads.ue_fellow_eatv_analysis_for_mate_1d_f
PARTITION(datetime='${datetime}')
SELECT fellow_ad_account, fl_city_company_name, sale_tenant, relationship_type,
  eatv_bucket_code, user_cnt, user_cnt_7d, eatv_amt, eatv_7d,
  benchmark20_avg_user_cnt, benchmark20_avg_user_cnt_7d
FROM finaltb
