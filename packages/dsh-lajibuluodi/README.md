# DSH-lajibuluodi

**每轮任务一个包，回收站不再是一堆看不懂的临时文件。**

DSH-lajibuluodi 是 DeepSeek Harness 的 host 插件。它在每个 agent 任务轮次结束时，把该轮从工作区消失的文件收拢成一个带任务标题、时间和轮次号的 ZIP，作为**一条**记录放进 Windows 回收站。

## 它解决什么问题

Agent 跑完一个大任务后，回收站里经常躺着几十个 tmp_verify.png、tmp_hero.jpg、a1b2c3.tmp 之类的东西：

- 打开回收站卡顿，条目太多；
- 名字没有意义，不敢清空；
- 想找回某个被删的文件，根本对不上号。

DSH-lajibuluodi 把同一轮的所有丢弃文件装进一个包：

~~~
DSH-20261109-002021-修复登录页-c0b16a-T1.zip
  manifest.json          任务信息、原始路径、大小、时间
  files/...              按原相对路径保存的文件
~~~

回收站里每轮只多一条记录，名字可读，内容可查，也能用 /lajibuluodi restore 还原到原位置。

## 工作原理

1. 每轮 turn/start 时，插件在工作区同卷的私有目录里建立一棵**硬链接镜像**（不复制文件内容，开销很小）。
2. 运行期间用文件监听 + 每次工具调用前的增量扫描，把新出现的临时文件也补进镜像。
3. turn/end 时对比镜像和实时工作区：
   - 镜像里有、工作区没有、inode 也已消失 → 判定为**删除**；
   - inode 还在别的路径 → 判定为**改名/移动**，跳过；
   - 文件被覆盖但路径还在 → 不算删除，不打包。
4. 把删除的文件写成 ZIP（manifest.json + files/），用 Windows 的 SendToRecycleBin 投进回收站。
5. 在 outbox 旁记录 packages.jsonl，供 /lajibuluodi list 和 restore 使用。

> DSH 本身的 Remove-Item / fs.rm 都是永久删除。安装本插件后，这些删除会在轮次结束时变成一条可恢复的回收站记录。

## 安装

### 前提

- Windows 10/11；
- DSH desktop / web / headless 任一 profile；
- 工作区所在卷可写（默认数据目录在卷根，例如 C:/.dsh-lajibuluodi）。

### 安装到某个 profile

以 desktop 为例（**请先备份 profile**）：

~~~powershell
$profile = "$env:USERPROFILE/.dsh/profiles/desktop"
$dsh = 'C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'  # 改成你的 DSH 安装路径
$repo = (Get-Location).Path  # 在仓库根目录执行
Copy-Item "$profile/package.json" "$profile/package.json.bak" -Force

# 1) 把本地包加入 profile 依赖；dsh plugin 通常会自动把 bundle 写进 dsh.profile.bundles
& $dsh plugin --profile desktop add "file:$repo/packages/dsh-lajibuluodi"

# 2) 兜底：确认/补上 dsh.profile.bundles
$pkg = Get-Content "$profile/package.json" -Raw | ConvertFrom-Json
if ($pkg.dsh.profile.bundles -notcontains 'dsh-lajibuluodi') {
  $pkg.dsh.profile.bundles += 'dsh-lajibuluodi'
}
$json = $pkg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText("$profile/package.json", $json, [Text.UTF8Encoding]::new($false))
~~~

重启 DSH，或在 Plugins 页面触发 profile 重载。启动日志里出现：

~~~
[lajibuluodi] active; data roots are resolved per workspace volume
~~~

即表示插件已加载。

> 不建议直接改正在使用的 desktop profile。更安全的做法是复制一个测试 profile，确认行为后再装到 desktop。

### 建一个隔离测试 profile

~~~powershell
& $dsh --profile laji-test --from-default-profile web --dump-config
~~~

具体可用模板以 dsh --help / profile 目录为准。然后按上面的步骤把 dsh-lajibuluodi 加入 laji-test。

## 使用

插件默认**全自动**，不需要模型调用任何工具。

### 斜杠命令

