执行迁移 gate 02（缺口清单）。

1. 确认依赖图/功能地图已签。
2. 读 `migration/prompts/02-gap-inventory.md`。
3. 先完成 20 行样例，写入 `migration/inventory.tsv`。
4. 展示这 20 行和分类计数，停下等人工确认。
5. 人工确认后再全量盘点；每次只改自己的 shard，不并发写同一文件。
