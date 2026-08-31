"""code.python 的沙箱侧 runner。**只用 stdlib。**

这个文件被沙箱解释器（server/.venv-sandbox）执行，那边没有 fastapi 也没有
sql_service —— 所以这里 import 任何服务端模块都会当场炸，而且炸得对：
runner 属于用户代码那一侧，本来就不该拿得到服务端的任何东西。

协议（和 code_python.py 一头一尾，改一边必须同步另一边）：

- stdin 收一份 JSON：{"code": str, "inputs": dict, "timeoutSeconds": int}
- argv[1] 是结果 fd（父进程 os.pipe() 的写端，pass_fds 原号继承）。
  结果**只**写这个 fd，绝不写 stdout —— stdout/stderr 整个让给用户 print。
  解析 stdout 的方案（Dify 那样）用户随手一个 print 就把结果搞坏了。
- **只要写出了协议结果就 exit 0**，用户代码失败也算 runner 成功。
  父进程见"进程死了但没有协议输出"才判基础设施错（CODE_SANDBOX_UNAVAILABLE）。

结果 JSON 两种形态：
    {"ok": true,  "result": {...}, "converted": ["path: datetime → ISO", ...]}
    {"ok": false, "kind": "syntax|no_main|runtime|bad_return|output_too_large",
     "message": "...", "line": 3}
"""
import json
import os
import resource
import sys
import traceback
from datetime import date, datetime

# 用户代码 compile 时的假文件名。剥栈就认它：traceback 里只有 filename 等于
# 这个值的帧属于用户，其余（本文件的包装层）一律隐藏 —— 否则用户看到的是
# 一堆 code_runner.py 的内部调用栈，找不到自己错在哪
USER_FILE = "<code.python>"

OUTPUT_MAX_BYTES = 10 * 1024 * 1024
CONVERTED_NOTE_MAX = 20  # 转换说明最多记这么多条，大结果集里全是 datetime 时别刷屏


def _set_limits(wall_seconds: int) -> None:
    """资源限制，soft=hard 都设成上限 —— 不给用户代码自己调回去的机会。

    这里是"本地尽力而为"：macOS 上有几条根本不生效（逐条注明）。
    真正的硬墙是未来沙箱容器的 cgroup / pids limit，这里防的是事故不是恶意。
    """

    def _set(res: int, val: int) -> None:
        try:
            resource.setrlimit(res, (val, val))
        except (ValueError, OSError):
            pass  # 平台不支持/权限不够就算了，理由见 docstring

    # 墙钟由父进程掐（communicate 超时 → SIGKILL），这条是"墙钟没到但 CPU 烧穿"的兜底
    _set(resource.RLIMIT_CPU, wall_seconds + 5)
    # macOS 的 RLIMIT_AS 设了也不生效（setrlimit 成功但内核不管）。照设不删 ——
    # Linux 上有效，这是本地模式内存约束的全部了
    _set(resource.RLIMIT_AS, 512 * 1024 * 1024)
    _set(resource.RLIMIT_DATA, 512 * 1024 * 1024)
    _set(resource.RLIMIT_FSIZE, 64 * 1024 * 1024)
    # 数字取得宽：Linux 上 NPROC 连线程一起按**用户**计数，压太低的话
    # numpy 的 BLAS 线程都起不来。macOS 上它按用户的进程总数算，本机常年
    # 几百个进程，256 意味着用户代码里任何 fork 都立刻 EAGAIN ——
    # 歪打正着，恰好是 fork bomb 闸
    _set(resource.RLIMIT_NPROC, 256)
    _set(resource.RLIMIT_NOFILE, 64)


class _BadValue(Exception):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(message)
        self.path = path


