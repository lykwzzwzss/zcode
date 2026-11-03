/** 正文与边界元数据共用同一选择；UNION 保证损坏的循环引用也能终止。 */
export const READ_SELECTION = `, roots(id) as (
 select value from json_each($ids) where $explicit=1
 union select summary_id from folds where $explicit=0 and boundary_id=coalesce(nullif($boundary,''),(select boundary_id from folds order by pos desc limit 1))
), walk(id) as (
 select id from roots union select e.member_id from member_edges e join walk w on e.summary_id=w.id
), ancestors(root_id,id) as (
 select id,id from roots union select a.root_id,e.summary_id from member_edges e join ancestors a on a.id=e.member_id
), selected_folds(id) as (
 select f.summary_id from folds f where f.summary_id in (select id from roots) or exists(
 select 1 from ancestors a where a.id=f.summary_id and not exists(select 1 from folds own where own.summary_id=a.root_id)
 and not exists(select 1 from folds newer join ancestors n on n.id=newer.summary_id where n.root_id=a.root_id and newer.pos>f.pos))
), selected(id) as (
 select a.id from allowed a join walk w on w.id=a.id where $tier='original' and coalesce(a.kind,'')<>'compact_summary'
 and not exists(select 1 from member_edges e where e.summary_id=a.id)
 union select id from selected_folds where $tier='summary'
 union select a.id from allowed a join roots r on r.id=a.id where $tier='summary' and a.kind='compact_summary'
)`;
