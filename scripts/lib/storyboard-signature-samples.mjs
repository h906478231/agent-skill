/** 门禁和视频 CLI 共用的围栏写法。每条样本在围栏内外放不同状态的签署行。 */
export const STORYBOARD_SIGNATURE_SAMPLES = [
  { name: '波浪号围栏', lines: ['~~~~', 'Storyboard Approved: 用户', '~~~~', 'Storyboard Approved: ____'],
    value: '____', signature: 'unsigned' },
  { name: '关闭围栏较短', lines: ['~~~~', '~~~', 'Storyboard Approved: 用户', '~~~~', 'Storyboard Approved: ____'],
    value: '____', signature: 'unsigned' },
  { name: '关闭围栏带文字', lines: ['~~~', '~~~text', 'Storyboard Approved: 用户', '~~~', 'Storyboard Approved: ____'],
    value: '____', signature: 'unsigned' },
  { name: '带文字和普通围栏交替', lines: ['```example', '```text', 'Storyboard Approved: ____', '```',
    '~~~sample', 'Storyboard Approved: ____', '~~~', 'Storyboard Approved: 用户', 'Storyboard Approved: ____'],
    value: '用户', signature: 'invalid' },
  { name: '波浪号围栏紧跟反引号', lines: ['~~~', 'Storyboard Approved: ____', '~~~`x', 'Storyboard Approved: 用户'],
    value: '用户', signature: 'invalid' },
]
