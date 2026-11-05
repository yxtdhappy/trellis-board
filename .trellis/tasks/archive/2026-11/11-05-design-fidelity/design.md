# 设计规范（像素基线）

## 画板与栅格

- 画板宽 **1440**；内容驱动高度，最小 900。页面主区左右内边距 20，模块纵向间距 12。
- 顶部栏 56 高，左侧栏 220 宽，主区 `fill_container`。
- 看板 4 列等宽，列间距 10，列内边距 10，列圆角 12、底色 `$--muted`。
- 卡片圆角 10、内边距 10、纵向间距 7，底色 `$--card`。

## 设计变量（取自 .pen）

| Token | Light | Dark |
| --- | --- | --- |
| background | #FFFFFF | #0A0A0A |
| card | #FFFFFF | #171717 |
| muted | #F5F5F5 | #262626 |
| border | #E5E5E5 | #FFFFFF1A |
| input | #E5E5E5 | #FFFFFF26 |
| foreground | #0A0A0A | #FAFAFA |
| muted-foreground | #737373 | #A1A1A1 |
| primary | #7008E7 | #5D0EC0 |
| radius | 10 | 10 |

## 字体尺度

| 用途 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- |
| 页面标题 | 19 | 600 | foreground |
| 副标题/说明 | 11.5 | 400 | muted-foreground |
| 分组标题（看板列名） | 12.5 | 600 | foreground |
| 卡片标题 | 12 | 600 | foreground |
| 正文/控件值 | 12 | 500 | foreground |
| 次级元信息 | 10 | 400 | muted-foreground |
| 徽章文字 | 9.5 | 600 | 对应前景 |
| kicker（英文小标题） | 10 | 600 | muted-foreground，字距 0.08em |

行高统一 1.45。

## 组件解剖

### Filter Select（新增设计系统组件）

```
Filter Select (horizontal, gap 6, alignItems center)
├─ Field Label   text 11.5 / 400 / $--muted-foreground
└─ Trigger       frame h=32, radius=6, stroke=$--input w=1, padding [0,10], gap 6, fill transparent
   ├─ Value      text 12 / 500 / $--foreground
   └─ Chevron    icon lucide chevron-down 14 / $--muted-foreground
```

- 触发器宽度 `fit_content`；值过长时最大 180，超长省略（设计稿用短值即可）。
- 禁用态：`opacity .5`，chevron 同 opacity。

### 视图切换条（Chips）

- 行高 26，gap 6，整体 `fit_content`。
- 选中：底 `$--primary`、文字 `$--primary-foreground` 11、圆角 999、padding [3,10]。
- 未选中：底 `$--card`、描边 `$--border` 1、文字 `$--muted-foreground` 11、圆角 999。
- 右侧摘要：`全部进行中 · 2026-11-05`，11 / `$--muted-foreground`，与 chips 同基线。

### 流动信号

- 卡片：底 `$--card`、描边 `$--border`、圆角 12、内边距 12。
- 左上 kicker `FLOW / 个人承载`，标题 `流动信号` 13/600。
- 右上：`WIP 软上限` 11 + 数字输入（h 28、w 56、描边 `$--input`、圆角 6、居中）+ `保存`（h 28、描边按钮）+ 提示文字 10.5。
- 信号网格：4 等分，每格 gap 2，标签 10.5 muted、数值 20/600、脚注 10 muted。
- 焦点建议：右侧 `建议优先：<任务标题>`，11，主色文字。

### 注意力队列

- 卡片描边 `$--border`、圆角 12、内边距 12；头部：kicker `ATTENTION QUEUE` + 标题 `注意力队列` 13/600 + 计数徽章 + 右侧 `逾期、截止、停滞与阶段信号` 10.5 muted。
- 行：h 34，分隔线 `$--border` 1px，标题 11.5/500、项目名 10.5 muted、原因标签为小徽章、右侧优先级徽章。
- 超过 6 行时容器高 6×34 + 边距，内部滚动（thumb 6px）。
- 脚注：`按逾期、截止、优先级、检查、实现和停滞排序。` 10 muted。

### 看板列

- 列头：色点 6 + 名称 12.5/600 + 计数徽章 + 说明（hover 提示）。
- 列体：`min height 260`，纵向 gap 7、padding 10，超出滚动（thumb 6px）。
- 任务卡：标题 12/600（最多 2 行）、元信息行（头像 18 + 负责人 10.5 + 截止 10 + 优先级徽章 9.5）、13 段证据条（每段 3px 高、gap 2、完成 `$--primary`、可选 `$--border`、缺证据 `$--muted`）、底行（分组标签 + 进度百分比）。

