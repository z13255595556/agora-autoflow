"""错误码。**服务端说清楚"这个错该不该重试"，而不是让引擎去猜。**

在此之前引擎判断能不能重试靠匹配中文串（`if msg.includes('已不在数据平台上')`）——
改一个字文案就静默失效，而失效的表现是"本该重试的没重试"或者更糟的
"不该重试的一直重试"，两者都不报错。

分类规则很简单：**调用方改点什么能解决的 = 不重试；等一会儿可能好的 = 重试。**
"""
from typing import Any, Dict, Optional

# code → 是否可重试。
#
# 这份表和 src/lib/engine-core/errorCodes.ts 必须逐字对齐 ——
# registry.ts 和 manifest.py 之间已经有同样的约定，理由也一样：
# 不一致的后果只在线上出现，本地永远测不出来。
RETRYABLE: Dict[str, bool] = {
    # —— 业务错：调用方改 SQL / 改参数才能解决，重试一百次也一样
    "SQL_PARAM_ERROR": False,      # 占位符与参数对不上
    "SQL_QUERY_ERROR": False,      # 语法错、表不存在
    "SQL_NOT_READONLY": False,     # 写语句被拦
    "RESULT_EXPIRED": False,       # 结果被平台清理了，重试没有意义
    "BAD_REQUEST": False,
    "WECOM_ERROR": False,          # 群机器人地址不对、消息格式不对
    "HTTP_TARGET_BLOCKED": False,  # SSRF 防护拦下的目的地
    # —— 基础设施：等一会儿可能就好了
    "PLATFORM_AUTH": True,         # 机器人票被拒，续票后可能就行
    "PLATFORM_UNAVAILABLE": True,  # 数据平台 5xx
    "SERVICE_UNAVAILABLE": True,   # 本服务缺凭证等
    "UPSTREAM_TIMEOUT": True,
    "RATE_LIMITED": True,
    # —— Python 代码节点（code.python）。business/infra 混排，按"重跑会不会变"分：
    "CODE_SANDBOX_UNCONFIGURED": False,  # 沙箱没配置。503 但不可重试 —— 管理员配置才能解决，等不好
    "CODE_SANDBOX_UNAVAILABLE": True,    # 解释器缺 / spawn 失败 / 进程无协议输出异常死（含疑似 OOM）
    "CODE_SYNTAX_ERROR": False,          # 编译失败，改代码才能解决
    "CODE_RUNTIME_ERROR": False,         # 用户代码抛异常
    "CODE_BAD_RETURN": False,            # 返回值非 dict / 不可序列化 / 撞保留键
    "CODE_TIMEOUT": False,               # 纯计算是确定性的，重跑还是超时
    "CODE_OUTPUT_TOO_LARGE": False,      # 结果超上限，改代码只返回汇总才能解决
}


def is_retryable(code: Optional[str]) -> bool:
    """认不出的错误码**当作不可重试**。

    这个方向是有意的：把不该重试的重试了，代价是平台上多跑几个大查询、
    群里多发几条消息；把该重试的漏了，代价只是一次失败。前者更贵。
    """
    return RETRYABLE.get(code or "", False)


def payload(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    """统一的错误响应体。

    FastAPI 的 HTTPException(detail=...) 接受 dict，会原样放进 body 的 detail 里。
    引擎读 detail.code 判定重试，读 detail.message 显示给人看。
    """
    return {"code": code, "retryable": is_retryable(code), "message": message, **extra}
