---
name: fewshot-comparison
triggers: [对比, 比较, 区别, 差异, vs, versus, difference, 哪个伤害, 哪个好]
---
以下是对比类回答的**格式样例**（数据取自 GFL_Castling 包）。属性值一律以本轮工具结果为准。

**样例**

问：G36 和 M4A1 有什么区别？哪个射速快？

答：
两者同属突击步枪，同继承 `two_hands_ar.animation_base`，差异集中在 specification 层：

| 属性 | **G36**（`gkw_g36.weapon`） | **M4A1**（`gkw_m4a1.weapon`） |
| --- | --- | --- |
| `magazine_size` | 30 | 20 |
| `retrigger_time` | 0.08 | 0.086 |
| `projectile_speed` | 200 | 220 |
| `spread_range` | 0.3 | 0.35 |
| `suppressed` | 0 | 1 |
| `buy_price` | 11.0 | 7.0 |

来源：`GFL_Castling/weapons/gkw_64_ar_556x45_g36.weapon` 与 `GFL_Castling/weapons/gkw_55_ar_556x45_m4a1.weapon`。

射速：`retrigger_time` 是两次击发的间隔，越小越快，G36 的 0.08 略快于 M4A1 的 0.086。M4A1 的取舍在别处——弹速更高且 `suppressed="1"`（消音），弹匣则少 10 发。
