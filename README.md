# 移动工作区插件（dsh-portable-workspace）

让 DeepSeek Harness 在移动硬盘 / U 盘上创建**完全自包含的便携工作区**：会话、插件、工程文件、交付、日志、账号凭据全部落在盘上；拔盘显示脱机，插盘自动重新识别；换一台装了本插件的电脑即可继续工作。

**功能特点（0.1.5 补全）**：①完全自包含 100% 不落本地，移动便携工作，不惧换电脑、不惧重装系统；②独立便携 web 实例，可多开实例、独立插件配置环境；③盘符无关识别 + 脱机；④scrypt 密码 + 一次性恢复密钥 + 密码提示 + 查看型入口先验密码；⑤缺插件一键装 / 短名解析 / 兼容预检 / 按清单重装；⑥跨盘·本机会话双向迁移 + .zip 备份恢复 + 改名；⑦升级友好、零依赖、离线可用。兼容 DeepSeek Harness ≥ 0.2.1-rc.5（无上限，覆盖其后的正式版与预发布版）。

## 安装

在每台需要读取移动工作区的电脑上，把本目录安装进当前 DSH profile：

```
plugin_manager  install_bundle  <本目录绝对路径>
```

安装后侧栏「全局面板」多出「移动工作区」入口。修改 JS 后需 `set_bundle false → true` 重载（或重启 DSH）。

> 本插件自身是**按电脑安装**的（这是需求明确允许的前提）；移动盘上不需要预装它——打开工作区时，便携实例由本机 DSH 的 CLI 启动。
> 安装用的是 `link:` 软链接（本机 profile 只记一条指向该目录的路径），**所以这个目录不要移动或删除**；换位置需重新 `install_bundle`。
> 完整的分步截图教程见 [docs/移动工作区-图文教程.html](docs/移动工作区-图文教程.html)（单文件、图片内嵌，双击即可打开）。

## 卸载

卸载是**按电脑**进行的，只移除本机 profile 里那条 `link:` 软链接，**不会删除移动盘上的任何数据**；换一台仍装了插件的电脑插上盘照常打开。

1. 先在「移动工作区」面板点「关闭全部便携实例」（或逐个「登出」），避免残留 detached 进程继续占用安装文件。
2. 停用并移除 bundle（顺序不要反）：
   ```
   plugin_manager  set_bundle    dsh-portable-workspace  enabled=false
   plugin_manager  remove_bundle  dsh-portable-workspace
   ```
   `enabled=false` 会触发插件的 dispose 清理钩子，`remove_bundle` 再从 dependencies / `dsh.profile.bundles` 删除该记录；也可在「插件」面板里停用 → 移除。
3. 刷新/重启 DSH，侧栏「移动工作区」入口消失即完成。
4. （可选）删除本机桥梁 `~/.dsh/portable-workspace/roots.json` 以忘掉记住的卷（只记根路径，无工作区数据）；再删除解压出来的插件目录。

> 盘上 `Portable-DSH\` 全部保留。卸载 ≠ 删除工作区；要销毁某个工作区请用面板「删除」（固定文字 + 密码双确认），或卸载后手动删盘上对应目录。用「市场 Discover / 按包名」安装的卸载方式相同，执行第 2 步即可。完整图文见[教程第九节](docs/移动工作区-图文教程.html)。

## 盘上目录约定

主目录名为 `Portable-DSH`（0.1.1 起）；0.1.0 及更早初始化的盘叫 `Protable-DSH`，插件两种拼写都识别，旧盘不用改名：

```
<盘>:\Portable-DSH\
├─ .dsh-portable.json         根标记（kind/rootId/format），盘符无关识别的唯一桥梁
├─ Portable-Workspaces\      各工作区数据
│  └─ <ws-id>\
│     ├─ workspace.json       清单：名称、密码 scrypt、插件声明、profile、origin
│     ├─ sessions\            会话日志（.jsonl.zstd）
│     ├─ storages\            存储域 / 会话投影缓存 / workspace registry
│     ├─ logs\                launch.log、plugins.log
│     ├─ launch\              cordis.patch.yml、start-portable.cmd、runtime.json
│     └─ ...
├─ Projects\<ws-id>\         工程文件与交付（默认工作目录也指向这里）
└─ support\
   └─ home\                  便携 DSH_HOME：profiles/portable/、.credentials.yaml 等
