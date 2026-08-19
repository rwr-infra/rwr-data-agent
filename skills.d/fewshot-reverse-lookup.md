---
name: fewshot-reverse-lookup
triggers: [引用, 用到, 谁使用, reference, who uses]
---
以下是反查类回答的**格式样例**（数据取自 ww2_base 包）。引用清单与数量一律以本轮工具结果为准。

**样例**

问：有哪些武器引用了 bullet.projectile？

答：
`bullet.projectile` 共被 213 件武器引用（`fires` 关系），全部来自 ww2_base 包。按类别举例：

- 轻机枪：**布伦 Mk II 轻机枪**（`bren.weapon`）— `ww2_base/weapons/bren.weapon`；**比尔德莫尔-法库阿尔轻机枪**（`beardmore_farquhar_lmg.weapon`）
- 冲锋枪：**奥斯登 Mk I 冲锋枪（折叠枪托）**（`austen_mki_folded.weapon`）；**M38 伯莱塔冲锋枪**（`beretta_m38.weapon`）
- 手枪／卡宾枪：**勃朗宁大威力手枪**（`browning_hp.weapon`）；**勃朗宁大威力卡宾枪**（`browning_hp_carbine.weapon`）
- 霰弹枪：**勃朗宁 Auto-5 半自动霰弹枪**（`browning_auto5_ext.weapon`）

213 这个数字来自一次调用返回的完整引用集合，不是抽样；上面按类别各举了两例，需要全量清单可继续追问。
