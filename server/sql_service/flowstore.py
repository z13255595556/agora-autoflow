"""流程的读写。薄薄一层 SQL —— 真正的规则在 flowdef.py（纯函数，可脱库测试）。"""
import json
from typing import Any, Dict, List, Optional

from psycopg.types.json import Jsonb

from . import db, flowdef


class NotFound(LookupError):
    pass


# 能看见一条流程的条件：是我的，或者还没有主（008 迁移之前建的）。
# 公开给 runstore 用 —— 运行记录的可见性必须和流程完全同一条规则，
# 抄一份迟早会漂移（而漂移的方向通常是"运行记录比流程更松"）。
#
# 越权**一律按"不存在"处理，不是 403**：403 等于告诉对方"这条在，只是不给你"，
# 把别人的流程 id 和存在性透出去了。id 是能猜的（run 链接、导出的 JSON 里都有）。
VISIBLE = "(f.owner IS NOT DISTINCT FROM %s OR f.owner IS NULL)"

# viewer 的哨兵值：内部调用（worker 取定义、webhook 触发）不做归属过滤 ——
# 那些路径没有"当前用户"，按 NULL 过滤会把所有有主的流程挡在外面。
# 写成显式哨兵而不是默认 None，是为了让"这里刻意不过滤"在调用点看得见。
ANY = object()

# 「视角就是操作者本人」。写成哨兵而不是默认 None，是因为 None 是一个**真实值**
# （认不出身份 = 匿名，只看得见无主流程），拿它当"没传"会把匿名和管理员搅在一起。
SELF = object()


def _scope(actor: Optional[str], viewer: Any) -> Any:
    """这次操作用谁的视角看。管理员传 ANY —— 越权检查整段跳过，但 actor
    仍然是他本人：审计和归属记的必须是真的动手的那个人，不是"管理员"这个身份。"""
    return actor if viewer is SELF else viewer


def _visible(viewer: Any) -> tuple:
    """(SQL 片段, 参数)。ANY = 不过滤（管理员、worker、webhook 这些没有"当前用户"的路径）。"""
    return ("", ()) if viewer is ANY else (" AND " + VISIBLE, (viewer,))


class FlowArchived(RuntimeError):
    pass


class FlowExists(FileExistsError):
    """id 已经被占用。**必须带上原因。**

    只回一句"已存在"会把人卡死：这条流程在列表里根本看不见（要么归档了，
    要么归属别人），用户看到的是"服务器上没有"和"已存在"同时成立，
    而两条消息都不告诉他下一步该干什么。

    这里**刻意透出"id 被占用"这件事**，和 VISIBLE 那条"越权按不存在处理"
    的取舍不同：那条防的是拿 id 去枚举别人的流程，而走到这里的调用方
    手上已经有完整的流程定义了，藏也藏不住 —— 藏起来只剩下一个无解的报错。
    归属人的邮箱仍然只对看得见它的人给出。
    """

    def __init__(self, flow_id: str, owner: Optional[str], archived: bool, visible: bool):
        self.flow_id, self.owner, self.archived, self.visible = flow_id, owner, archived, visible
        if not visible:
            # 归属别人 → 这个 id 要不回来了，唯一的出路是换个 id
            self.code = "flow_exists_other_owner"
            # 说"不在你的流程列表里"而不是"你看不到" —— 管理员在管理台是看得到的，
            # 但那不改变结论：id 被占着，要不回来
            msg = f"流程 {flow_id} 已存在，但归属其他人，不在你的流程列表里"
        elif archived:
            self.code = "flow_exists_archived"
            msg = f"流程 {flow_id} 在服务器上已归档（不是不存在），可以恢复"
        else:
            # 看得见又没归档 —— 调用方的列表是旧的，重新读一次就有了
            self.code = "flow_exists"
            msg = f"流程 {flow_id} 已存在"
        super().__init__(msg)


def owner_visible(owner: Optional[str], viewer: Any) -> bool:
    """VISIBLE 那条规则的 Python 版。**改一处必须改两处** —— 只在无法用
    SQL 表达时（比如已经把行读出来了、要据此分支）用它。"""
    return viewer is ANY or owner is None or owner == viewer


