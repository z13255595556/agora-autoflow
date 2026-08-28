# Python 代码节点的沙箱容器。**这里面没有任何凭证** —— 不挂 secrets、不给
# env_file、不连数据库：用户代码逃出子进程，也只是站在一个空容器里。
#
# 隔离是三层叠的：独立容器（文件系统与凭证的边界）+ 子进程环境清空
# （code_python._child_env）+ compose 的 mem/pids/cpus 限额。nsjail 级别的
# 系统调用隔离还没上 —— 上它之前，**别把这个容器和任何持有凭证的服务合并**。
FROM python:3.11-slim
WORKDIR /app
# 服务层依赖装在系统 python；用户代码的包装在 /opt/userenv 独立 venv ——
# 用户装的包再怎么冲突（换 numpy 大版本之类）也带不崩服务本身
RUN pip install --no-cache-dir fastapi uvicorn requests \
 && python -m venv /opt/userenv \
 && /opt/userenv/bin/pip install --no-cache-dir --upgrade pip
# 预装包**不烤进镜像**：清单的正本在 api 那边的 sandbox_packages 表里，
# api 启动时把它推过来装（管理页增删同理）。烤进镜像的话改清单就得重建镜像，
# 管理页就成了摆设
COPY server/ ./server/
COPY sandbox/service.py ./
ENV PYTHONPATH=/app/server
ENV SANDBOX_PYTHON=/opt/userenv/bin/python
# pip 的缓存目录要落在可写的地方，否则 uid 65534 的 HOME 不存在，逐次安装都在报 warning
ENV HOME=/tmp
# 非 root。服务和用户代码目前同 uid —— 用户代码理论上能写 /opt/userenv
# （污染已装的包）。分 uid 需要 root + setuid，属于 nsjail 那一步的活；先诚实记着
RUN chown -R 65534:65534 /opt/userenv
USER 65534
EXPOSE 9000
CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "9000"]