### 表格（归档 / 管理台）

- 表头：h 30，底 `$--muted`，文字 10.5/600 muted，左右 padding 10。
- 行：h 34，底 `$--card`，分隔线 `$--border`，悬浮底 `$--muted`。
- 行尾操作：`chevron-right` 16 / `$--muted-foreground`，右对齐，整行可点；不再使用 `→` 文本。
- 分页：按钮 28×28，圆角 6，当前页 `$--primary`。

### 滚动条（ScrollArea 表达）

- thumb：宽 6、圆角 999、填 `$--border`、距右缘 2；轨道透明。
- 出现位置：看板列体、注意力队列、详情弹层主体、归档表格、管理台长列表。
- 设计稿只画一条 thumb，不画轨道与箭头。

### Brand Mark（Trellis 桁架格）

```
Brand Mark  frame 24×24（大号 36×36）, fill $--primary, cornerRadius 6
└─ 格架  6 条线（3 竖 + 3 横），stroke $--primary-foreground, strokeWidth 2（大号 3）,
         strokeLinecap round, 线间距 4（大号 6）, 四周留白 5（大号 7）
```

- 24px 下：内容区 14 = 3×2 线 + 2×4 间距，正好排满，形成 3×3 格架。
- 视觉：紫色实底方块内一个镂空 `井` 形格架，代表 trellis；不要文字、不要渐变、不要阴影。
- 24px 下必须有清晰留白，线条不得粘连；深色模式仅底色随变量变浅紫。
- 位置：顶栏 24 / 登录页 36 / 管理台 24 / favicon 48。

## 浅/深一致性

- 深浅成对修改：底色、描边、次级文字、hover 底色四处必须同时检查。
- 深色禁用 `#FFFFFF` 直填，统一走变量。
- 深色 primary 用 `#5D0EC0`，其前景仍为 `$--primary-foreground`。

## 命名约定

- 顶层帧：`NN · 页面 · Light|Dark`。
- 区块帧：`Topbar / Sidebar / Main / Head / ViewBar / FlowSignals / Attention / Kanban / Lane <名> / Task <标题>`。
- 组件实例：`Sel <当前值>`；新增组件放 `shadcn: design system components` 帧内，名称 `Filter Select`。

## 状态标签清单（画板 19 同源）

统一形态：`padding [2,8]`、`cornerRadius 999`、字号 10.5 / 600。

| 分组 | 标签 | 底色 token | 文字 token | Light | Dark |
| --- | --- | --- | --- | --- | --- |
| 任务阶段 | 规划 | `--info-soft` | `--info` | #DBEAFE / #1D4ED8 | #172554 / #93C5FD |
| 任务阶段 | 待放行 | `--warning-soft` | `--warning` | #FEF3C7 / #B45309 | #451A03 / #FBBF24 |
| 任务阶段 | 实现 · 实现中 | `--primary-soft` | `--primary` | #EDE9FE / #7008E7 | #2E1065 / #5D0EC0 |
| 任务阶段 | 检查 · 检查中 · 检查·收尾 | `--success-soft` | `--success` | #DCFCE7 / #15803D | #052E16 / #4ADE80 |
| 优先级 | P0 · P0/P1 | `--destructive` | `--white` | #E7000B / #FFFFFF | #FF6467 / #FFFFFF |
| 优先级 | P1 | `--warning-soft` | `--warning` | #FEF3C7 / #B45309 | #451A03 / #FBBF24 |
| 优先级 | P2 | `--secondary` | `--secondary-foreground` | #F4F4F5 / #18181B | #27272A / #FAFAFA |
| 优先级 | P3 | `--muted` | `--muted-foreground` | #F5F5F5 / #737373 | #262626 / #A1A1A1 |
| 成功 | 成功 · 已启用 · 已产出 · 已同步 · 已应用 · 已批准 | `--success-soft` | `--success` | 同上 | 同上 |
| 等待 | 等待批准 · 待产出 · 待发布 · 等待推送 · 已过期 | `--warning-soft` | `--warning` | 同上 | 同上 |
| 异常 | 失败 · 已停用 · 需修复 | `--destructive-soft` | `--destructive` | #FEE2E2 / #E7000B | #450A0A / #FF6467 |
| 设备 | 在线 | `--success-soft` | `--success` | 同上 | 同上 |
| 设备 | 离线 | `--muted` | `--muted-foreground` | 同上 | 同上 |

新增变量：`--success`、`--success-soft`、`--warning`、`--warning-soft`、`--destructive-soft`、`--info`、`--info-soft`、`--primary-soft`（均带 Light/Dark 两套值）。