~~~
/lajibuluodi status            当前轮捕获状态、数据目录、最近一个包
/lajibuluodi list [n]          最近 n 个任务包
/lajibuluodi restore <id|名>   从回收站恢复任务包（默认不覆盖已有文件）
/lajibuluodi restore <id|名> --overwrite
/lajibuluodi package           立即结束当前轮并打包
~~~

restore 会：

1. 优先用 outbox 里还没投递的 ZIP；否则按原始路径从 $Recycle.Bin 找到 $R... 文件；
2. 解压到私有缓存；
3. 读 manifest.json，按原始路径把文件写回工作区；
4. 默认跳过已存在的文件，--overwrite 才覆盖。

> 在资源管理器里对 ZIP 点“还原”，只会把 ZIP 还原到 outbox；要还原里面的文件，请用上面的命令。

## 配置

在 profile 的 cordis.patch.yml 里按 row id 覆盖：

~~~yaml
- id: lajibuluodi
  config:
    dataDir: 'D:/DSH-trash'
    exclude:
      - .git
      - node_modules
      - tmp
      - '*.log'
    maxFiles: 20000
    maxPackageFiles: 5000
    maxPackageBytes: 1500000000
~~~

| 配置 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关 |
| dataDir | 空 | 空 = 工作区所在卷根下的 .dsh-lajibuluodi；跨卷时自动退化为复制 |
| exclude | 常见构建/依赖目录 | 不参与快照的路径；支持目录名、*、?、a/b 前缀 |
| maxFiles | 20000 | 单轮最多快照的文件数，超出会截断并告警 |
| maxPackageFiles | 5000 | 单包最多打包文件数 |
| maxPackageBytes | 1500000000 | 单包最大字节数 |
| maxCopyBytes | 67108864 | 硬链接失败时允许复制的单文件上限 |
| scanIntervalMs | 5000 | 后台全量扫描间隔 |
| beforeToolBudgetMs | 1500 | 每次工具调用前扫描的等待预算 |
| keepSnapshots | false | 打包后保留快照（调试用） |
| packagePrefix | DSH | 包名前缀 |
| packageNameMaxLength | 120 | 包名最大长度 |

## 限制与注意事项

- **同一工具调用内“创建后立即删除”的文件**可能抓不到：快照发生在工具调用前，文件监听也不保证能抢在删除前看到它。跨工具调用的临时文件（最常见的情况）可以抓到。
- 只处理**删除**；覆盖、改名、移动不打包（改名会通过 inode 识别并跳过）。
- 工作区文件数超过 maxFiles 时快照截断，超出部分无法恢复。
- 单文件/单包超过上限时会在 manifest.json 的 skipped 里记录，不会中断整个包。
- 非 Windows：ZIP 会留在 outbox，不会进回收站。
- ZIP 里是**明文文件内容**，包括可能的密钥、.env、客户数据。请把敏感路径加入 exclude，或不要把本插件装在含高敏感数据的机器上。
- 插件在 DSH host 进程内运行，数据目录在工作区卷根，不受工作区文件沙箱限制；agent 不能写这个目录。

## 开发与测试

~~~powershell
# 在仓库根目录执行
node --test "packages/dsh-lajibuluodi/test/*.test.js"
~~~

测试覆盖：

- 包名清洗 / 截断；
- exclude 规则；
- 硬链接快照、删除检测、改名跳过；
- 单轮打包 → 回收站 → 恢复；
- 多轮分别打包、空轮不打包。

测试会真实写入回收站并在结束时清理对应的 $I / $R。建议在测试机上跑。

## 目录结构

~~~
packages/dsh-lajibuluodi/
  cordis.patch.yml      loader bundle patch
  src/
    index.js            插件入口、事件挂载、/lajibuluodi
    manager.js          每轮编排、命名、清单、恢复
    snapshot.js         硬链接镜像、watch、删除检测
    archive.js          ZIP 打包/解压（.NET ZipFile）
    recycle.js          回收站投递、$I 解析、按原始路径找 $R
    packages.js         outbox + packages.jsonl
    naming.js           Windows 安全包名
    excludes.js         路径排除匹配
    options.js          配置默认值与校验
    config.js           Schemastery schema
  test/
~~~

## License

MIT
