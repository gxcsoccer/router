/**
 * 人工标注的两个窗口。规则：
 * - `new`：产生一个需要"交付物 + 跟进"的任务（方案、对比、审片、issue 复核…）；
 * - `continue`：在同一任务上补充约束、追问细节、要求改稿；
 * - `chitchat`：一句能直接回答的话、寒暄、能力询问，不需要建票；
 * - `stop`：明确叫停（本语料里没有合规样本，故未使用）。
 *
 * 存的是轮次与意图，不是聊天原文；正文在运行时从导出文件读取。
 */
import type { LabelSet } from './aime.ts'

export const LABELS: LabelSet[] = [
  {
    id: 'window-a',
    title: '开场：GitHub 授权 → 完整推广方案 → 竞品对比',
    fromTurn: 1, toTurn: 16,
    tasks: [
      { id: 'gh-access', title: '打通 deskmind-ai 私有仓库访问' },
      { id: 'launch-plan', title: 'DeskMind 开源推广完整方案' },
      { id: 'competitor', title: 'Ollaya 竞品对比与性能参数' },
    ],
    // 授权在用户确认完成后结束；方案在要求加速之后交付，之后的追问才是续接。
    closeOn: { 'gh-access': 5, 'launch-plan': 15 },
    labels: [
      { turn: 1, intent: 'chitchat', why: '能力询问，直接答' },
      { turn: 2, intent: 'new', task: 'gh-access', why: '一个要动手排查的交付：能否访问组织仓库' },
      { turn: 3, intent: 'continue', of: 'gh-access', why: '同一件事的下一步：如何授权' },
      { turn: 4, intent: 'continue', of: 'gh-access', why: '问自己该做什么，仍是同一任务' },
      { turn: 5, intent: 'continue', of: 'gh-access', why: '确认完成' },
      { turn: 6, intent: 'new', task: 'launch-plan', why: '新的交付物：完整推广方案' },
      { turn: 7, intent: 'continue', of: 'launch-plan', why: '补充目标与约束（不付费、蹭 jev/decision api）' },
      { turn: 8, intent: 'continue', of: 'launch-plan', why: '方案要用的技术证据（SOTA 目标）' },
      { turn: 9, intent: 'continue', of: 'launch-plan', why: '追问套路的指标' },
      { turn: 10, intent: 'continue', of: 'launch-plan', why: '要求以操盘者身份给建议' },
      { turn: 11, intent: 'continue', of: 'launch-plan', why: '要求结合实时声量' },
      { turn: 12, intent: 'continue', of: 'launch-plan', why: '是否蹭热度，同一方案问题' },
      { turn: 13, intent: 'continue', of: 'launch-plan', why: '要 action 与节奏' },
      { turn: 14, intent: 'continue', of: 'launch-plan', why: '要量化目标与监控' },
      { turn: 15, intent: 'continue', of: 'launch-plan', why: '要求加速，同一方案' },
      { turn: 16, intent: 'new', task: 'competitor', why: '新交付：与 Ollaya 的优缺点和参数对比' },
    ],
  },
  {
    id: 'window-b',
    title: '审片三版 + issue #9 + 突然转到"翡翠"英文',
    fromTurn: 33, toTurn: 46,
    tasks: [
      { id: 'coach', title: '以开源教练身份提可执行需求' },
      { id: 'video-review', title: 'Issue #8 样片评审与拍摄建议' },
      { id: 'issue9', title: 'Issue #9 独立跑通复核' },
      { id: 'feicui', title: '翡翠的英文说法' },
    ],
    // 第 7 轮把审片建议写进 issue，视为交付完成；第 9 轮发来 v4 就是一次 resume。
    closeOn: { 'video-review': 7 },
    labels: [
      { turn: 1, intent: 'new', task: 'coach', why: '改变协作方式，产出 issue 需求，是一个持续任务' },
      { turn: 2, intent: 'continue', of: 'coach', why: '同一语境下判断 Brain 是否有爆点' },
      { turn: 3, intent: 'new', task: 'video-review', why: '带链接与四个问题的审片委托' },
      { turn: 4, intent: 'continue', of: 'video-review', why: '要求把结论回复到 issue' },
      { turn: 5, intent: 'continue', of: 'video-review', why: '新版视频再看一次' },
      { turn: 6, intent: 'continue', of: 'video-review', why: '发来 v3 附件' },
      { turn: 7, intent: 'continue', of: 'video-review', why: '要求给拍摄建议并写进 issue' },
      { turn: 8, intent: 'new', task: 'issue9', why: '另一个 issue 的独立复核' },
      { turn: 9, intent: 'continue', of: 'video-review', why: 'v4 附件：回到已完成的审片任务（resume）' },
      { turn: 10, intent: 'chitchat', why: '打招呼' },
      { turn: 11, intent: 'new', task: 'feicui', why: '全新话题：翡翠的英文' },
      { turn: 12, intent: 'continue', of: 'feicui', why: '补充家人坚持的说法，同一问题' },
      { turn: 13, intent: 'continue', of: 'feicui', why: '补一个字母 "e"，仍是同一问题' },
      { turn: 14, intent: 'chitchat', why: '能力询问（能否发声）' },
    ],
  },
]
