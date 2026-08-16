# Design System

## Direction

一份极简的私人申请档案。用户通常在宿舍或书桌前长时间填写和比较项目。界面只使用黑、白与两者混合产生的灰阶，神秘感来自排版秩序、细线和留白，不来自装饰性文字或低对比度。

## Color

- Strategy: Monochrome
- Canvas: `oklch(0.99 0 0)`
- Ink: `oklch(0.15 0 0)`
- Muted ink: `oklch(0.43 0 0)`
- Rule: `oklch(0.76 0 0)`
- Soft surface: `oklch(0.95 0 0)`

No chromatic accents. Selected states invert black and white. Never use decorative gradients.

## Typography

- Primary: `"IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace`
- Chinese fallback: `"Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace`
- Body: 14 to 16px, line-height 1.6
- Labels: 12px uppercase or compact Chinese, letter-spacing 0.06em
- Page title: 28 to 34px, weight 700
- Numeric probability: 34 to 44px, tabular numerals

Use weight, rules, alignment and whitespace for hierarchy. Do not use display fonts or gradient text.

## Layout

- Desktop content width: 1380px
- Two views only: one full-width information form and one probability report
- Forms: section label on the left, full-width controls on the right
- Lists use horizontal rules and consistent columns, echoing a technical resume
- Mobile collapses to one column; filters become an inline disclosure panel

## Components

### Header

Chinese product name and two plain navigation items only.

### Step rail

No step rail. Use two header items: 基础信息 and 概率档案.

### Form controls

Native inputs and selects with 44px minimum height. Choice chips are real checkbox or radio controls with visible focus states.

### Programme row

A ruled list row, not an isolated floating card. Shows school, programme, field relevance, probability interval, evidence count and one-line rationale. Expanded detail reveals sources and comparison cases inline.

### Probability

Always show an interval, evidence strength and decisive factors together. Do not present a naked score.

### Evidence record

Source type, cycle, anonymized background fields, offer result and URL. Demonstration records carry a prominent `DEMO` label.

## Motion

Use 180ms ease-out transitions for disclosure, selection and progress changes. Animate opacity and transform only. Disable nonessential transitions when `prefers-reduced-motion` is set.

## Voice

Direct, specific and calm. Prefer “找到 8 个可比案例” over “AI深度分析”。Prefer “信息不足，区间已放宽” over false certainty.