def _sanitize(value, path, converted):
    """递归检查返回值 JSON 可序列化，顺手做两类友好转换。

    - datetime/date 自动转 ISO 串，**并记录转过**（下游拿到的是字符串不是对象，
      不说明的话用户会纳闷类型怎么变了）
    - numpy 标量鸭子转换（.item()）：pandas 的 to_dict() 吐出来的全是 np.int64，
      不转的话"预装了 pandas"和"返回值必须可序列化"互相打架。无损转换，不记录

    其余不可序列化的**明确报错并点名键路径和类型**，绝不静默 str() ——
    那样下游拿到的是一串没法用的文本，而且看不出任何异常。
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime, date)):
        if len(converted) < CONVERTED_NOTE_MAX:
            converted.append(f"{path or '$'}: {type(value).__name__} → ISO 字符串")
        elif len(converted) == CONVERTED_NOTE_MAX:
            converted.append("……（同类转换过多，不再逐条列出）")
        return value.isoformat()
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(k, str):
                key = k
            elif isinstance(k, (int, float, bool)) or k is None:
                key = str(k)  # json.dumps 本来也会这么干，提前做掉才能拼出正确的 path
            else:
                raise _BadValue(f"{path or '$'} 的键", f"字典键是 {type(k).__name__}，JSON 只认字符串键")
            out[key] = _sanitize(v, f"{path}.{key}" if path else key, converted)
        return out
    if isinstance(value, (list, tuple)):
        return [_sanitize(v, f"{path}[{i}]", converted) for i, v in enumerate(value)]
    item = getattr(value, "item", None)
    if callable(item):
        try:
            plain = item()
        except Exception:  # noqa: BLE001 —— 不是 numpy 标量就走下面的报错
            plain = None
        if isinstance(plain, (bool, int, float, str)):
            return plain
    raise _BadValue(path or "$", f"{type(value).__name__} 不能转成 JSON")


def _user_error(exc: BaseException, kind: str):
    """把异常整理成"用户视角"的错误：只留用户代码的帧、带行号、剥掉包装层。"""
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == USER_FILE]
    line = frames[-1].lineno if frames else getattr(exc, "lineno", None)
    where = f"第 {line} 行：" if line else ""
    message = f"{where}{type(exc).__name__}: {exc}"
    if isinstance(exc, ImportError):
        message += ("。预装包与状态见管理员「Python 依赖」页；"
                    "需要新包请管理员在那里添加（不支持在代码里自装）")
    elif isinstance(exc, KeyboardInterrupt):
        # 这不是用户代码写得出来的错：KeyboardInterrupt == 进程收到 SIGINT。
        # 已知来源是数值库线程起不来时 OpenBLAS 给自己 raise(SIGINT)
        # （_child_env 已钉单线程堵掉），剩下的就是有人/有东西真发了信号。
        # 不说明的话用户会盯着报错行号找自己代码的毛病 —— 那行只是恰好在跑
        message += ("（进程收到了中断信号 SIGINT，通常不是这行代码的问题 —— "
                    "多为沙箱线程/内存额度不足时数值库初始化失败，"
                    "或进程被外部打断；这行只是信号到达时恰好在执行）")
    elif isinstance(exc, RuntimeError) and "can't start new thread" in str(exc):
        # 沙箱有 pids/NPROC 限额，pthread_create 一失败 Python 层就是这句。
        # 已知来源是 matplotlib 首次构建字体缓存前的提示线程（平台已在执行前
        # 预热缓存堵掉，见 code_python._ensure_mpl_warm）；报错行落在 import
        # 上时基本都是这一族 —— 不说明的话用户会盯着 import 行冤枉自己的代码
        message += ("（沙箱对线程数有上限：报错行是 import 时，多为某个库在"
                    "初始化线程池/缓存，属平台限制，请把报错发给管理员；"
                    "是你自己 threading 起线程时，请减少并发线程数）")
    detail = "".join(traceback.format_list(frames)).rstrip()
    return {"ok": False, "kind": kind, "message": message, "line": line,
            **({"traceback": detail} if detail else {})}


def main() -> None:
    out = os.fdopen(int(sys.argv[1]), "w", encoding="utf-8")
    # 藏掉 fd 号，给用户代码一份干净的 argv。防的是事故不是恶意 ——
    # 本地模式里真想找 fd 有的是办法，真正的边界是未来的沙箱容器
    sys.argv = [USER_FILE]

    def emit(obj) -> None:
        json.dump(obj, out, ensure_ascii=False)
        out.close()
        sys.exit(0)

    payload = json.load(sys.stdin)
    code = payload["code"]
    inputs = payload.get("inputs") or {}
    _set_limits(int(payload.get("timeoutSeconds") or 30))

    try:
        compiled = compile(code, USER_FILE, "exec")
    except SyntaxError as exc:
        emit({"ok": False, "kind": "syntax", "line": exc.lineno,
              "message": f"第 {exc.lineno} 行：语法错误：{exc.msg}"})
    except ValueError as exc:
        # compile 对含空字节的源码抛 ValueError 而不是 SyntaxError ——
        # 不接住就成了"沙箱不可用"，被 worker 白白重试三次
        emit({"ok": False, "kind": "syntax", "message": f"代码不是合法的 Python 源码：{exc}"})

    # 顶层代码（import、常量定义）也可能抛错，和 main() 里的错同一套整理
    g = {"__name__": "__main__", "__builtins__": __builtins__}
    try:
        exec(compiled, g)  # noqa: S102 —— 这里就是"执行用户代码"本身
    except BaseException as exc:  # noqa: BLE001 —— SystemExit 也要按协议报，否则会被误判成沙箱挂了
        emit(_user_error(exc, "runtime"))

    fn = g.get("main")
    if not callable(fn):
        emit({"ok": False, "kind": "no_main",
              "message": "代码里缺少入口函数 def main(inputs)。入口是固定的：def main(inputs) -> dict"})

    try:
        result = fn(inputs)
    except BaseException as exc:  # noqa: BLE001
        emit(_user_error(exc, "runtime"))

    if not isinstance(result, dict):
        emit({"ok": False, "kind": "bad_return",
              "message": f"main() 返回了 {type(result).__name__}，需要返回 dict"
                         "（下游按字段取值，只有 dict 的键能变成字段）"})

    # logs / durationMs 是引擎拼进输出的保留键，撞了会被静默覆盖 —— 提前拒绝
    clash = sorted(k for k in result if k in ("logs", "durationMs"))
    if clash:
        emit({"ok": False, "kind": "bad_return",
              "message": f"返回值里的键 {clash} 是保留键（引擎要放运行日志/耗时），换个名字"})

    converted: list = []
    try:
        clean = _sanitize(result, "", converted)
    except _BadValue as exc:
        emit({"ok": False, "kind": "bad_return",
              "message": f"返回值不能转成 JSON：{exc.path} 是 {exc}。"
                         "转成基本类型（数字/字符串/列表/字典）再返回"})

    encoded = json.dumps({"ok": True, "result": clean, "converted": converted}, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > OUTPUT_MAX_BYTES:
        mb = len(encoded.encode("utf-8")) / 1024 / 1024
        emit({"ok": False, "kind": "output_too_large",
              "message": f"返回值有 {mb:.1f}MB，上限 10MB。考虑只返回汇总，明细落库或分页"})
    out.write(encoded)
    out.close()


if __name__ == "__main__":
    main()