```

面板里的「初始化这块盘」创建根标记与三个目录；「新建移动工作区」创建工作区，密码可留空。

## 工作原理（为什么 100% 落在盘上）

打开工作区时，插件生成一个 `--patch` 覆盖层并启动**独立的便携实例**：

```
DeepSeek Harness.exe --expose-internals <cli.js> portable \
    --patch <工作区>/launch/cordis.patch.yml --port 0 --no-open
```

- `DSH_HOME` 指向 `<root>/support/home` → profile、附件、storages 全在盘上；
- patch 覆盖 `session-persistence-jsonl.root` / `storage-json.root` → 会话与存储落在工作区目录，多个工作区互不混淆；
- patch 覆盖 `working-directory.defaultDirectory` 与 `workspace-controller.documentsDirectory` → 工程与交付落在 `Projects/<id>`；
- patch 覆盖 `agent-default-model` → `provider: deepseek-account, model: deepseek-flash`，使用「同步本机登录」复制上盘的 DeepSeek 账号 grant，无需另配 API Key；
- 便携实例是 CLI web host（`ELECTRON_RUN_AS_NODE=1`），**不启动 Electron 桌面壳**，因此没有 Electron `userData` 落本地的问题；
- 每个实例用随机端口 + token，在独立窗口打开，不污染本机桌面版。

## 使用流程

1. **初始化 / 扫描**：插盘后点「重新扫描」；盘符变化也能识别（靠根标记文件 + 本机 `roots.json` 里记住的非盘符路径）。拔盘后该卷进入「脱机的盘」区，显示「移动盘未连接」。
2. **打开**：先验证密码（scrypt + 恒定时间比较，错误密码拒绝启动）。创建时的密码框要求输入两次并带「小眼睛」明文查看。通过后检查工作区声明的插件清单：
   - 缺少 → 弹「缺少插件」对话框，区分必需 / 可选，给出「一键安装缺失插件」「连可选插件一起装」「跳过，直接打开」；
   - 安装 = 用随包 pnpm 在便携 profile 里 `add`，并把带 `dsh.bundle` 的包追加进 `dsh.profile.bundles`（否则装了也不会被加载）；
   - 兼容性预检（`engines.dsh` / `@deepseek-ai/*` peerDependencies 与本机 DSH 版本比对）：冲突时列出原因与处理方案，但**不阻断**安装/启动（最终由 Loader 裁决）；
   - 可选插件 / 冲突都允许跳过，装完重开不会二次弹密码框。
   - **解锁态只在 Host 进程内存里，不落盘**：登出、DSH 重启、插件重载、拔盘重扫、换盘符都会让它失效 → 再次打开重新验密码。
3. **同步本机登录 / 退出登录**（可选，单向）：把本机 `.credentials.yaml`、`.anonymous-user-id` 复制到盘上的便携 home，永不从盘回写本机；「退出登录」删掉盘上这两个文件。这样换电脑不必重新登录。
4. **工作区行按钮**：打开 / 登出 / 修改密码（旧密码 + 新密码 + 确认新密码）/ 添加插件 / 迁移 / 删除。删除须**手动输入固定文字**「我已知晓删除该工作区，无法恢复！」并**输入密码**（无密码留空），客户端与 Host 双重校验，防止误删或绕过接口。
5. **添加插件到这块盘**：从 npm 官方源下载安装到移动盘的便携 profile（**不是从本机复制**），成功后自动激活 bundle，重启便携实例生效。内置**短名解析**：市场里的 `dsh-web-all` / `modlens` 会自动补全为真实包名 `@linxin666/dsh-web-all` / `@liustack/modlens`，并在最新版不兼容本机 DSH 时自动选最新兼容版本（如 `@linxin666/dsh-web-all@0.4.14`）；404 时给出「可能需要 scope 前缀」提示。
6. **迁移**：「迁移」对话框可把工作区复制到另一块盘或本地硬盘路径，可勾选「迁移后删除源工作区」。迁移会：
   - 重写 `workspace.json` 的 `rootId` 并记 `origin`；
   - 重写每份会话日志 header 里的绝对 `cwd`，并把会话目录收拢到新 `projectKey(cwd)`（否则 jsonl 后端会判 corrupt）；
   - 同步修正 workspace registry 的默认工作目录；
   - 新路径写入本机索引，重新扫描即可识别（非固定盘符）。
   - **0.1.2 起 · 有密码须确认**：源工作区设了密码时，迁移对话框会多出「工作区密码」一栏，必须填对密码才开始迁移；密码错会提示「工作区密码不正确。」并拒绝迁移，避免绕过密码把加密工作区整体搬走。没设密码的不受影响。
   - **0.1.2 起 · 插件清单跟着走**：迁移会把源盘便携 profile 里装过的插件清单写进新工作区的 `workspace.json`（`plugins`），迁移完成提示会写明「已把 N 个插件写入清单」。下次打开该工作区会弹「缺少插件」→ 点「一键安装缺少的插件」即从 npm 装到目标盘；安装结果写在 `logs/plugins.log`。
   - **为什么迁移后目录大小不一样**：`support/home`（整块盘共享的插件与账号数据，含几百 MB `node_modules`）按设计不随工作区搬迁，迁移只复制工作区数据（会话、工程、日志）。所以新根目录明显小于旧根是正常现象，不是数据丢失。
7. **改名（0.1.3 新增）**：在工作区行点「改名」→ 弹框里把名字改成新的（不能和同一块盘上已有工作区重名）→ 点「确认改名」。看到列表里的名字立刻变新、会话和工程目录都没动，就是成功。
8. **会话迁移（0.1.3 新增）**：点「会话迁移」→ 先选**来源**（「当前工作区」或「本机普通 DSH 会话」）→ 列表里勾选要搬的会话（可点「全选」）→ 选**目标**（另一块盘上的任意工作区，或「本机」）→ 想搬走而不是复制就勾「迁移后删除源会话」→ 点「开始迁移」。成功后在新工作区里能看到这些会话、打开不报损坏；选中的会话对应的**工程文件 / 交付物**也一起搬过去。（0.1.4 起列表显示**会话主题名称**，不再是一串 uuid 码；**有密码的工作区**点进来会先弹「先验证工作区密码」，填对才显示列表，保护会话标题隐私）。
   - 会话日志、`session_projcache` 缓存、workspace 注册表里写死的绝对盘符路径都会自动改写，所以换盘 / 换电脑仍能打开。
   - 支持「移动盘工作区 ↔ 本机普通 DSH 会话」双向；来源和目标不能是同一个（Host 端也会拦，避免自己覆盖自己）。
9. **备份 / 恢复（0.1.3 新增）**：点「备份恢复」→ 在「最多保留 N 份」填数字（默认 5、上限 50）、按需勾「打开时自动备份」→ 点「立即备份」，列表里多出一条带时间戳的备份即成功（0.1.4 起快照打成**压缩包** `Portable-Backups/<工作区>/<时间戳>.zip`，里面含 `workspace/`、`project/` 和 `backup.json`；旁边一份同名 `.json` 记备份信息，列表里带「ZIP」标记的就是它。恢复时兼容 0.1.3 及更早留下的旧「散目录」备份，照常能选、能恢复）。恢复时：列表里选一份 → 选「恢复到」的目标（可以是另一块盘的工作区，也可以恢复到别的已有工作区）→ **手动输入固定文字**「我已知晓恢复操作将覆盖原有移动工作区，请谨慎操作！」→ 输入**被覆盖那个工作区**的密码（没设密码留空）→ 点「确认恢复」。客户端和 Host 都会校验文字与密码，少一样都不执行；恢复会先自动留一份「覆盖前」快照再整份覆盖，并重写会话 / 注册表 / 启动脚本路径。
10. **忘记密码也能找回（0.1.4 新增）**：新建工作区或「修改密码」时，弹框里多一栏「密码提示」（选填，写一句只有你自己看得懂的提醒，例如「第一只猫的名字」）。设好密码点确认后，会弹出一个「恢复密钥」窗口，里面是一串 `XXXX-XXXX-XXXX-XXXX` 的字符 —— **这串码只显示这一次，关掉就再也看不到**，立刻用纸笔抄下来或存进密码管理器，再点「我已抄好」关掉。以后在解锁框点「忘记密码？」→ 填这串恢复密钥 → 填两遍新密码 → 点「重设密码」，看到提示「已重设」并能用新密码打开即成功。旧密钥用完立即作废，系统会再弹一串**新的恢复密钥**，同样抄走。没设密码的工作区不产生恢复密钥；密码提示只在解锁框下方显示你写的那句提醒，不会暴露密码本身。
11. **有密码的工作区，更多操作要验证密码（0.1.4 新增）**：0.1.2 起「迁移」、0.1.3 起「删除 / 修改密码 / 恢复」已经要密码；0.1.4 再把「添加插件、改名、会话迁移、备份恢复」也补上 —— 这些弹框在**有密码的工作区**上会多出「工作区密码」一栏，填对才执行，填错提示「工作区密码不正确。」并拒绝。其中「会话迁移」更严格：有密码的工作区点进去**先弹一个「先验证工作区密码」的小框**，填对才让你看到会话列表（列表现在显示的是**会话主题名称**，没主题的显示「（无主题）」并带 id 前 8 位），防止别人绕过密码偷看会话标题。没设密码的工作区不受影响，照旧直接操作。

## 跨电脑

在另一台电脑上：插盘 → 装本插件 → 侧栏打开「移动工作区」→ 扫描/识别 → 输入密码 → 打开。前提是该电脑装了 DeepSeek Harness（版本越接近越好）；缺插件会提示并一键安装到**盘上的便携 profile**。会话与工程文件与本机完全无关。

## 工作机制与依赖

每个工作区 = 移动盘上的一份独立 DSH 数据 + 本机 DSH 启动的一个独立 CLI 实例。打开时生成 `--patch` 覆盖层并启动便携实例（见上文「工作原理」）。依赖全部是本机已有之物，**无需额外安装**：

- **本机 DeepSeek Harness**：用它的 CLI（`dsh-desktop-host/lib/cli.js`）、随包 node、随包 pnpm、asar 内的基础 bundles。插件本身**零 DSH 包依赖**，服务都从 `ctx` 运行时取得。
- **npm 官方源可达**：仅「安装插件」时需要联网下载；已装过的插件全在盘上，离线也能开。
- **盘上标记文件** `.dsh-portable.json`：盘符无关识别的桥梁；本机仅残留一个索引 `~/.dsh/portable-workspace/roots.json`（只记路径，不含任何工作区数据）。

## DeepSeek Harness 升级时，插件如何同步更新

结论：**插件不会随 DSH 升级「自动更新」，但也不会被升级删掉，通常升级后照常可用**。分两类看：

| 对象 | 存在哪里 | DSH 升级时 |
| --- | --- | --- |
| 插件本体 `dsh-portable-workspace` | 本机目录，以 `link:` 挂在当前 profile 的 dependencies / bundles 里 | profile 配置持久，升级不会动它；代码在那个目录，**原地保留** |
| 便携实例的基础 bundles（`@deepseek-ai/dsh-base` 等） | 本机 DSH 安装目录的 `app.asar` 内 | 随 DSH 升级自动更新 —— 便携实例每次启动都读**本机当前版本**的 CLI 与 asar |
| 工作区数据（会话 / 工程 / 日志 / 便携 home） | 移动盘 | 完全不受影响，一直在盘上 |
| 工作区依赖的第三方插件 | 移动盘上的便携 profile | 不随 DSH 升级变，版本由你自己添加时决定 |

- **★ 升级前先点「关闭全部便携实例」**：这一步会按命令行扫描并终止所有 `detached` 便携 CLI 及其 recovery 子进程、清空运行态，并**清除本机 `~/.dsh/portable-workspace/roots.json` 根路径索引**（升级完成后点「重新扫描」即可从盘上 `.dsh-portable.json` 标记文件恢复，索引只记路径、无工作区数据）。它释放便携实例对 `DeepSeek Harness.exe` / `app.asar` 的占用，也让本插件在升级窗口内不再持有「已拔掉的离线盘」路径去做磁盘探测。工具 `stop-all` 可脚本化完成这一步。
- **★ 常规升级仍失败时（重要，实测结论）**：弹窗「未能安全停止任务，更新尚未安装，请稍后重试。」及技术详情 `graceful deadline exceeded true / shutdown acknowledged true`，根因在 DSH 升级器自身，**不是文件被锁、也不是某一个插件**：升级器要求 desktop host 在 **10 秒内真正退出进程**（并发过 IPC `shutdown-complete`）；host 里只要有关不干净的子进程、或关闭钩子把所有 `ctx.effect` disposer 用 `await Promise.allSettled` 等齐拖过 10 秒，主壳就 `SIGTERM` 强杀并抛 `DesktopHostUncleanExitError` → `preparationFailure="stop-failed"` → 拒绝安装 → `restoreHost` 重新拉起 host（端口反复变化、「重新连接中...」）。`shutdown acknowledged true` 恰恰说明 host 已完成关闭流程、只是进程没按时退出。删 playwright、禁用 MCP 连接器、关便携实例都动不了这条计时，所以仍会失败。本插件此前在关闭钩子里会枚举进程、探测 24 个盘符、读取 `roots.json` 记住的**已拔掉移动盘**上的标记文件（无超时），会占用那 10 秒窗口；现已改为关闭钩子**纯同步、零磁盘 I/O**，盘符探测统一 1200ms 超时，`roots.json` 在「关闭全部便携实例」时清空。★ 2026-11-09 更正：这个「关闭钩子发完 shutdown-complete 却漏掉 process.exit()」是官方 host 的 bug，已在 DeepSeek Harness 0.2.2-rc.1 修复，本机隔夜常规升级已成功。升级到 0.2.2-rc.1 及以后，正常点「更新」即可，不再需要任何绕过操作。仅当仍卡在 0.2.1-rc.3 等旧版、无法先升级时，才用下面这条手动安装器的办法。
  **仅旧版 0.2.1-rc.3 需要的兜底办法（0.2.2-rc.1 及以后不需要）**：任务管理器里**完全退出所有 `DeepSeek Harness.exe` 进程**（含主窗口、托盘、desktop host），再手动双击运行已下载好的安装器 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\deepseek-harness-0.2.2-rc.1-win-x64.exe`（NSIS 安装器，可直接运行）。它不经过 host 的 10 秒优雅退出；装完确认 exe 版本已变即可，之后重开移动工作区、点「重新扫描」。（仅旧版需要；0.2.2-rc.1 及以后直接常规升级即可。）
- **关于本机产物是否影响升级**：插件在本机生成的 `roots.json`（路径索引）、profile 里的 `link:` 软链接与 `dsh.profile.bundles` 条目、web 路由 / agent tool 注册都是静态数据，**不锁 `DeepSeek Harness.exe` / `app.asar`（锁来自运行中主 GUI / desktop host 自身），也不拖慢安装器替换文件**。软链是插件安装本体，删它等于卸载，不应删；唯一被采纳进「关闭全部便携实例」的清理项是清空 `roots.json`，升级后重新扫描即可。

- **正常升级**：只换掉安装目录里的程序与内置 bundles；插件是软链接，profile 里那条 `link:` 记录还在，重启后自动加载，无需操作。
- **便携实例会自动「跟上」新 DSH**：每次打开工作区都用本机**当前**的 `DeepSeek Harness.exe` + `cli.js` 启动，所以升级后下次打开，便携实例就跑在新版上。
- **要重新验一次密码**：升级/重启 DSH 会清掉进程内的解锁状态（安全设计），重新输一次即可。
- **兼容性 / 支持的 Harness 版本**：插件在 `package.json` 里声明 `dsh.engines.dsh >= 0.2.1-rc.5`（`>=` 无上限，覆盖 0.2.1-rc.5 及其后的 0.2.1 正式版、0.2.2-rc.1 与更后续的正式版 / 预发布版）；实测下限为 0.2.1-rc.5，更早的 0.2.1-rc.3 / 0.2.0 未做完整功能回归，不承诺可用。其余能力都通过公开 Service / `ctx` 取得，一般跨小版本可用。若升级后内部契约变化导致面板报错，把插件目录代码更新到适配版，再 `set_bundle false→true` 重载即可 —— 数据仍在盘上，不丢。
- **版本差异导致的「隐藏插件」**：市场按新版 `engines.dsh` 重新过滤；升级到 ≥0.2.2-rc.1 后，原本被隐藏的 `dsh-web-all 0.4.15` 之类会重新出现。
- **想让插件本体也升级**：把新版文件覆盖到原目录（保持路径不变）→ `set_bundle false→true` 重载（或重启 DSH）；换位置则重新 `install_bundle <新路径>`。整个过程**不需要动移动盘**。

## 已知边界（实测结论，非缺陷）

- **本机 DSH 必须存在**：插件只负责组织数据，运行仍依赖本机安装的 DSH（用其 CLI、随包 node/pnpm）。这是"只要安装了这个移动工作区插件"之外的隐含前提。
- **本机唯一残留 = 一个索引文件** `~/.dsh/portable-workspace/roots.json`：只记录已知移动工作区根路径（用于拔盘后显示脱机、迁移后识别非盘符路径），不含会话/插件/工程/交付/日志。
- **凭据**以明文 YAML 形式随盘携带，请保管好 U 盘；不想带账号就不要点「同步本机登录」。
- **exFAT 无硬链接**：pnpm 只能复制文件，冷装一个带 170 个传递依赖的插件实测约 5 分钟；装过一次后 profile 的 node_modules 留在盘上，下次秒开。
- **兼容性冲突是建议性的**：真正的版本红线由 DSH Loader 在启动时裁决，本插件只提前告知并给处理方案。
- 物理拔插未做真实断电测试（用移除根标记模拟），跨电脑未做双机实测（只有一台机器）；其余 6 条需求均在 H: 真实 U 盘上全流程验证通过。

## 交付内容

```
index.js           Host 半：路由、Agent 工具、工作区 CRUD/加载/迁移/密码/插件清单
client.js          Client 半：侧栏图标 + 主页面 + 各对话框（React slot）
lib/
  asar.js          零依赖 asar 读取（Electron 内用 original-fs）
  compatibility.js 零依赖 semver 子集 + 兼容性预检
  constants.js     常量
  credentials.js   单向账号同步
  fsx.js           文件系统助手
  launcher.js      便携实例进程管理
  names.js         市场短名 → 完整包名解析、兼容版本挑选、404 提示
  process.js       便携实例进程枚举 / 精确过滤 / 树杀（升级前释放文件锁）
  profile.js       profile 脚手架 / 插件清单 / pnpm 安装 / 激活 bundles
  sessions.js      会话日志 cwd 重写（迁移用）
  volumes.js       盘符无关识别
  workspace.js     工作区清单、密码、根标记、迁移、launch patch
locale/{zh,en}.json、icon.svg、cordis.patch.yml、package.json
scripts/           smoke / verify2 / launch-test / set-plugins（零 DSH 依赖验证脚本）
docs/              移动工作区-图文教程.html（单文件、图片内嵌）+ images/（6 张实机截图）
```

`node --check` 全部通过；`plugin_manager list_plugins` 中 `include:portable-workspace` 为 `active`。
