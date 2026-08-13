"""SQL 节点服务。

启动前先读 .env —— 下面几个模块的端点常量是在导入时求值的，晚一步 .env 里的
配置就会被静默忽略（凭证能用，端点却悄悄走了默认值，查出来的数是另一个环境的）。
"""
import os


def _load_dotenv(filename: str = ".env") -> None:
    """极简 .env 读取。已经在环境里的不覆盖 —— 显式 export 优先级更高。"""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), filename)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()
