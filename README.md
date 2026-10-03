# dsh-update

DeepSeek Harness 源码安装的官方版本检查和安全更新插件。适配 0.2.0-rc.2 与 0.2.1-alpha.1 的 ConfigForms 与插件详情页；提供启动检查、手动“检查更新”、可关闭的定时检查与每日安装时段。默认启动检查与每 30 分钟检查开启；自动安装默认关闭。侧栏底部提供更新入口和新版提示，核对 GitHub 官方发布和 npm 发布记录。网络错误显示未验证，预发布与稳定渠道分别比较，禁止降级。

## 使用

社区插件，非 DeepSeek 官方产品。支持 Harness 源码 Web 安装；当前在 0.2.1-alpha.1 验证，适配 ConfigForms 设置接口。需要 Node.js ^22.19 或 >=24、pnpm、Git；Mac 登录自动启动还需 Python 3。

从 [Releases](https://github.com/zudazhuang/dsh-update/releases) 下载版本固定的 `dsh-update-0.3.0.tgz`，在 Harness 源码目录运行：

```sh
pnpm dsh plugin --profile web add /absolute/path/dsh-update-0.3.0.tgz
```

开发者也可克隆本仓库，运行 `npm ci`、`npm test`、`npm pack` 后安装生成的包。插件 → dsh-update 提供检查、隔离构建、切换操作和检查间隔、渠道、空闲时长、自动切换配置。自动切换默认关闭；未使用监督启动或源码存在未提交修改时，自动安装暂停；页面允许保存自动安装偏好，满足条件后只在指定时段执行。

本机启动：

```sh
DSH_SOURCE=/path/to/deepseek-harness ./start-harness.sh
```

脚本通过 `pnpm dsh web --no-open` 启动受监督的 Web profile。可用 DSH_SOURCE、DSH_HOME、DSH_SAFE_UPDATE_ROOT 指定源码、用户数据及更新目录。未设置 DSH_SOURCE 时使用本插件仓库旁的 `deepseek-harness`；其他目录布局必须显式指定。更新目录必须在用户数据目录之外。监督进程退出时会等待受管理的 Harness 进程组完全退出。其他启动方式仍可检查和准备，但不能切换。

## 启动和定时更新

“启动 Harness 时检查更新”控制每次应用启动的检查；“定时检查官方版本”独立控制周期检查。手动按钮始终可用。检查间隔实时生效，电脑睡眠后恢复会补做已到期检查；网络失败等待下个周期，不持续重试。页面显示最近检查、下次检查和下次安装时段。

自动安装按本机时间每天执行，默认安装时段为 03:00–04:00，可设置开始时间及 15–240 分钟的时段长度。每个时段开始后核对一次官方版本，只有空闲达到设置时长、监督启动有效且源码无修改时才准备和安装；整个时段繁忙则延后到次日，不在指定时段之外启动自动安装。已开始的构建可以跨过时段结束；切换前仍重新检查时段和活动任务。

本机 Mac 登录自动启动通过用户级 LaunchAgent 实现，不使用管理员权限。启用前停止已运行的监督脚本，然后运行 `DSH_SOURCE=/path/to/deepseek-harness python3 install-login-start.py`；它立即启动 Harness，随后每次用户登录启动。禁用用 `python3 install-login-start.py --remove`，同时停止该登录任务。自动启动不打开浏览器，访问 http://127.0.0.1:3080/ 使用页面。手动运行启动脚本与登录任务共用同一进程锁，避免重复启动。

## 更新与恢复

准备阶段只从 deepseek-ai/deepseek-harness 下载指定发布标签，验证源码版本，与官方 npm 发布信息交叉核对；随后在独立目录安装锁定依赖并构建。在用户数据副本中升级官方外部 DSH 依赖、试启动整个 profile 并检查实际运行版本。外部插件版本保持固定；宿主的版本兼容检查仍生效，不能通过允许不兼容版本绕过。

本插件核对 npm 发布完整性元数据，源码传输依赖 Git HTTPS。它没有额外的发布签名验证。试启动检查的是 Host 激活与版本，前端第三方插件的全部业务行为仍需要更新后验证；本机安装后的前端通过实际浏览器验证。

切换前重新核对源码 commit、部署文件和活动会话及任务。未提交文件阻止更新；本插件不会自动 stash、提交、推送或 reset 原目录。切换时所有已存在 Agent 的 maintenance 阶段被占用，新建 Agent 暂时拒绝；已有运行工作阻止切换。维护期内用户新输入可能排队，切换后请确认投递状态。

监督进程等待旧 Harness 完全退出，再复制整个用户数据目录，保留旧源码、node_modules 与构建文件，并替换 Web profile 的依赖环境。启动失败时先保存升级后的完整用户目录，再恢复一致性快照并启动原环境，避免旧程序读取较新的 Session 格式。更新后的数据副本位于用户目录旁的 `.dsh.failed-update-*`，不会静默删除。

更新记录、快照和日志默认位于 `~/.local/share/dsh-safe-release-update`，使用用户私有权限。运行日志含本地启动认证信息，不应分享原文件。构建命令移除继承的密钥、令牌和 Git 凭据环境，页面只显示固定阶段与错误原因，不展示子进程原始输出。

如果进程在切换中断电或被强制结束，监督启动拒绝继续运行不确定的状态。`transaction.json` 记录原环境、目标和快照路径，`runtime.json` 记录受管进程。检查并确认该进程组已停止后，保留现有用户数据副本，再从已完成的快照恢复，记录恢复状态并清理已失效的锁。未完成快照不能用于恢复。自动恢复此类系统中断尚未开放。

仅支持本机 macOS/Linux 的源码 Web 安装；不适用于 npm 全局安装或 Electron 桌面包。自动更新失败后，同一目标版本停止自动尝试，手动重新准备可重试。官方发布与 npm 元数据不一致时不更新。

## 验证

`npm test` 使用独立临时目录，验证渠道选择、双源不一致、禁止降级、脏目录阻断、并发锁、取消、隔离构建失败、准备完成、活动任务检查、健康检查失败、数据恢复顺序及恢复失败阻断。新增调度测试覆盖睡眠补查、实时修改、关闭周期检查、每日时段与跨午夜时段。真实运行和界面验证使用已经安装的 0.2.1-alpha.1；没有以真实用户数据执行一次未来版本切换。

## 从旧名称迁移

0.3.0 将安装包和插件详情页名称从 `dsh-safe-release-update` 缩短为 `dsh-update`。内部配置 id `safe-release-update`、RPC 方法、监督进程锁和 `~/.local/share/dsh-safe-release-update` 数据目录保留，避免丢失设置或备份。迁移前停止监督启动；移除旧 bundle 后添加新包。若移除操作清理了旧配置，需从备份恢复 `safe-release-update` 配置。不要同时启用两个 bundle。

## 社区发布

仓库添加 `dsh-plugin`、`deepseek-harness` 和 `dsh` topics；GitHub 主题页按标签收录，索引可能延迟。版本固定的安装包发布在 GitHub Releases。此仓库没有发布到 npm，GitHub topic 收录也不代表官方审核或兼容性认证。
