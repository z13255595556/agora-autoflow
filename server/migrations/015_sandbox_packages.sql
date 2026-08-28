-- Python 代码节点（code.python）的预装包清单。**这张表是唯一正本。**
--
-- 为什么进库而不是 requirements.txt：清单要由管理员在界面上增删（用户代码
-- 不许自装 —— pip 的安装脚本本身就是任意代码，供应链面必须收在管理员手里），
-- 而"文件 + 表"两份清单迟早分叉，分叉了会静默对不上：venv 里装的和界面上
-- 显示的不是同一份，谁也不报错，症状是"界面说有这个包，import 却失败"。
--
-- 沙箱 venv 不是正本，是这张表的投影：api 启动时和每次增删后做一次对账
-- （sandbox_packages.reconcile），把 venv 收敛成表的样子。
CREATE TABLE IF NOT EXISTS sandbox_packages (
  -- PEP503 规范化小写（python-dateutil，不是 python_dateutil / Python.Dateutil），
  -- 写入前在服务端归一 —— pip 对这些写法一视同仁，不归一的话同一个包能存进来三行
  name       TEXT PRIMARY KEY,
  -- 必须钉死版本。不钉的话同一条流程今天跑和上月跑，代码没变结果先变了，
  -- 而且没有任何日志能解释为什么
  version    TEXT NOT NULL,
  -- pending → installed / failed；removing → 对账后整行删除。
  -- 装 pandas 这种要几分钟，界面靠这个列轮询进度
  status     TEXT NOT NULL DEFAULT 'pending',
  pip_log    TEXT,                      -- pip 输出的尾部，装失败时唯一的线索
  added_by   TEXT,                      -- 管理员邮箱，审计用
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 种子：设计文档 §10.5 定的纯计算四件套，加 requests —— 联网是有意放开的
-- （见 code_python.py 头注释），代码里得有个像样的 HTTP 客户端。
-- 版本钉在写迁移这天的稳定版，且都还支持 Python 3.9（本机 venv 的下限）。
INSERT INTO sandbox_packages (name, version, status, added_by) VALUES
  ('pandas',          '2.2.3',       'pending', 'migration'),
  ('numpy',           '2.0.2',       'pending', 'migration'),
  ('python-dateutil', '2.9.0.post0', 'pending', 'migration'),
  ('orjson',          '3.10.15',     'pending', 'migration'),
  ('requests',        '2.32.3',      'pending', 'migration')
ON CONFLICT (name) DO NOTHING;
