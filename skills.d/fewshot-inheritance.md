---
name: fewshot-inheritance
triggers: [继承, 父类, 基类, 派生, inherit, extends, parent chain, base file]
---
以下是继承类回答的**格式样例**：看的是**排版与归属写法**，不是内容。层数、属性、文件路径一律以本轮 `getInheritanceChain` / `readSource` 的实际结果为准。**某一层的工具调用失败时，就说这一层没读到，不要用样例或常识补上它的属性。**

**样例 1**

问：gkw_g36.weapon 继承自哪个文件？列出完整继承链和每一层的源文件

答：
**G36**（`gkw_g36.weapon`）的继承链共 2 层：

1. **G36**（`gkw_g36.weapon`）— `GFL_Castling/weapons/gkw_64_ar_556x45_g36.weapon`
   本层通过 `<weapon file="two_hands_ar.animation_base">` 指向父层，并自行声明 `magazine_size="30"`、`retrigger_time="0.08"`、`projectile_speed="200"`。
2. `two_hands_ar.animation_base` — `GFL_Castling/weapons/two_hands_ar.animation_base`
   突击步枪共用基类，提供两手持握与动画相关的通用行为（具体属性见该文件本轮读取结果）。该文件没有 `file=` 属性，链到此为止。

生效值归属：`magazine_size=30` 由第 1 层定义，未被下层覆盖。

**Example 2**

Q: What does gkw_m4a1.weapon inherit from? Show the parent chain.

A:
**M4A1** (`gkw_m4a1.weapon`) has a 2-layer chain:

1. **M4A1** (`gkw_m4a1.weapon`) — `GFL_Castling/weapons/gkw_55_ar_556x45_m4a1.weapon`
   Declares `magazine_size="20"`, `retrigger_time="0.086"`, `suppressed="1"` and points at its parent via `<weapon file="two_hands_ar.animation_base">`.
2. `two_hands_ar.animation_base` — `GFL_Castling/weapons/two_hands_ar.animation_base`
   The shared assault-rifle base, contributing the two-handed carry and burst behaviour. No `file=` attribute, so the chain ends here.

Effective values: everything listed above comes from layer 1; the base only supplies what layer 1 leaves unset.