def _rows(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    cur = conn.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(conn, sql: str, args=()) -> Optional[Dict[str, Any]]:
    got = _rows(conn, sql, args)
    return got[0] if got else None


def _audit(conn, actor: Optional[str], action: str, target_id: str, detail: Any = None,
           target_type: str = "flow") -> None:
    """target_type 默认 flow —— 这个文件里绝大多数审计都是流程。
    用户级通知设置的目标是**人**，它显式传 "user"，否则审计表里会出现一条
    target_type=flow 但 target_id 是邮箱的记录，按流程查审计时凭空多出来一条。"""
    conn.execute(
        "INSERT INTO audit (actor, action, target_type, target_id, detail)"
        " VALUES (%s, %s, %s, %s, %s)",
        (actor, action, target_type, target_id, Jsonb(detail) if detail else None),
    )


def _assert_visible(conn, flow_id: str, viewer: Optional[str]) -> None:
    """这条流程当前用户看得见吗。看不见和不存在给同一个错，理由见 VISIBLE。"""
    sql = "SELECT id FROM flows f WHERE id = %s" + ("" if viewer is ANY else " AND " + VISIBLE)
    args = (flow_id,) if viewer is ANY else (flow_id, viewer)
    if not _one(conn, sql, args):
        raise NotFound(f"流程 {flow_id} 不存在")


def _summary(row: Dict[str, Any]) -> Dict[str, Any]:
    draft = row["draft"]
    published = row.get("published_definition")
    return {
        "id": row["id"],
        "name": row["name"],
        # 归属。None = 还没有主（008 迁移之前建的），谁发布一次就归谁
        "owner": row.get("owner"),
        "activeVersion": row["active_version"],
        "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "archivedAt": row["archived_at"].isoformat() if row.get("archived_at") else None,
        # 停止的时刻。NULL = 在跑。停止只关自动触发（定时 + webhook），
        # 手动运行照常 —— 语义的完整定义见 016 迁移
        "pausedAt": row["paused_at"].isoformat() if row.get("paused_at") else None,
        "nodeCount": len(draft.get("nodes") or []),
        "nodeTypes": flowdef.node_types(draft),
        "triggerKind": (draft.get("trigger") or {}).get("kind", "manual"),
        # 调度器记的下次触发时刻（含 misfire / 重叠之后的实际值）。
        # 列表页的「下次 明天 09:00」只能从这来 —— 从草稿算出来的是"发布后会怎样"，
        # 而且本机没缓存过的流程在列表里只是个没有 trigger 的壳。
        # 已停止的流程报 None，不是"不显示"而是这句话本身为假：
        # 调度器对它只推进时刻、不触发（见 worker/scheduler.ts）
        "nextFireAt": (
            row["next_fire_at"].isoformat()
            if row.get("next_fire_at") and row.get("schedule_enabled")
            and not row.get("paused_at") else None
        ),
        # 失败时通知到哪。这一列 worker 一直在读（alerts.ts），但在此之前没有任何
        # 接口能写它 —— 告警链路是条修好了路没有入口的死路
        "notifyConfig": row.get("notify_config"),
        # 「草稿和线上不一致」：定时和 webhook 跑的是已发布那一版，
        # 改了不发布线上不会变 —— 这件事必须能在列表页看见，否则
        # "我明明改了怎么没生效" 是一定会发生的
        "hasUnpublishedChanges": (
            row["active_version"] is not None and published is not None and _differs(draft, published)
        ),
    }


# 企微群机器人的 webhook 长这样；别的地址一律拒绝 —— 这一列是 worker 拿来直接 POST 的，
# 填错了告警会静默发不出去，而告警发不出去这件事本身没人会知道
WECOM_WEBHOOK_PREFIX = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send"


def _clean_wecom_webhook(hook: Any, field: str) -> str:
    """校验一个企微群机器人地址，返回去掉首尾空白的那份。

    **流程级和用户级共用这一条规则。** 分成两份写的话，两边迟早会漂
    （通常是新加的那份忘了校验前缀），而症状是告警静默发不出去 ——
    见 WECOM_WEBHOOK_PREFIX 上面那段。
    """
    if not isinstance(hook, str) or not hook.strip():
        raise flowdef.FlowDefError(f"{field} 必须是非空字符串")
    hook = hook.strip()
    if not hook.startswith(WECOM_WEBHOOK_PREFIX):
        raise flowdef.FlowDefError(f"{field} 必须是企微群机器人地址（{WECOM_WEBHOOK_PREFIX}?key=…）")
    return hook


def set_notify_config(flow_id: str, config: Optional[Dict[str, Any]], actor: Optional[str],
                      viewer: Any = ANY) -> Dict[str, Any]:
    """失败时通知到哪。**不走草稿保存那条路**：草稿是编辑器每几秒一次的自动保存，
    刻意不记审计；通知配置是运维设置，改一次记一次。

    config 为 None 或 {} = 关掉。只收 {webhook}；webhook 必须是企微机器人地址。
    """
    cleaned: Optional[Dict[str, Any]] = None
    if config:
        cleaned = {"webhook": _clean_wecom_webhook(config.get("webhook"), "notifyConfig.webhook")}
    with db.pool().connection() as conn:
        _assert_visible(conn, flow_id, viewer)
        conn.execute(
            "UPDATE flows SET notify_config = %s WHERE id = %s",
            (Jsonb(cleaned) if cleaned else None, flow_id),
        )
        # 审计只记开关和地址的末几位：整条地址等同凭证，不进审计表
        _audit(conn, actor, "flow.notify", flow_id,
               {"enabled": bool(cleaned), "webhook": _mask(cleaned["webhook"]) if cleaned else None})
        conn.commit()
    return {"notifyConfig": cleaned}


def _mask(hook: str) -> str:
    key = hook.split("key=")[-1] if "key=" in hook else hook
    return f"…key={key[:4]}***{key[-2:]}" if len(key) > 8 else "…key=***"


def set_paused(flow_id: str, paused: bool, actor: Optional[str],
               viewer: Any = SELF) -> Dict[str, Any]:
    """停止 / 重新启用自动触发（定时 + webhook）。首页卡片上那个开关的后端。

    **手动运行不受影响** —— 完整语义见 016 迁移。和 set_notify_config 同类：
    这是运维开关不是草稿编辑，不走 save_draft（不该跟着击键走），改一次记一次审计。

    **刻意不动 updated_at**：那一列的含义是"内容改于何时"，首页按它排序。
    停一下再开不该把一条半年没动的流程顶到列表最前 —— 那个位置的含义会
    从"我最近在编什么"变成"我最近碰过什么开关"。
    """
    with db.pool().connection() as conn:
        clause, args = _visible(_scope(actor, viewer))
        row = _one(conn, "SELECT archived_at, paused_at FROM flows f WHERE id = %s" + clause,
                   (flow_id,) + args)
        if not row:
            raise NotFound(f"流程 {flow_id} 不存在")
        # 归档 = 用户删了它，本来就什么都不跑。放行这个写入只会造出一条
        # "已删除但显示为已停止"的幽灵状态，恢复归档时还得解释一遍
        if row["archived_at"] is not None:
            raise FlowArchived(f"流程 {flow_id} 已删除（已归档），没有启停开关")
        # 幂等：同方向重复按（双击、两个标签页各按一次）不再写库也不再记审计 ——
        # 否则审计里会出现成对的 pause/pause，读的人会以为中间丢了一条 resume
        if bool(row["paused_at"]) != paused:
            conn.execute(
                "UPDATE flows SET paused_at = CASE WHEN %s THEN now() ELSE NULL END WHERE id = %s",
                (paused, flow_id),
            )
            _audit(conn, actor, "flow.pause" if paused else "flow.resume", flow_id)
            conn.commit()
    return get_flow(flow_id)


# ---------------------------------------------------------------- 用户级失败通知
#
# 按流程配（上面那对函数）解决的是"这条流程发到哪个群"；这里解决的是
# "我名下的流程失败了要有人知道"。两者的关系是**流程级覆盖用户级**，
# 合并发生在 worker/alerts.ts 取地址那一步，不在这里 —— 存储层只管存，
# 让"谁覆盖谁"这条规则只有一个实现。


def get_user_notify(email: str) -> Optional[Dict[str, Any]]:
    """这个人配的失败通知地址。没配 = None。

    email 由服务端从登录 cookie 解出来（main._actor），**绝不接受调用方传** ——
    这一列存的是等同凭证的群机器人地址，按请求参数取行等于谁都能读别人的。
    """
    with db.pool().connection() as conn:
        row = _one(conn, "SELECT webhook FROM user_notify_settings WHERE email = %s", (email,))
    return {"webhook": row["webhook"]} if row else None


def set_user_notify(email: str, webhook: Optional[str], actor: Optional[str]) -> Dict[str, Any]:
    """设置 / 清空这个人的失败通知地址。webhook 为 None 或空 = 关掉（删行）。

    地址校验和流程级共用 _clean_wecom_webhook：填错了告警会静默发不出去，
    而"告警发不出去"这件事本身没人会知道。
    """
    cleaned = _clean_wecom_webhook(webhook, "webhook") if webhook else None
    with db.pool().connection() as conn:
        if cleaned:
            conn.execute(
                "INSERT INTO user_notify_settings (email, webhook, updated_at)"
                " VALUES (%s, %s, now())"
                " ON CONFLICT (email) DO UPDATE SET webhook = EXCLUDED.webhook, updated_at = now()",
                (email, cleaned),
            )
        else:
            conn.execute("DELETE FROM user_notify_settings WHERE email = %s", (email,))
        # 和流程级一样：只记开关和末几位。整条地址等同凭证，不进审计表
        _audit(conn, actor, "user.notify", email,
               {"enabled": bool(cleaned), "webhook": _mask(cleaned) if cleaned else None},
               target_type="user")
        conn.commit()
    return {"notifyConfig": {"webhook": cleaned} if cleaned else None}


def _differs(draft: Any, published: Any) -> bool:
    # 只比逻辑，不比布局：拖了一下节点位置不该显示成"有未发布的改动"。
    # 节点上的备注（note）和拖位置同类 —— 它不参与执行。disabled **算**改动：
    # 暂停一个节点会改变线上跑出来的结果
    def logic(d: Any) -> str:
        rest = {k: v for k, v in (d or {}).items() if k not in {"layout", "version"}}
        nodes = rest.get("nodes")
        if isinstance(nodes, list):
            rest["nodes"] = [
                {k: v for k, v in n.items() if k != "note"} if isinstance(n, dict) else n
                for n in nodes
            ]
        return json.dumps(rest, ensure_ascii=False, sort_keys=True)

    return logic(draft) != logic(published)


#: 变更说明的长度上限。够写清"改了什么、为什么"，又不至于变成把整段设计文档
#: 塞进版本列表 —— 那一屏是用来扫的，不是用来读的
NOTE_MAX = 500


def _clean_note(note: Optional[str]) -> Optional[str]:
    """归一变更说明。空白 = 没填（None），不是空字符串。

    两者在界面上要能区分开：**没填**是常态（发布本来就该低摩擦），
    而"填了一个空字符串"是个说不通的状态，留着它下游每处都要多判一次。
    """
    if note is None:
        return None
    trimmed = note.strip()
    return trimmed[:NOTE_MAX] or None


def _publish_is_noop(conn, flow_id: str, row: Dict[str, Any]) -> bool:
    """草稿和当前生效的那一版，逻辑上一模一样吗。

    一样就不该再生一个版本 —— 点一下发布多一版、而两版内容完全相同，
    版本号就从"线上跑的是哪一份"退化成了"这个按钮被点过几次"。
    版本列表和运行记录里的 v3/v4/v5 也就不再有任何意义。

    **无主流程例外**：发布还兼着"认领"这件事（谁发布一次就归谁）。
    直接短路的话，008 之前建的老流程永远认领不了 —— 得先假改一笔才能要回来。

    复用 _differs：只比逻辑不比布局，和 hasUnpublishedChanges、snapshot_draft
    用的是同一把尺子。三处同一个判定，界面上说"草稿与它一致"的时候，
    按钮做的事才一定和这句话对得上。
    """
    if row["active_version"] is None or row["owner"] is None:
        return False
    cur = _one(
        conn,
        "SELECT definition FROM flow_versions WHERE flow_id = %s AND version = %s",
        (flow_id, row["active_version"]),
    )
    if not cur:
        # active_version 指向一个不存在的版本。这时候更该老老实实发一版
        return False
    # 先按 0 号归一一次只为了做比较；_differs 会剔掉 version 这个 key
    return not _differs(flowdef.for_storage(row["draft"], flow_id, 0), cur["definition"])


def list_flows(include_archived: bool = False, viewer: Any = None) -> List[Dict[str, Any]]:
    """我的工作台。**只有自己的流程，外加还没有主的那些。**

    viewer=None（认不出身份）时只看得到无主流程 —— 不是"看到全部"。
    退化成看到全部的话，SSO 出点问题就等于隔离整个不存在，而且没有任何迹象。
    **ANY 是唯一的例外**，且只能由管理员那条路给出（见 main._viewer）。
    """
    clause, args = _visible(viewer)
    with db.pool().connection() as conn:
        rows = _rows(
            conn,
            "SELECT f.id, f.name, f.draft, f.active_version, f.updated_at, f.archived_at, f.owner,"
            "       f.paused_at, f.notify_config, v.definition AS published_definition,"
            "       s.next_fire_at, s.enabled AS schedule_enabled"
            "  FROM flows f"
            "  LEFT JOIN flow_versions v"
            "    ON v.flow_id = f.id AND v.version = f.active_version"
            "  LEFT JOIN schedules s ON s.flow_id = f.id"
            + (" WHERE " + VISIBLE if clause else " WHERE true")
            + ("" if include_archived else " AND f.archived_at IS NULL")
            + " ORDER BY f.updated_at DESC",
            args,
        )
    return [_summary(r) for r in rows]


def get_flow(flow_id: str, viewer: Optional[str] = ANY) -> Dict[str, Any]:
    with db.pool().connection() as conn:
        row = _one(
            conn,
            "SELECT f.id, f.name, f.draft, f.active_version, f.updated_at, f.archived_at, f.owner,"
            "       f.paused_at, f.notify_config, v.definition AS published_definition,"
            "       s.next_fire_at, s.enabled AS schedule_enabled"
            "  FROM flows f"
            "  LEFT JOIN flow_versions v"
            "    ON v.flow_id = f.id AND v.version = f.active_version"
            "  LEFT JOIN schedules s ON s.flow_id = f.id"
            " WHERE f.id = %s" + ("" if viewer is ANY else " AND " + VISIBLE),
            (flow_id,) if viewer is ANY else (flow_id, viewer),
        )
    if not row:
        raise NotFound(f"流程 {flow_id} 不存在")
    out = _summary(row)
    out["draft"] = row["draft"]
    return out


def create_flow(flow_id: str, definition: Any, actor: Optional[str],
                viewer: Any = SELF) -> Dict[str, Any]:
    # 版本 0 = 还没发布过。发布后才有 1
    draft = flowdef.for_storage(definition, flow_id, 0)
    with db.pool().connection() as conn:
        # 这一句**不过滤可见性**：id 是主键，看不见的那条一样会撞。
        # 过滤掉的话下面的 INSERT 会撞成 UniqueViolation，落到 500
        exists = _one(conn, "SELECT owner, archived_at FROM flows WHERE id = %s", (flow_id,))
        if exists:
            raise FlowExists(
                flow_id, exists["owner"], exists["archived_at"] is not None,
                visible=owner_visible(exists["owner"], _scope(actor, viewer)),
            )
        conn.execute(
            "INSERT INTO flows (id, name, draft, owner) VALUES (%s, %s, %s, %s)",
            (flow_id, draft["name"], Jsonb(draft), actor),
        )
        _audit(conn, actor, "flow.create", flow_id, {"name": draft["name"]})
        conn.commit()
    return get_flow(flow_id)


def save_draft(flow_id: str, definition: Any, actor: Optional[str], viewer: Any = SELF) -> Dict[str, Any]:
    """存草稿。**不产生版本** —— 发布才产生。

    编辑器防抖自动保存打的就是这个接口，几秒一次；每次都记一条审计会把
    audit 表变成击键日志，所以这里不写审计（发布才写）。
    """
    with db.pool().connection() as conn:
        clause, args = _visible(_scope(actor, viewer))
        row = _one(conn, "SELECT active_version, archived_at FROM flows f WHERE id = %s" + clause,
                   (flow_id,) + args)
        if not row:
            raise NotFound(f"流程 {flow_id} 不存在")
        # 归档 = 用户把它删了。**写得进去比写不进去糟得多**：草稿更新了、
        # updated_at 也动了，保存也报成功，可它在任何人的列表里都不出现 ——
        # 而浏览器那边会留下一份本地缓存，于是它以「只在本机」的样子回到首页，
        # 删一次回来一次。publish 和 create_run 早就拦了，这是最后一个没拦的写入口。
        if row["archived_at"] is not None:
            raise FlowArchived(f"流程 {flow_id} 已删除（已归档），不能保存")
        draft = flowdef.for_storage(definition, flow_id, row["active_version"] or 0)
        conn.execute(
            "UPDATE flows SET draft = %s, name = %s, updated_at = now() WHERE id = %s",
            (Jsonb(draft), draft["name"], flow_id),
        )
        conn.commit()
    return get_flow(flow_id)


def publish(flow_id: str, actor: Optional[str], viewer: Any = SELF,
            note: Optional[str] = None) -> Dict[str, Any]:
    """草稿 → 新版本 → 设为生效。整件事在一个事务里。

    分两次提交的话，中间崩溃会留下一个"版本写进去了但没生效"或者更糟的
    "active_version 指向一个不存在的版本"——后者会让所有触发都取不到定义。

    **草稿和线上那一版一样时不生新版本**（见 _publish_is_noop）：连点五下
    发布不该产生五个内容相同的版本，那样版本号就不再是"线上跑的是哪一份"，
    而是"这个按钮被点过几次"。返回的仍然是当前状态，不是错误。
    """
    with db.pool().connection() as conn:
        clause, args = _visible(_scope(actor, viewer))
        row = _one(
            conn,
            "SELECT draft, archived_at, active_version, owner FROM flows f WHERE id = %s"
            + clause + " FOR UPDATE",
            (flow_id,) + args,
        )
        if not row:
            raise NotFound(f"流程 {flow_id} 不存在")
        if row["archived_at"] is not None:
            raise FlowArchived(f"流程 {flow_id} 已归档，不能发布")

        # 没有实际改动就什么都不做：不生版本、不动 active_version、不写审计。
        # **不报错** —— 用户要的结果（线上跑的是这一份）已经成立了，
        # 报错等于把一次符合预期的点击说成失败。
        # 整段仍然留在同一个事务里：把它拆成"先判断、再另起一个事务写"的话，
        # FOR UPDATE 的锁会在读草稿和写版本之间被放掉，两个人同时点发布
        # 会算出同一个 nxt，撞 flow_versions 的主键
        if not _publish_is_noop(conn, flow_id, row):
            nxt = _one(
                conn,
                # **AND version > 0 不能少**：调试快照占的是负数域，不参与发布编号。
                # 少了它，一条只调试过没发布过的流程 MAX 是负数，算出的"下一版"
                # 会是 0 或负数 —— 而 active_version 指向 0 之后所有触发都取不到
                # 定义，且全程没有任何报错。
                "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM flow_versions"
                " WHERE flow_id = %s AND version > 0",
                (flow_id,),
            )["v"]
            definition = flowdef.for_storage(row["draft"], flow_id, nxt)
            conn.execute(
                "INSERT INTO flow_versions (flow_id, version, definition, created_by, kind, note)"
                " VALUES (%s, %s, %s, %s, 'published', %s)",
                (flow_id, nxt, Jsonb(definition), actor, _clean_note(note)),
            )
            # 草稿也跟着更新版本号，这样导出的草稿能看出它对应第几版。
            # owner 那个 COALESCE：**谁发布的谁是 owner**。无主流程（008 之前建的）
            # 由第一次发布的人认领；已经有主的不会被后来者顶掉
            conn.execute(
                "UPDATE flows SET active_version = %s, draft = %s, owner = COALESCE(owner, %s),"
                "       updated_at = now() WHERE id = %s",
                (nxt, Jsonb(definition), actor, flow_id),
            )
            _audit(conn, actor, "flow.publish", flow_id, {"version": nxt, "note": _clean_note(note)})
            conn.commit()
    return get_flow(flow_id)


# 一份调试快照可以被复用多久。**必须明显短于 worker 的 RUN_RETENTION_DAYS（14 天）**：
# 复用一份正要被清理器删掉的快照会撞外键。这道差值就是那个安全边界。
DRAFT_SNAPSHOT_REUSE_DAYS = 7


def snapshot_draft(conn, flow_id: str, actor: Optional[str]) -> int:
    """把当前草稿钉成一份调试快照，返回它的**负数**版本号。**这不是发布。**

    手动运行 = 调试，跑的必须是画布上那份草稿；而 runs.flow_version 的外键
    要求执行的定义在 flow_versions 里有一行 —— 「运行记录钉住当时那份定义」
    这条不能为了方便就破例。负数号的理由见 011 迁移。

    **不动 active_version、不动 flows.draft、不认领 owner、不写审计。**
    发布是唯一影响线上的动作，这是这个函数存在的全部意义。
    （不写审计的理由同 save_draft：调试几秒一次，会把 audit 变成击键日志。）

    收 conn 而不是自己开连接：调用方必须已经在同一个事务里拿到 flows 行的
    FOR UPDATE，并且在同一个事务里插入引用这份快照的 runs 行 —— 分开提交
    会给清理器留一个"快照已在、没人引用"的窗口，它会把快照删掉。
    """
    row = _one(conn, "SELECT draft FROM flows WHERE id = %s", (flow_id,))
    if not row:
        raise NotFound(f"流程 {flow_id} 不存在")
    # 先按 0 号归一一次只为了做比较；_differs 会剔掉 version 这个 key
    candidate = flowdef.for_storage(row["draft"], flow_id, 0)

    last = _one(
        conn,
        # **按 created_at 排，不要按 version 排** —— 负数域里 -1 > -2，
        # ORDER BY version DESC 取到的是最老的那份，方向正好反了。
        # FOR SHARE：钉住这一行，免得清理器在我们插 runs 之前把它删了
        "SELECT version, definition FROM flow_versions"
        " WHERE flow_id = %s AND version < 0 AND created_at > now() - %s::interval"
        " ORDER BY created_at DESC LIMIT 1 FOR SHARE",
        (flow_id, f"{DRAFT_SNAPSHOT_REUSE_DAYS} days"),
    )
    # 连点十次运行、画布一动没动，不该产生十份快照。
    # 复用 _differs：只比逻辑不比布局，和 hasUnpublishedChanges 用同一把尺子
    if last and not _differs(candidate, last["definition"]):
        return last["version"]

    nxt = _one(
        conn,
        "SELECT COALESCE(MIN(version), 0) - 1 AS v FROM flow_versions"
        " WHERE flow_id = %s AND version < 0",
        (flow_id,),
    )["v"]
    conn.execute(
        "INSERT INTO flow_versions (flow_id, version, definition, created_by, kind)"
        " VALUES (%s, %s, %s, %s, 'draft')",
        (flow_id, nxt, Jsonb(flowdef.for_storage(row["draft"], flow_id, nxt)), actor),
    )
    return nxt


def list_versions(flow_id: str, viewer: Optional[str] = ANY) -> List[Dict[str, Any]]:
    """已发布的版本历史。**不含调试快照**（负数版本）。

    调试快照是"这次手动运行跑的是哪份草稿"的凭证，不是发布记录 ——
    混进来会让「这条流程发布过几次」这个问题答不上来。按号仍然取得到
    （见 get_version），排查一次运行时要能看见它当时跑的到底是什么。
    """
    with db.pool().connection() as conn:
        _assert_visible(conn, flow_id, viewer)
        rows = _rows(
            conn,
            "SELECT version, created_at, created_by, note FROM flow_versions"
            " WHERE flow_id = %s AND version > 0 ORDER BY version DESC",
            (flow_id,),
        )
    return [
        {
            "version": r["version"],
            "createdAt": r["created_at"].isoformat(),
            "createdBy": r["created_by"],
            # None = 那一版发布时没填。**不要在这里编一句"无说明"** ——
            # 界面要能把"没填"和"填了一句空话"区分开
            "note": r.get("note"),
        }
        for r in rows
    ]


def get_version(flow_id: str, version: int, viewer: Optional[str] = ANY) -> Dict[str, Any]:
    """取某一版的定义快照。

    运行记录必须读这里（按 runs.flow_version），**不能读 active_version** ——
    否则流程一改，历史运行记录就再也解释不通了。
    """
    with db.pool().connection() as conn:
        _assert_visible(conn, flow_id, viewer)
        row = _one(
            conn,
            "SELECT definition, created_at, created_by FROM flow_versions"
            " WHERE flow_id = %s AND version = %s",
            (flow_id, version),
        )
    if not row:
        raise NotFound(f"流程 {flow_id} 没有第 {version} 版")
    return {
        "version": version,
        "definition": row["definition"],
        "createdAt": row["created_at"].isoformat(),
        "createdBy": row["created_by"],
    }


def rollback(flow_id: str, version: int, actor: Optional[str],
             viewer: Any = SELF) -> Dict[str, Any]:
    """把线上切回某一个历史版本。**同时覆盖草稿。**

    只改 active_version 不动草稿的话，切回去的下一秒编辑器就显示"有未发布的
    改动"，而那份"改动"正是刚被切掉的那一版 —— 再点一次发布就原路回去了。
    「切回 v2」这句话的完整含义就是"编辑器里也是 v2"，半截的切换比不切更危险。
    调用方必须把这件事说给用户听（当前草稿会被覆盖）。

    **不生新版本。** 回滚是"换一个已经存在的版本生效"，不是"发布一份新的"；
    生一版的话版本列表里会出现两条内容完全相同的记录，而且回滚记录本身
    也就丢了 —— 那件事记在审计里（flow.rollback），版本列表只回答
    "发布过哪些内容"。

    **立刻改变线上行为**：定时和 webhook 下一次触发就跑这一版。和恢复归档
    一样，这是个有外部后果的动作，界面上要说明白。
    """
    with db.pool().connection() as conn:
        clause, args = _visible(_scope(actor, viewer))
        row = _one(
            conn,
            "SELECT archived_at, active_version FROM flows f WHERE id = %s" + clause + " FOR UPDATE",
            (flow_id,) + args,
        )
        if not row:
            raise NotFound(f"流程 {flow_id} 不存在")
        if row["archived_at"] is not None:
            raise FlowArchived(f"流程 {flow_id} 已删除（已归档），不能切换版本")
        # **必须挡住负数**：调试快照不是发布记录，切过去等于让线上跑一份
        # 谁都没发布过的草稿，而且它随时会被保留期清掉，清掉之后
        # active_version 就指向一个不存在的版本 —— 所有触发静默取不到定义
        if version <= 0:
            raise NotFound(f"版本 {version} 不是已发布的版本")
        target = _one(
            conn,
            "SELECT definition FROM flow_versions WHERE flow_id = %s AND version = %s AND version > 0",
            (flow_id, version),
        )
        if not target:
            raise NotFound(f"流程 {flow_id} 没有 v{version}")

        # 草稿里的 version 字段要跟着改，否则导出的 JSON 会说自己是另一版
        draft = flowdef.for_storage(target["definition"], flow_id, version)
        conn.execute(
            "UPDATE flows SET active_version = %s, draft = %s, updated_at = now() WHERE id = %s",
            (version, Jsonb(draft), flow_id),
        )
        _audit(conn, actor, "flow.rollback", flow_id,
               {"version": version, "from": row["active_version"]})
        conn.commit()
    return get_flow(flow_id)


def archive(flow_id: str, actor: Optional[str], viewer: Any = SELF) -> None:
    """归档，不物理删。

    运行记录会指向流程版本，删掉之后历史就没法解释了 —— 而"这条流程为什么
    昨天发了那个数"恰恰是最常被问到的问题。
    """
    with db.pool().connection() as conn:
        clause, args = _visible(_scope(actor, viewer))
        if not _one(conn, "SELECT id FROM flows f WHERE id = %s" + clause, (flow_id,) + args):
            raise NotFound(f"流程 {flow_id} 不存在")
        conn.execute("UPDATE flows SET archived_at = now() WHERE id = %s AND archived_at IS NULL", (flow_id,))
        _audit(conn, actor, "flow.archive", flow_id)
        conn.commit()


def restore(flow_id: str, actor: Optional[str], viewer: Any = SELF) -> Dict[str, Any]:
    """取消归档。

    归档必须可逆，否则它就是"删除"了 —— 而首页那个删除按钮的全部底气，
    正是"服务端只是归档"。少了这条路，归档过的流程在界面上永远消失，
    却又占着 id 让同名重建报"已存在"。

    **会把定时重新接上**：scheduler 那两条查询都带 `archived_at IS NULL`，
    恢复之后下一轮 syncAllSchedules 就会把它的 schedule 重新排上。
    调用方要把这件事说给用户听。
    """
    with db.pool().connection() as conn:
        clause, args = _visible(_scope(actor, viewer))
        if not _one(conn, "SELECT id FROM flows f WHERE id = %s" + clause, (flow_id,) + args):
            raise NotFound(f"流程 {flow_id} 不存在")
        conn.execute(
            "UPDATE flows SET archived_at = NULL, updated_at = now()"
            " WHERE id = %s AND archived_at IS NOT NULL",
            (flow_id,),
        )
        _audit(conn, actor, "flow.restore", flow_id)
        conn.commit()
    return get_flow(flow_id)
